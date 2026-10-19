package runner

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/osintverse/otinstaller/cli/internal/manifest"
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
}

// fakeExec records calls and prints canned output for `docker run`.
type fakeExec struct {
	calls  [][]string
	stdout string
	code   int
	env    []string
	paths  map[string]bool
}

func (f *fakeExec) LookPath(name string) (string, error) {
	if f.paths[name] {
		return name, nil
	}
	return "", fmt.Errorf("not found")
}

func (f *fakeExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	f.calls = append(f.calls, append([]string{name}, args...))
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

func TestPipxSandboxedBuildsLocalImage(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	wheel := []byte("w")
	sum := sha256.Sum256(wheel)
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/json") {
			fmt.Fprintf(w, `{"urls":[{"filename":"p-0.3.1-py3-none-any.whl","url":"%s/w","packagetype":"bdist_wheel","digests":{"sha256":"%x"}}]}`, srv.URL, sum)
			return
		}
		w.Write(wheel)
	}))
	defer srv.Close()
	old := PyPIBase
	PyPIBase = srv.URL
	defer func() { PyPIBase = old }()

	m := load(t, "pipx-tool.yaml")
	m.Runtime.WheelSHA256 = hex.EncodeToString(sum[:])
	fx := &fakeExec{paths: map[string]bool{"docker": true}}
	r := &Runner{Exec: fx, Stderr: io.Discard, Engine: "docker"}
	inst, err := r.Install(context.Background(), m, nil, InstallOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if inst.Native || inst.LocalImage != "ot-local/osintverse-phone-parse:0.3.1" {
		t.Fatalf("expected a sandboxed local image, got %+v", inst)
	}
	if fx.calls[0][1] != "build" {
		t.Fatalf("expected docker build, got %v", fx.calls[0])
	}
}
