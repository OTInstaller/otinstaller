package runner

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/state"
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
	// MirrorImage is the same digest on the registry's mirror (mirror.otinstaller.com/<ns>/<name>@sha256:...),
	// tried when the original registry refuses the pull. WheelBackupURL is the registry's copy of the wheel.
	MirrorImage    string
	WheelBackupURL string
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
		pulled, verified, err := r.installDocker(ctx, m, opt)
		if err != nil {
			return nil, err
		}
		inst.Artifact = m.Runtime.Image
		if verified {
			inst.Signer = opt.SignerIdentity
		}
		if pulled != m.Runtime.Image {
			// Runs use the mirror's reference: the image is stored locally under that name.
			inst.LocalImage = pulled
			inst.FromBackup = true
		}
	case "pipx":
		native := opt.Native || r.Engine == ""
		wheel, fromBackup, err := FetchWheelWithBackup(ctx, m, opt.WheelBackupURL, r.Stderr)
		inst.FromBackup = fromBackup
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

// unavailable matches what docker and podman print when a registry refuses an image (a banned or deleted
// repository): 401/403/404, "denied", "unauthorized", "not found", "manifest unknown", or the daemon's "error from
// registry: <message>", which hides the status code. Network errors (DNS, refused connections, timeouts) do not match.
var unavailable = regexp.MustCompile(`(?i)\b(denied|forbidden|unauthorized|not found|manifest unknown|name unknown|error from registry|40[134])\b`)

// sameDigest reports whether the mirror reference pins the same digest as the original.
func sameDigest(original, mirror string) bool {
	_, a, ok1 := strings.Cut(original, "@")
	_, b, ok2 := strings.Cut(mirror, "@")
	return ok1 && ok2 && a == b
}

// installDocker pulls the image by digest and verifies its signature. If the original registry refuses the
// image, it pulls the same digest from the mirror and verifies the same signature there. It returns the
// reference that was pulled and whether its signature was verified.
func (r *Runner) installDocker(ctx context.Context, m *manifest.Manifest, opt InstallOptions) (string, bool, error) {
	if err := r.requireEngine(); err != nil {
		return "", false, err
	}
	image := m.Runtime.Image
	if !strings.Contains(image, "@sha256:") {
		return "", false, &TrustError{"image " + image + " is not pinned by digest"}
	}
	var out bytes.Buffer
	code, err := r.Exec.Run(ctx, r.Engine, []string{"pull", image}, nil, nil, r.Stderr, io.MultiWriter(r.Stderr, &out))
	if err != nil || code != 0 {
		if opt.MirrorImage == "" || !sameDigest(image, opt.MirrorImage) || !unavailable.MatchString(out.String()) {
			return "", false, fmt.Errorf("pulling %s failed (exit %d): %v", image, code, err)
		}
		fmt.Fprintf(r.Stderr, "note: %s refused the image; pulling the same digest from the OTInstaller mirror\n", strings.SplitN(image, "/", 2)[0])
		image = opt.MirrorImage
		if code, err := r.Exec.Run(ctx, r.Engine, []string{"pull", image}, nil, nil, r.Stderr, r.Stderr); err != nil || code != 0 {
			return "", false, fmt.Errorf("pulling %s from the mirror failed too (exit %d): %v", image, code, err)
		}
	}
	if opt.SignerIdentity == "" {
		return image, false, nil
	}
	if _, err := r.Exec.LookPath("cosign"); err != nil {
		fmt.Fprintln(r.Stderr, "warning: cosign is not installed, so the image signature was not verified locally")
		return image, false, nil
	}
	args := []string{"verify", "--certificate-identity", opt.SignerIdentity, "--certificate-oidc-issuer", opt.SignerIssuer, image}
	if code, err := r.Exec.Run(ctx, "cosign", args, nil, nil, io.Discard, r.Stderr); err != nil || code != 0 {
		return "", false, &TrustError{"signature verification failed for " + image + "; refusing to install"}
	}
	return image, true, nil
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
// same sandbox as Docker packages. The container is read-only except /tmp, so tools that write
// into their working folder (reports, caches) start there.
const pythonDockerfile = `FROM python:3.12-slim
RUN useradd --uid 10001 --create-home ot
COPY *.whl /tmp/
RUN pip install --no-cache-dir /tmp/*.whl && rm /tmp/*.whl
USER ot
WORKDIR /tmp
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

// statusError is an HTTP answer other than 200.
type statusError struct {
	URL  string
	Code int
}

func (e *statusError) Error() string {
	return fmt.Sprintf("%s returned %d %s", e.URL, e.Code, http.StatusText(e.Code))
}

// gone means PyPI refused or no longer has the wheel (403, 404, 410), or has no file with the manifest's hash.
func gone(err error) bool {
	var se *statusError
	if errors.As(err, &se) {
		return se.Code == http.StatusForbidden || se.Code == http.StatusNotFound || se.Code == http.StatusGone
	}
	var te *TrustError
	return errors.As(err, &te) && strings.HasPrefix(te.Msg, "no wheel for")
}

// FetchWheelWithBackup is FetchWheel, falling back to the registry's copy of the wheel when PyPI no longer
// serves it. The copy is checked against the same SHA-256. It reports whether the backup was used.
func FetchWheelWithBackup(ctx context.Context, m *manifest.Manifest, backupURL string, stderr io.Writer) (string, bool, error) {
	wheel, err := FetchWheel(ctx, m)
	if err == nil || backupURL == "" || !gone(err) {
		return wheel, false, err
	}
	name := path.Base(backupURL)
	if !strings.HasSuffix(name, ".whl") || strings.ContainsAny(name, `\/:`) {
		return "", false, err
	}
	fmt.Fprintf(stderr, "note: PyPI no longer serves this wheel (%v); using the registry's backup copy\n", err)
	dir, derr := os.MkdirTemp("", "ot-wheel-")
	if derr != nil {
		return "", false, derr
	}
	p := filepath.Join(dir, name)
	if derr := download(ctx, backupURL, p, m.Runtime.WheelSHA256); derr != nil {
		os.RemoveAll(dir)
		return "", false, derr
	}
	return p, true, nil
}

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
		return &statusError{url, resp.StatusCode}
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
		return &statusError{url, resp.StatusCode}
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
