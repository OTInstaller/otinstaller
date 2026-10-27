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
	"runtime"
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
	// RequireSignature refuses a Docker image without a recorded signer, or when cosign is missing, instead of
	// warning. Installs an AI agent asks for use it.
	RequireSignature bool
	// SandboxImage is the image the registry's scanner built from a pipx package's wheel (on the mirror, by digest),
	// signed by SandboxSignerIdentity. When it can be used, ot pulls it instead of downloading the wheel and building.
	SandboxImage          string
	SandboxSignerIdentity string
	SandboxSignerIssuer   string
	// PythonLock is the wheel's dependencies as the scanner resolved them (name==version with every file's sha256),
	// which a local build installs instead of resolving them again.
	PythonLock string
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
		inst.Artifact = "sha256:" + m.Runtime.WheelSHA256
		if !native {
			image, err := r.pullSandbox(ctx, opt)
			if err != nil {
				return nil, err
			}
			if image != "" {
				inst.LocalImage = image
				return inst, nil
			}
		}
		wheel, fromBackup, err := FetchWheelWithBackup(ctx, m, opt.WheelBackupURL, r.Stderr)
		inst.FromBackup = fromBackup
		if err != nil {
			return nil, err
		}
		defer os.RemoveAll(filepath.Dir(wheel))
		inst.Native = native
		if native {
			err = r.installPipxNative(ctx, m, wheel)
		} else {
			inst.LocalImage, err = r.buildPythonImage(ctx, m, wheel, r.pythonLock(opt.PythonLock))
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

// engineDown matches what docker and podman print when the engine is installed but not running.
var engineDown = regexp.MustCompile(`(?i)(cannot connect to the docker daemon|failed to connect to the docker api|is the docker daemon running|error during connect|cannot connect to podman)`)

// commandFailed describes a failed docker, podman or pipx command. When the output shows the container engine isn't
// running it says so (exit code 5), since every install would fail the same way.
func commandFailed(what string, code int, err error, output string) error {
	if engineDown.MatchString(output) {
		return &RuntimeMissingError{"Docker is installed but not running; start Docker Desktop (or Podman) and try again"}
	}
	if err != nil {
		return fmt.Errorf("%s failed (exit %d): %v", what, code, err)
	}
	return fmt.Errorf("%s failed (exit %d)", what, code)
}

// FailureReason is why an install failed, in the words install counts use: no_engine, pull_failed (the image or wheel
// couldn't be downloaded), verify_failed (a signature or hash didn't match), build_failed (the sandbox image or the
// pipx install), refused (an image not pinned by digest, or one an agent can't verify) or error. It reads the errors
// this file makes, so a new one belongs here too.
func FailureReason(err error) string {
	var missing *RuntimeMissingError
	var trust *TrustError
	var status *statusError
	switch {
	case errors.As(err, &missing):
		return "no_engine"
	case errors.As(err, &trust):
		for _, p := range []string{"signature verification failed", "no wheel for", "downloaded wheel hash"} {
			if strings.HasPrefix(trust.Msg, p) {
				return "verify_failed"
			}
		}
		return "refused"
	case errors.As(err, &status):
		return "pull_failed"
	case err == nil:
		return "error"
	}
	msg := err.Error()
	switch {
	case strings.HasPrefix(msg, "pulling "), strings.HasPrefix(msg, "looking up "):
		return "pull_failed"
	case strings.HasPrefix(msg, "building the sandbox image"), strings.HasPrefix(msg, "pipx install"):
		return "build_failed"
	}
	return "error"
}

// sameDigest reports whether the mirror reference pins the same digest as the original.
func sameDigest(original, mirror string) bool {
	_, a, ok1 := strings.Cut(original, "@")
	_, b, ok2 := strings.Cut(mirror, "@")
	return ok1 && ok2 && a == b
}

// installDocker pulls the image by digest and verifies its signature at the same time (cosign reads the signature
// from the registry, not from the pulled copy). If the original registry refuses the image, it pulls the same digest
// from the mirror and verifies the same signature there. It returns the reference that was pulled and whether its
// signature was verified.
func (r *Runner) installDocker(ctx context.Context, m *manifest.Manifest, opt InstallOptions) (string, bool, error) {
	if err := r.requireEngine(); err != nil {
		return "", false, err
	}
	image := m.Runtime.Image
	if !strings.Contains(image, "@sha256:") {
		return "", false, &TrustError{"image " + image + " is not pinned by digest"}
	}
	// What an agent may not install is refused before anything is downloaded.
	if opt.SignerIdentity == "" && opt.RequireSignature {
		return "", false, &TrustError{image + " is not signed, and agents may only install signed images; install it yourself with `ot install` if you trust it"}
	}
	verify := r.verifyArgs(opt.SignerIdentity, opt.SignerIssuer)
	if opt.SignerIdentity != "" && verify == nil && opt.RequireSignature {
		return "", false, &TrustError{"cosign is not installed, so the signature of " + image + " can't be verified; agents may only install verified images (install cosign: https://docs.sigstore.dev/cosign/system_config/installation/)"}
	}
	res := r.pullVerified(ctx, image, verify)
	if res.err != nil || res.code != 0 {
		if opt.MirrorImage == "" || !sameDigest(image, opt.MirrorImage) || !unavailable.MatchString(res.out) {
			return "", false, commandFailed("pulling "+image, res.code, res.err, res.out)
		}
		fmt.Fprintf(r.Stderr, "note: %s refused the image; pulling the same digest from the OTInstaller mirror\n", strings.SplitN(image, "/", 2)[0])
		image = opt.MirrorImage
		if res = r.pullVerified(ctx, image, verify); res.err != nil || res.code != 0 {
			return "", false, commandFailed("pulling "+image+" from the mirror", res.code, res.err, res.out)
		}
	}
	fmt.Fprintf(r.Stderr, "pulled %s\n", shortImage(image))
	if opt.SignerIdentity == "" {
		return image, false, nil
	}
	if verify == nil {
		fmt.Fprintln(r.Stderr, "warning: cosign is not installed, so the image signature was not verified locally")
		return image, false, nil
	}
	if !res.verified {
		fmt.Fprint(r.Stderr, res.verifyOut)
		return "", false, &TrustError{"signature verification failed for " + image + "; refusing to install"}
	}
	fmt.Fprintf(r.Stderr, "signature verified: signed by %s\n", opt.SignerIdentity)
	return image, true, nil
}

// verifyArgs is the cosign command that checks an image was signed by identity (the image goes last), or nil when
// there is no signer to check against or cosign isn't installed.
func (r *Runner) verifyArgs(identity, issuer string) []string {
	if identity == "" {
		return nil
	}
	if _, err := r.Exec.LookPath("cosign"); err != nil {
		return nil
	}
	return []string{"verify", "--certificate-identity", identity, "--certificate-oidc-issuer", issuer}
}

// pulled is how a pull went and, when cosign ran, whether it verified the image.
type pulled struct {
	code      int
	err       error
	out       string
	verified  bool
	verifyOut string
}

// pullVerified pulls image and, given verify (from verifyArgs), runs cosign on it at the same time. The engine's
// progress lines go to a buffer: a first run should read as three lines, not a screen of layer hashes. On failure
// the buffer is the error.
func (r *Runner) pullVerified(ctx context.Context, image string, verify []string) pulled {
	var res pulled
	vctx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan struct{})
	if verify == nil {
		close(done)
	} else {
		go func() {
			defer close(done)
			var buf bytes.Buffer
			code, err := r.Exec.Run(vctx, "cosign", append(append([]string{}, verify...), image), nil, nil, &buf, &buf)
			res.verified, res.verifyOut = err == nil && code == 0, buf.String()
		}()
	}
	var out bytes.Buffer
	res.code, res.err = r.Exec.Run(ctx, r.Engine, []string{"pull", image}, nil, nil, &out, &out)
	res.out = out.String()
	if res.err != nil || res.code != 0 {
		cancel() // the verdict on an image that didn't arrive doesn't matter
	}
	<-done
	return res
}

// sandboxArch is the platform the scanner builds sandbox images for; on any other ot builds the image itself.
const sandboxArch = "amd64"

// hostArch can be overridden in tests.
var hostArch = runtime.GOARCH

// pullSandbox pulls the sandbox image the registry built for a pipx package and checks the registry's scanner signed
// it. It returns "" when ot should build the image itself: no sandbox image, another platform, an agent's install
// without cosign (agents use verified images only, and the local build checks the wheel's hash), or a pull that
// failed. A signature that doesn't verify refuses the install.
func (r *Runner) pullSandbox(ctx context.Context, opt InstallOptions) (string, error) {
	if opt.SandboxImage == "" || hostArch != sandboxArch || !strings.Contains(opt.SandboxImage, "@sha256:") {
		return "", nil
	}
	if err := r.requireEngine(); err != nil {
		return "", err
	}
	verify := r.verifyArgs(opt.SandboxSignerIdentity, opt.SandboxSignerIssuer)
	if verify == nil && opt.RequireSignature {
		return "", nil
	}
	res := r.pullVerified(ctx, opt.SandboxImage, verify)
	if res.err != nil || res.code != 0 {
		err := commandFailed("pulling the sandbox image", res.code, res.err, res.out)
		var missing *RuntimeMissingError
		if errors.As(err, &missing) {
			return "", err
		}
		fmt.Fprintf(r.Stderr, "note: couldn't pull the registry's sandbox image (%s); building it locally\n", lastLine(res.out))
		return "", nil
	}
	if verify != nil && !res.verified {
		fmt.Fprint(r.Stderr, res.verifyOut)
		return "", &TrustError{"signature verification failed for the sandbox image " + opt.SandboxImage + "; refusing to install"}
	}
	fmt.Fprintf(r.Stderr, "pulled %s (built and scanned by the registry)\n", shortImage(opt.SandboxImage))
	return opt.SandboxImage, nil
}

// lastLine is the last non-empty line of a command's output.
func lastLine(out string) string {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

// shortImage is the image name with its digest cut to twelve hex characters, for progress lines.
func shortImage(image string) string {
	if i := strings.Index(image, "@sha256:"); i >= 0 && len(image) > i+8+12 {
		return image[:i+8+12] + "…"
	}
	return image
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
		return commandFailed("pipx install", code, err, "")
	}
	return nil
}

// pythonDockerfile wraps a verified wheel in a small non-root image so pipx packages run with the
// same sandbox as Docker packages. The container is read-only except /tmp, so tools that write
// into their working folder (reports, caches) start there. The base is pinned by digest (the index, so
// arm64 builds too), and with a requirements.lock the dependencies are exactly the ones the scanner
// resolved and scanned, checked by hash, with nothing resolved again; an empty lock resolves them as
// before. ops/scanner/scan.py builds the same file (test_scan.py keeps the two equal).
const pythonDockerfile = `FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
RUN useradd --uid 10001 --create-home ot
COPY *.whl requirements.lock /tmp/
RUN if [ -s /tmp/requirements.lock ]; then pip install --no-cache-dir --no-deps --require-hashes -r /tmp/requirements.lock && pip install --no-cache-dir --no-deps /tmp/*.whl; else pip install --no-cache-dir /tmp/*.whl; fi && rm /tmp/*.whl /tmp/requirements.lock
USER ot
WORKDIR /tmp
`

// lockLine is one line of a dependency lock: a pinned package and the sha256 of each of its files on PyPI. Nothing
// else (no options, URLs or editable installs) is accepted.
var lockLine = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*==[A-Za-z0-9._+!-]+( --hash=sha256:[0-9a-f]{64})+$`)

// pythonLock is the registry's dependency lock when every line is a pinned, hashed package, else "" (a local build
// then resolves the dependencies itself).
func (r *Runner) pythonLock(lock string) string {
	lock = strings.TrimSpace(strings.ReplaceAll(lock, "\r\n", "\n"))
	if lock == "" {
		return ""
	}
	for _, l := range strings.Split(lock, "\n") {
		if !lockLine.MatchString(l) {
			fmt.Fprintln(r.Stderr, "note: the registry's dependency lock for this package can't be used; resolving dependencies instead")
			return ""
		}
	}
	return lock + "\n"
}

func (r *Runner) buildPythonImage(ctx context.Context, m *manifest.Manifest, wheel, lock string) (string, error) {
	dir := filepath.Dir(wheel)
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(pythonDockerfile), 0o644); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(dir, "requirements.lock"), []byte(lock), 0o644); err != nil {
		return "", err
	}
	tag := LocalImageName(m)
	var out bytes.Buffer
	// No --pull: the base is pinned by digest, so a cached copy is the same image.
	code, err := r.Exec.Run(ctx, r.Engine, []string{"build", "-t", tag, dir}, nil, nil, r.Stderr, io.MultiWriter(r.Stderr, &out))
	if err != nil || code != 0 {
		return "", commandFailed("building the sandbox image", code, err, out.String())
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
