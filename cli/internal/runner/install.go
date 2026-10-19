package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/osintverse/otinstaller/cli/internal/manifest"
	"github.com/osintverse/otinstaller/cli/internal/state"
)

// TrustError means a verification check failed and ot refused to continue (exit code 4).
type TrustError struct{ Msg string }

func (e *TrustError) Error() string { return e.Msg }

// InstallOptions control how a package is installed.
type InstallOptions struct {
	// Native installs pipx packages on the host instead of in a container.
	Native bool
	// SignerIdentity is the cosign certificate identity the registry recorded at publish time.
	// Empty skips signature verification (local manifests during development).
	SignerIdentity string
	SignerIssuer   string
}

// Install pulls or builds everything a package needs and returns its state record.
func (r *Runner) Install(ctx context.Context, m *manifest.Manifest, rawManifest []byte, opt InstallOptions) (*state.Installed, error) {
	if m.IsGuide() {
		return nil, &UsageError{m.Ref() + " is a guide; use `ot guide get` to save it"}
	}
	inst := &state.Installed{
		Ref:         m.Ref(),
		Version:     m.Version,
		Runtime:     m.Runtime.Kind,
		InstalledAt: time.Now().UTC(),
		Manifest:    m,
		ManifestRaw: rawManifest,
	}
	switch m.Runtime.Kind {
	case "docker":
		if err := r.installDocker(ctx, m, opt); err != nil {
			return nil, err
		}
		inst.Artifact = m.Runtime.Image
	case "pipx":
		native := opt.Native || r.Engine == ""
		wheel, err := FetchWheel(ctx, m)
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(filepath.Dir(wheel))
		inst.Artifact = "sha256:" + m.Runtime.WheelSHA256
		inst.Native = native
		if native {
			err = r.installPipxNative(ctx, m, wheel)
		} else {
			inst.LocalImage, err = r.buildPythonImage(ctx, m, wheel)
		}
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unknown runtime %q", m.Runtime.Kind)
	}
	return inst, nil
}

func (r *Runner) installDocker(ctx context.Context, m *manifest.Manifest, opt InstallOptions) error {
	if err := r.requireEngine(); err != nil {
		return err
	}
	image := m.Runtime.Image
	if !strings.Contains(image, "@sha256:") {
		return &TrustError{"image " + image + " is not pinned by digest"}
	}
	if code, err := r.Exec.Run(ctx, r.Engine, []string{"pull", image}, nil, nil, r.Stderr, r.Stderr); err != nil || code != 0 {
		return fmt.Errorf("pulling %s failed (exit %d): %v", image, code, err)
	}
	if opt.SignerIdentity == "" {
		return nil
	}
	if _, err := r.Exec.LookPath("cosign"); err != nil {
		fmt.Fprintln(r.Stderr, "warning: cosign is not installed, so the image signature was not verified locally")
		return nil
	}
	args := []string{"verify", "--certificate-identity", opt.SignerIdentity, "--certificate-oidc-issuer", opt.SignerIssuer, image}
	if code, err := r.Exec.Run(ctx, "cosign", args, nil, nil, io.Discard, r.Stderr); err != nil || code != 0 {
		return &TrustError{"signature verification failed for " + image + "; refusing to install"}
	}
	return nil
}

// PipxHome and PipxBinDir keep ot's packages apart from the user's own pipx apps.
func PipxHome() string   { return state.Path("pipx") }
func PipxBinDir() string { return state.Path("bin") }

func pipxEnv() []string {
	return []string{"PIPX_HOME=" + PipxHome(), "PIPX_BIN_DIR=" + PipxBinDir()}
}

// FindPipx returns how to invoke pipx: the pipx command, or `python -m pipx` when pipx was
// installed with `pip install --user` and its scripts folder is not on PATH.
func FindPipx(ex Exec) (cmd string, prefix []string, ok bool) {
	if p, err := ex.LookPath("pipx"); err == nil {
		return p, nil, true
	}
	for _, py := range []string{"python3", "python", "py"} {
		p, err := ex.LookPath(py)
		if err != nil {
			continue
		}
		if code, err := ex.Run(context.Background(), p, []string{"-m", "pipx", "--version"}, nil, nil, io.Discard, io.Discard); err == nil && code == 0 {
			return p, []string{"-m", "pipx"}, true
		}
	}
	return "", nil, false
}

func (r *Runner) installPipxNative(ctx context.Context, m *manifest.Manifest, wheel string) error {
	pipx, prefix, ok := FindPipx(r.Exec)
	if !ok {
		return &RuntimeMissingError{"this package needs pipx (or Docker); install pipx with `python -m pip install --user pipx`"}
	}
	args := append(prefix, "install", "--force", wheel)
	if m.Runtime.Python != "" && !strings.ContainsAny(m.Runtime.Python, "<>=~!") {
		args = append(args, "--python", m.Runtime.Python)
	}
	code, err := r.Exec.Run(ctx, pipx, args, pipxEnv(), nil, r.Stderr, r.Stderr)
	if err != nil || code != 0 {
		return fmt.Errorf("pipx install failed (exit %d): %v", code, err)
	}
	return nil
}

// pythonDockerfile wraps a verified wheel in a small non-root image so pipx packages run with the
// same sandbox as Docker packages.
const pythonDockerfile = `FROM python:3.12-slim
RUN useradd --uid 10001 --create-home ot
COPY *.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm /tmp/*.whl
USER ot
`

func (r *Runner) buildPythonImage(ctx context.Context, m *manifest.Manifest, wheel string) (string, error) {
	dir := filepath.Dir(wheel)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(pythonDockerfile), 0o644); err != nil {
		return "", err
	}
	tag := LocalImageName(m)
	code, err := r.Exec.Run(ctx, r.Engine, []string{"build", "--pull", "-t", tag, dir}, nil, nil, r.Stderr, r.Stderr)
	if err != nil || code != 0 {
		return "", fmt.Errorf("building the sandbox image failed (exit %d): %v", code, err)
	}
	return tag, nil
}

// PyPIBase can be overridden in tests.
var PyPIBase = "https://pypi.org"

// FetchWheel downloads the wheel whose SHA-256 matches the manifest and verifies it.
func FetchWheel(ctx context.Context, m *manifest.Manifest) (string, error) {
	rt := m.Runtime
	url := fmt.Sprintf("%s/pypi/%s/%s/json", PyPIBase, rt.Package, rt.PackageVersion)
	var meta struct {
		URLs []struct {
			Filename    string            `json:"filename"`
			URL         string            `json:"url"`
			PackageType string            `json:"packagetype"`
			Digests     map[string]string `json:"digests"`
		} `json:"urls"`
	}
	if err := getJSON(ctx, url, &meta); err != nil {
		return "", fmt.Errorf("looking up %s %s on PyPI: %w", rt.Package, rt.PackageVersion, err)
	}
	for _, u := range meta.URLs {
		if u.PackageType != "bdist_wheel" || u.Digests["sha256"] != rt.WheelSHA256 {
			continue
		}
		dir, err := os.MkdirTemp("", "ot-wheel-")
		if err != nil {
			return "", err
		}
		path := filepath.Join(dir, filepath.Base(u.Filename))
		if err := download(ctx, u.URL, path, rt.WheelSHA256); err != nil {
			os.RemoveAll(dir)
			return "", err
		}
		return path, nil
	}
	return "", &TrustError{fmt.Sprintf("no wheel for %s %s matches the manifest's sha256; refusing to install", rt.Package, rt.PackageVersion)}
}

var httpClient = &http.Client{Timeout: 5 * time.Minute}

func getJSON(ctx context.Context, url string, v any) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %s", url, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func download(ctx context.Context, url, path, wantSHA string) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading %s: %s", url, resp.Status)
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSHA {
		return &TrustError{fmt.Sprintf("downloaded wheel hash %s does not match the manifest (%s)", got, wantSHA)}
	}
	return nil
}

// Uninstall removes a package's local artifacts.
func (r *Runner) Uninstall(ctx context.Context, inst *state.Installed) error {
	switch {
	case inst.Runtime == "pipx" && inst.Native:
		if pipx, prefix, ok := FindPipx(r.Exec); ok {
			_, _ = r.Exec.Run(ctx, pipx, append(prefix, "uninstall", inst.Manifest.Runtime.Package), pipxEnv(), nil, io.Discard, r.Stderr)
		}
	case r.Engine != "":
		image := inst.Artifact
		if inst.LocalImage != "" {
			image = inst.LocalImage
		}
		_, _ = r.Exec.Run(ctx, r.Engine, []string{"rmi", image}, nil, nil, io.Discard, io.Discard)
	}
	return nil
}
