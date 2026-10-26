package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

func load(t *testing.T, name string) *manifest.Manifest {
	t.Helper()
	_, m, err := manifest.LoadFile(filepath.Join("../../../spec/fixtures/valid", name))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func TestBuildCommand(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	got := BuildCommand(m, map[string]string{"email": "a@b.com", "timeout": "10"})
	want := []string{"holehe", "--json", "--timeout", "10", "a@b.com"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	// An omitted optional input drops its flag too.
	got = BuildCommand(m, map[string]string{"email": "a@b.com"})
	want = []string{"holehe", "--json", "a@b.com"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestBuildCommandDoesNotReexpand(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	got := BuildCommand(m, map[string]string{"email": "{timeout}", "timeout": "5"})
	if got[len(got)-1] != "{timeout}" {
		t.Fatalf("a value containing a placeholder was expanded: %v", got)
	}
}

func TestResolveInputs(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	v, err := ResolveInputs(m, map[string]string{"email": "a@b.com"})
	if err != nil || v["timeout"] != "10" {
		t.Fatalf("default not applied: %v %v", v, err)
	}
	cases := []map[string]string{
		{},                                      // missing required
		{"email": "not-an-email"},               // bad email
		{"email": "a@b.com", "timeout": "soon"}, // bad integer
		{"email": "a@b.com", "unknown": "x"},    // unknown input
	}
	for _, c := range cases {
		if _, err := ResolveInputs(m, c); err == nil {
			t.Errorf("expected an error for %v", c)
		} else if _, ok := err.(*UsageError); !ok {
			t.Errorf("expected UsageError, got %T", err)
		}
	}
	p := load(t, "pipx-tool.yaml")
	if _, err := ResolveInputs(p, map[string]string{"phone": "+1", "region": "FR"}); err == nil {
		t.Error("expected enum error")
	}
}

func TestContainerArgsSandbox(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	args := ContainerArgs(m, "ot-x", m.Runtime.Image, []string{"holehe", "a@b.com"}, []string{"HIBP_API_KEY"}, "")
	joined := strings.Join(args, " ")
	for _, want := range []string{"--rm", "--read-only", "--cap-drop ALL", "no-new-privileges", "--pids-limit 256", "--memory 1g", "--user 65534:65534", "-e HIBP_API_KEY", "--entrypoint holehe"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in %s", want, joined)
		}
	}
	if strings.Contains(joined, "HIBP_API_KEY=") {
		t.Error("secret value must not appear in docker arguments")
	}
	if strings.Contains(joined, "--network none") {
		t.Error("tool declares egress; network must stay on")
	}
	f := false
	m.Network.Egress = &f
	if !strings.Contains(strings.Join(ContainerArgs(m, "ot-x", "img", []string{"x"}, nil, ""), " "), "--network none") {
		t.Error("egress: false must disable the network")
	}
	m.Network = &manifest.Network{}
	if !strings.Contains(strings.Join(ContainerArgs(m, "ot-x", "img", []string{"x"}, nil, ""), " "), "--network none") {
		t.Error("a network block without egress must disable the network")
	}
	m.Network = nil
	if !strings.Contains(strings.Join(ContainerArgs(m, "ot-x", "img", []string{"x"}, nil, ""), " "), "--network none") {
		t.Error("a manifest without a network block must disable the network")
	}
}

// fakeExec records calls and prints canned output for `docker run`. Pulls and cosign run at the same time, hence
// the lock. For `docker build` it keeps the files of the build folder (the folder is gone after the install).
type fakeExec struct {
	mu         sync.Mutex
	calls      [][]string
	stdout     string
	code       int
	env        []string
	paths      map[string]bool
	buildFiles map[string]string
}

func (f *fakeExec) LookPath(name string) (string, error) {
	if f.paths[name] {
		return name, nil
	}
	return "", fmt.Errorf("not found")
}

// called reports whether a call starts with these words (the command, then its arguments).
func (f *fakeExec) called(words ...string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.calls {
		if len(c) >= len(words) && reflect.DeepEqual(c[:len(words)], words) {
			return true
		}
	}
	return false
}

func (f *fakeExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, append([]string{name}, args...))
	if len(args) > 0 && args[0] == "build" {
		f.buildFiles = map[string]string{}
		entries, _ := os.ReadDir(args[len(args)-1])
		for _, e := range entries {
			b, _ := os.ReadFile(filepath.Join(args[len(args)-1], e.Name()))
			f.buildFiles[e.Name()] = string(b)
		}
	}
	if len(args) > 0 && args[0] == "run" {
		f.env = env
		io.WriteString(stdout, f.stdout)
		return f.code, nil
	}
	return 0, nil
}

func TestInstallAndRunDocker(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	m := load(t, "docker-tool.yaml")
	fx := &fakeExec{paths: map[string]bool{"docker": true}, stdout: `{"entities":[{"type":"account","value":"github.com/abc","source":"github"}]}`}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}

	inst, err := r.Install(context.Background(), m, nil, InstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if fx.calls[0][1] != "pull" || fx.calls[0][2] != m.Runtime.Image {
		t.Fatalf("expected a pull by digest, got %v", fx.calls[0])
	}
	env, err := r.Run(context.Background(), inst, RunOptions{
		Values:  map[string]string{"email": "a@b.com", "timeout": "10"},
		Secrets: map[string]string{"HIBP_API_KEY": "s3cret"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if env.Tool != "dheeraj/holehe-lite@1.2.0" || len(env.Entities) != 1 || env.Entities[0].Value != "github.com/abc" {
		t.Fatalf("unexpected envelope: %+v", env)
	}
	if !reflect.DeepEqual(fx.env, []string{"HIBP_API_KEY=s3cret"}) {
		t.Fatalf("secret should be passed through the environment only, got %v", fx.env)
	}
}

func TestInstallWithoutEngine(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	r := &Runner{Exec: &fakeExec{}, Stderr: io.Discard}
	_, err := r.Install(context.Background(), m, nil, InstallOptions{})
	if _, ok := err.(*RuntimeMissingError); !ok {
		t.Fatalf("expected RuntimeMissingError, got %v", err)
	}
}

func TestSignatureFailureRefuses(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	fx := &failingCosign{fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	_, err := r.Install(context.Background(), m, nil, InstallOptions{SignerIdentity: "https://github.com/dheeraj/holehe-lite/.github/workflows/release.yml@refs/tags/v1.2.0", SignerIssuer: "https://token.actions.githubusercontent.com"})
	if _, ok := err.(*TrustError); !ok {
		t.Fatalf("expected TrustError, got %v", err)
	}
}

type failingCosign struct{ fakeExec }

func (f *failingCosign) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if name == "cosign" {
		return 1, nil
	}
	return f.fakeExec.Run(ctx, name, args, env, stdin, stdout, stderr)
}

func TestFetchWheelVerifiesHash(t *testing.T) {
	wheel := []byte("fake wheel contents")
	sum := sha256.Sum256(wheel)
	good := hex.EncodeToString(sum[:])
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/pypi/phone-parse/0.3.1/json":
			fmt.Fprintf(w, `{"urls":[{"filename":"phone_parse-0.3.1-py3-none-any.whl","url":"%s/f.whl","packagetype":"bdist_wheel","digests":{"sha256":"%s"}}]}`, srv.URL, good)
		case "/f.whl":
			w.Write(wheel)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	old := PyPIBase
	PyPIBase = srv.URL
	defer func() { PyPIBase = old }()

	m := load(t, "pipx-tool.yaml")
	m.Runtime.WheelSHA256 = good
	path, err := FetchWheel(context.Background(), m)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "phone_parse-0.3.1-py3-none-any.whl" {
		t.Fatalf("unexpected path %s", path)
	}
	m.Runtime.WheelSHA256 = strings.Repeat("0", 64)
	if _, err := FetchWheel(context.Background(), m); err == nil {
		t.Fatal("expected a TrustError for a hash with no matching wheel")
	} else if _, ok := err.(*TrustError); !ok {
		t.Fatalf("expected TrustError, got %T", err)
	}
}

// pipxPackage serves the pipx fixture's wheel as PyPI would and counts the requests, so a test can tell whether
// the wheel was downloaded.
func pipxPackage(t *testing.T) (*manifest.Manifest, *atomic.Int32) {
	t.Helper()
	t.Setenv("OT_HOME", t.TempDir())
	wheel := []byte("w")
	sum := sha256.Sum256(wheel)
	var hits atomic.Int32
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if strings.HasSuffix(r.URL.Path, "/json") {
			fmt.Fprintf(w, `{"urls":[{"filename":"p-0.3.1-py3-none-any.whl","url":"%s/w","packagetype":"bdist_wheel","digests":{"sha256":"%x"}}]}`, srv.URL, sum)
			return
		}
		w.Write(wheel)
	}))
	t.Cleanup(srv.Close)
	old := PyPIBase
	PyPIBase = srv.URL
	t.Cleanup(func() { PyPIBase = old })
	m := load(t, "pipx-tool.yaml")
	m.Runtime.WheelSHA256 = hex.EncodeToString(sum[:])
	return m, &hits
}

func TestPipxSandboxedBuildsLocalImage(t *testing.T) {
	m, _ := pipxPackage(t)
	fx := &fakeExec{paths: map[string]bool{"docker": true}}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	inst, err := r.Install(context.Background(), m, nil, InstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if inst.Native || inst.LocalImage != "ot-local/osintverse-phone-parse:0.3.1" {
		t.Fatalf("expected a sandboxed local image, got %+v", inst)
	}
	// The base is pinned by digest, so the build never asks the registry for a newer one.
	if fx.calls[0][1] != "build" || strings.Contains(strings.Join(fx.calls[0], " "), "--pull") {
		t.Fatalf("expected docker build without --pull, got %v", fx.calls[0])
	}
	if !strings.HasPrefix(fx.buildFiles["Dockerfile"], "FROM python:3.12-slim@sha256:") {
		t.Fatalf("expected a base pinned by digest, got %q", fx.buildFiles["Dockerfile"])
	}
	// Without a lock from the registry, the lock file is empty and pip resolves the dependencies.
	if lock, ok := fx.buildFiles["requirements.lock"]; !ok || lock != "" {
		t.Fatalf("expected an empty requirements.lock, got %q (present: %v)", lock, ok)
	}
}

const goodLock = "phonenumbers==8.13.40 --hash=sha256:" + "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12" +
	" --hash=sha256:" + "cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34cd34" + "\n" +
	"requests==2.32.3 --hash=sha256:" + "ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56ef56"

func TestPipxLocalBuildInstallsTheRegistrysLock(t *testing.T) {
	m, _ := pipxPackage(t)
	fx := &fakeExec{paths: map[string]bool{"docker": true}}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	if _, err := r.Install(context.Background(), m, nil, InstallOptions{PythonLock: goodLock}); err != nil {
		t.Fatal(err)
	}
	if fx.buildFiles["requirements.lock"] != goodLock+"\n" {
		t.Fatalf("expected the registry's lock, got %q", fx.buildFiles["requirements.lock"])
	}
	if !strings.Contains(fx.buildFiles["Dockerfile"], "--require-hashes -r /tmp/requirements.lock") {
		t.Fatalf("expected the Dockerfile to install the lock by hash, got %q", fx.buildFiles["Dockerfile"])
	}
}

func TestPythonLockRefusesAnythingButPinnedHashedPackages(t *testing.T) {
	r := &Runner{Stderr: io.Discard}
	for _, bad := range []string{
		"requests==2.32.3", // no hash
		"--index-url https://evil.example/simple\n" + goodLock, // an option
		"requests>=2 --hash=sha256:" + strings.Repeat("a", 64), // not pinned
		"-e git+https://example.com/x.git#egg=x",
		"https://example.com/x.whl --hash=sha256:" + strings.Repeat("a", 64),
	} {
		if got := r.pythonLock(bad); got != "" {
			t.Errorf("expected %q to be refused, got %q", bad, got)
		}
	}
	if got := r.pythonLock(strings.ReplaceAll(goodLock, "\n", "\r\n")); got != goodLock+"\n" {
		t.Errorf("expected the lock with LF endings, got %q", got)
	}
}

const (
	sandboxImage  = "mirror.otinstaller.com/osintverse/phone-parse@sha256:1111111111111111111111111111111111111111111111111111111111111111"
	sandboxSigner = "https://github.com/OTInstaller/registry-ops/.github/workflows/scan.yml@refs/heads/main"
	githubIssuer  = "https://token.actions.githubusercontent.com"
)

func sandboxOptions() InstallOptions {
	return InstallOptions{SandboxImage: sandboxImage, SandboxSignerIdentity: sandboxSigner, SandboxSignerIssuer: githubIssuer, PythonLock: goodLock}
}

func onArch(t *testing.T, arch string) {
	old := hostArch
	hostArch = arch
	t.Cleanup(func() { hostArch = old })
}

func TestPipxPullsTheRegistrysSandboxImage(t *testing.T) {
	onArch(t, "amd64")
	m, hits := pipxPackage(t)
	fx := &fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	inst, err := r.Install(context.Background(), m, nil, sandboxOptions())
	if err != nil {
		t.Fatal(err)
	}
	if inst.LocalImage != sandboxImage || inst.Native || inst.Artifact != "sha256:"+m.Runtime.WheelSHA256 {
		t.Fatalf("expected the sandbox image, got %+v", inst)
	}
	if !fx.called("docker", "pull", sandboxImage) || !fx.called("cosign", "verify", "--certificate-identity", sandboxSigner, "--certificate-oidc-issuer", githubIssuer, sandboxImage) {
		t.Fatalf("expected a pull and a cosign check of the sandbox image, got %v", fx.calls)
	}
	if fx.called("docker", "build") || hits.Load() != 0 {
		t.Fatalf("expected no wheel download and no build, got %d requests and %v", hits.Load(), fx.calls)
	}
}

func TestPipxSandboxImageWithABadSignatureIsRefused(t *testing.T) {
	onArch(t, "amd64")
	m, _ := pipxPackage(t)
	fx := &failingCosign{fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	if _, err := r.Install(context.Background(), m, nil, sandboxOptions()); err == nil {
		t.Fatal("expected a TrustError")
	} else if _, ok := err.(*TrustError); !ok {
		t.Fatalf("expected TrustError, got %v", err)
	}
}

func TestPipxBuildsLocallyWhenTheSandboxImageCantBeUsed(t *testing.T) {
	cases := map[string]struct {
		arch string
		exec Exec
		opt  func(o *InstallOptions)
	}{
		"another platform":     {"arm64", &fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}, nil},
		"agent without cosign": {"amd64", &fakeExec{paths: map[string]bool{"docker": true}}, func(o *InstallOptions) { o.RequireSignature = true }},
		"pull failed":          {"amd64", &registryExec{fakeExec: fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}, refused: map[string]string{sandboxImage: "Error response from daemon: manifest unknown"}, signed: map[string]bool{sandboxImage: true}}, nil},
		"no sandbox image":     {"amd64", &fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}, func(o *InstallOptions) { o.SandboxImage = "" }},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			onArch(t, c.arch)
			m, _ := pipxPackage(t)
			opt := sandboxOptions()
			if c.opt != nil {
				c.opt(&opt)
			}
			r := &Runner{Exec: c.exec, Stderr: io.Discard, Engine: "docker"}
			inst, err := r.Install(context.Background(), m, nil, opt)
			if err != nil {
				t.Fatal(err)
			}
			if inst.LocalImage != "ot-local/osintverse-phone-parse:0.3.1" {
				t.Fatalf("expected a local build, got %+v", inst)
			}
		})
	}
}

func TestDockerPullAndSignatureCheckRunTogether(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	started := make(chan struct{})
	fx := &blockingPull{fakeExec: fakeExec{paths: map[string]bool{"docker": true, "cosign": true}}, cosignStarted: started}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	// The pull waits until cosign has started; run one after the other, this would never finish.
	if _, err := r.Install(context.Background(), m, nil, InstallOptions{SignerIdentity: signer, SignerIssuer: githubIssuer}); err != nil {
		t.Fatal(err)
	}
}

func TestAgentInstallWithoutCosignIsRefusedBeforePulling(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	fx := &fakeExec{paths: map[string]bool{"docker": true}}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	_, err := r.Install(context.Background(), m, nil, InstallOptions{SignerIdentity: signer, SignerIssuer: githubIssuer, RequireSignature: true})
	if _, ok := err.(*TrustError); !ok {
		t.Fatalf("expected TrustError, got %v", err)
	}
	if len(fx.calls) != 0 {
		t.Fatalf("expected nothing pulled, got %v", fx.calls)
	}
}

// blockingPull holds `docker pull` until cosign has started.
type blockingPull struct {
	fakeExec
	cosignStarted chan struct{}
}

func (f *blockingPull) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if name == "cosign" {
		close(f.cosignStarted)
	}
	if name == "docker" && args[0] == "pull" {
		<-f.cosignStarted
	}
	return f.fakeExec.Run(ctx, name, args, env, stdin, stdout, stderr)
}
