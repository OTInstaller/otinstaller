package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

const fixtures = "../../../spec/fixtures"

// fakeExec pretends Docker is installed and prints canned tool output for `docker run`.
// It is safe for the parallel runs of `ot run --all`.
type fakeExec struct {
	stdout string
	mu     sync.Mutex
	calls  [][]string
}

func (f *fakeExec) LookPath(name string) (string, error) { return name, nil }
func (f *fakeExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	f.mu.Lock()
	f.calls = append(f.calls, append([]string{name}, args...))
	f.mu.Unlock()
	if len(args) > 0 && args[0] == "run" {
		io.WriteString(stdout, f.stdout)
	}
	return 0, nil
}

func newTestApp(t *testing.T, fx *fakeExec, stdin string) (*App, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	t.Setenv("OT_HOME", t.TempDir())
	t.Setenv("OT_NO_TELEMETRY", "1")
	t.Setenv("OT_OUTPUT", "")
	t.Setenv("OT_NONINTERACTIVE", "")
	t.Setenv("OT_MAX_RAW", "")
	t.Setenv("OT_RESULTS_DIR", filepath.Join(t.TempDir(), "results"))
	var out, errb bytes.Buffer
	cfg := state.LoadConfig()
	a := &App{
		Out: &out, Err: &errb, In: strings.NewReader(stdin), Config: cfg,
		API:    api.New("http://127.0.0.1:9", "test"),
		Runner: &runner.Runner{Exec: fx, Stderr: &errb, Engine: "docker"},
	}
	return a, &out, &errb
}

func run(a *App, args ...string) int {
	return a.Execute(context.Background(), args)
}

func TestValidateCommand(t *testing.T) {
	a, out, _ := newTestApp(t, &fakeExec{}, "")
	if code := run(a, "validate", filepath.Join(fixtures, "valid", "guide.yaml")); code != 0 {
		t.Fatalf("valid manifest: exit %d\n%s", code, out)
	}
	out.Reset()
	if code := run(a, "validate", "--json", filepath.Join(fixtures, "invalid", "placeholder-unknown.yaml")); code != ExitUsage {
		t.Fatalf("invalid manifest: exit %d", code)
	}
	var res struct {
		Valid    bool                    `json:"valid"`
		Problems []struct{ Code string } `json:"problems"`
	}
	if err := json.Unmarshal(out.Bytes(), &res); err != nil || res.Valid || res.Problems[0].Code != "manifest_placeholder_unknown" {
		t.Fatalf("unexpected JSON output: %s", out)
	}
}

func TestInitThenValidate(t *testing.T) {
	for _, kind := range []string{"docker", "pipx", "guide"} {
		t.Run(kind, func(t *testing.T) {
			a, out, errb := newTestApp(t, &fakeExec{}, "")
			// A fresh directory: everything the manifest points at is created, README.md included.
			dir := t.TempDir()
			code := run(a, "init", dir, "-y", "--kind", kind, "--name", "demo-tool", "--namespace", "dheeraj",
				"--summary", "Demo package used in tests")
			if code != 0 {
				t.Fatalf("init exit %d: %s %s", code, out, errb)
			}
			out.Reset()
			if code := run(a, "validate", dir); code != 0 {
				t.Fatalf("generated manifest does not validate: %s", out)
			}
		})
	}
}

func TestInitDoesNotOverwrite(t *testing.T) {
	a, out, _ := newTestApp(t, &fakeExec{}, "")
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "otinstaller.yaml"), []byte("keep me"), 0o644)
	run(a, "init", dir, "-y", "--kind", "guide", "--name", "x-guide", "--namespace", "me", "--summary", "A guide for tests")
	if b, _ := os.ReadFile(filepath.Join(dir, "otinstaller.yaml")); string(b) != "keep me" {
		t.Fatal("init overwrote an existing manifest")
	}
	if !strings.Contains(out.String(), "skipped otinstaller.yaml") {
		t.Fatalf("expected a skip message, got %s", out)
	}
}

func TestRunLocalManifest(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"github.com/abc"}]}`}
	a, out, errb := newTestApp(t, fx, "")
	t.Setenv("HIBP_API_KEY", "from-env")
	path := filepath.Join(fixtures, "valid", "docker-tool.yaml")
	if code := run(a, "run", path, "--email", "a@b.com", "--format", "table"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if !strings.Contains(out.String(), "github.com/abc") {
		t.Fatalf("table output missing entity: %s", out)
	}
	var runCall []string
	for _, c := range fx.calls {
		if len(c) > 1 && c[1] == "run" {
			runCall = c
		}
	}
	if runCall[len(runCall)-1] != "a@b.com" || !contains(runCall, "HIBP_API_KEY") {
		t.Fatalf("unexpected docker call: %v", runCall)
	}
}

func TestRunExitCodes(t *testing.T) {
	a, _, _ := newTestApp(t, &fakeExec{}, "")
	path := filepath.Join(fixtures, "valid", "docker-tool.yaml")
	if code := run(a, "run", path); code != ExitUsage {
		t.Errorf("missing required input: want %d, got %d", ExitUsage, code)
	}
	if code := run(a, "run", path, "--email", "nope"); code != ExitUsage {
		t.Errorf("bad email: want %d, got %d", ExitUsage, code)
	}
	if code := run(a, "run", "not a ref"); code != ExitUsage {
		t.Errorf("bad ref: want %d, got %d", ExitUsage, code)
	}
	// A required secret that is not set gives exit 3.
	dir := t.TempDir()
	src, _ := os.ReadFile(path)
	m := strings.Replace(string(src), "required: false\n    description: Adds", "required: true\n    description: Adds", 1)
	os.WriteFile(filepath.Join(dir, "otinstaller.yaml"), []byte(m), 0o644)
	t.Setenv("HIBP_API_KEY", "")
	if code := run(a, "run", filepath.Join(dir, "otinstaller.yaml"), "--email", "a@b.com"); code != ExitMissingKey {
		t.Errorf("missing key: want %d, got %d", ExitMissingKey, code)
	}
}

func TestParseRunArgs(t *testing.T) {
	ra, err := parseRunArgs([]string{"a/b", "--email=x@y.z", "--timeout", "5", "-f", "csv", "-o", "out.csv", "-y"})
	if err != nil {
		t.Fatal(err)
	}
	if ra.Pkg != "a/b" || ra.Inputs["email"] != "x@y.z" || ra.Inputs["timeout"] != "5" || ra.Format != "csv" || ra.Output != "out.csv" || !ra.Yes {
		t.Fatalf("unexpected parse: %+v", ra)
	}
	if _, err := parseRunArgs([]string{"a/b", "--email"}); err == nil {
		t.Fatal("expected an error for a flag without a value")
	}
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
