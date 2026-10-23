package cli

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// exitExec is a container engine whose tools exit with a code and print nothing.
type exitExec struct {
	fakeExec
	code int
}

func (f *exitExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if _, err := f.fakeExec.Run(ctx, name, args, env, stdin, stdout, stderr); err != nil {
		return 0, err
	}
	if len(args) > 0 && args[0] == "run" {
		return f.code, nil
	}
	return 0, nil
}

// fakeCommunity records what reaches the community routes and answers like the registry.
type fakeCommunity struct {
	mu      sync.Mutex
	reports []map[string]any
	auth    []string
}

func (fc *fakeCommunity) server(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/run-reports"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			fc.mu.Lock()
			fc.reports = append(fc.reports, body)
			fc.auth = append(fc.auth, r.Header.Get("Authorization"))
			fc.mu.Unlock()
			w.WriteHeader(http.StatusCreated)
			if r.Header.Get("Authorization") != "" {
				io.WriteString(w, `{"issue":12,"created":false,"moderation":"visible"}`)
			} else {
				io.WriteString(w, `{"counted":true}`)
			}
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/issues"):
			io.WriteString(w, `{"ref":"dheeraj/holehe-lite","counts":{"open":1,"closed":3},"issues":[{"number":12,"kind":"broken","status":"confirmed","title":"Fails on every address","version":"1.2.0","comments":2,"me_too":4,"author":{"handle":"alice"}}]}`)
		case r.Method == http.MethodPut && strings.HasSuffix(r.URL.Path, "/confirmations"):
			io.WriteString(w, `{"version":"1.2.0","works":3,"broken":1}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// installedFixture puts the docker fixture in state as if it came from the registry.
func installedFixture(t *testing.T) *manifest.Manifest {
	t.Helper()
	_, m, err := manifest.LoadFile(fixtures + "/valid/docker-tool.yaml")
	if err != nil {
		t.Fatal(err)
	}
	st, _ := state.Load()
	st.Installed[m.Ref()] = &state.Installed{Ref: m.Ref(), Version: m.Version, Runtime: "docker", Artifact: m.Runtime.Image, Manifest: m, InstalledAt: time.Now()}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestFailurePromptAsksOnceAndSendsNoInputs(t *testing.T) {
	fc := &fakeCommunity{}
	srv := fc.server(t)
	a, _, errb := newTestApp(t, &fakeExec{}, "y\n")
	t.Setenv("OT_NO_TELEMETRY", "")
	a.Config = state.LoadConfig()
	a.Runner.Exec = &exitExec{code: 1}
	a.API = api.New(srv.URL+"/v1", "test")
	m := installedFixture(t)

	if code := run(a, "run", m.Ref(), "e:person@example.com"); code != ExitToolError {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if !strings.Contains(errb.String(), "Report it as broken?") || !strings.Contains(errb.String(), "Thanks, counted.") {
		t.Fatalf("no prompt or outcome: %s", errb)
	}
	if len(fc.reports) != 1 {
		t.Fatalf("want one report, got %d", len(fc.reports))
	}
	rep := fc.reports[0]
	if rep["version"] != m.Version || rep["exit_code"] != float64(1) || rep["os"] == "" || rep["ot_version"] != Version {
		t.Fatalf("unexpected report: %v", rep)
	}
	raw, _ := json.Marshal(rep)
	if strings.Contains(string(raw), "person@example.com") {
		t.Fatalf("the report carried the input: %s", raw)
	}
	if fc.auth[0] != "" {
		t.Fatal("an anonymous report sent a token")
	}

	// The same tool and version are not asked about again for a week.
	errb.Reset()
	a.In = strings.NewReader("y\n")
	run(a, "run", m.Ref(), "e:person@example.com")
	if strings.Contains(errb.String(), "Report it as broken?") || len(fc.reports) != 1 {
		t.Fatalf("asked twice: %s", errb)
	}
}

func TestFailurePromptStaysQuiet(t *testing.T) {
	cases := []struct {
		name  string
		setup func(t *testing.T, a *App)
		args  []string
		code  int
	}{
		{"telemetry off", func(t *testing.T, a *App) {}, nil, 1},
		{"no terminal", func(t *testing.T, a *App) { t.Setenv("OT_NONINTERACTIVE", "1") }, nil, 1},
		{"json output", func(t *testing.T, a *App) {}, []string{"--json"}, 1},
		{"in CI", func(t *testing.T, a *App) { t.Setenv("CI", "true") }, nil, 1},
		{"the tool worked", func(t *testing.T, a *App) {}, nil, 0},
		{"answered no", func(t *testing.T, a *App) { a.In = strings.NewReader("\n") }, nil, 1},
		{"local manifest", func(t *testing.T, a *App) {}, nil, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fc := &fakeCommunity{}
			srv := fc.server(t)
			a, _, errb := newTestApp(t, &fakeExec{}, "y\n")
			t.Setenv("CI", "")
			if c.name != "telemetry off" {
				t.Setenv("OT_NO_TELEMETRY", "")
				a.Config = state.LoadConfig()
			}
			a.Runner.Exec = &exitExec{code: c.code}
			a.API = api.New(srv.URL+"/v1", "test")
			c.setup(t, a)
			m := installedFixture(t)
			pkg := m.Ref()
			if c.name == "local manifest" {
				pkg = fixtures + "/valid/docker-tool.yaml"
			}
			run(a, append([]string{"run", pkg, "e:person@example.com"}, c.args...)...)
			if len(fc.reports) != 0 {
				t.Fatalf("sent a report: %s", errb)
			}
			if c.name != "answered no" && strings.Contains(errb.String(), "Report it as broken?") {
				t.Fatalf("asked: %s", errb)
			}
		})
	}
}

func TestReportWorksAndBrokenAndIssues(t *testing.T) {
	fc := &fakeCommunity{}
	srv := fc.server(t)
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	m := installedFixture(t)

	// Saying it works needs a sign-in.
	if code := run(a, "report", m.Ref(), "--works"); code != ExitUsage || !strings.Contains(errb.String(), "ot login") {
		t.Fatalf("works without a token: exit %d: %s", code, errb)
	}
	a.API.Token = "ot_test"
	if code := run(a, "report", m.Ref(), "--works"); code != 0 || !strings.Contains(out.String(), "3 people say 1.2.0 works") {
		t.Fatalf("works: exit %d: %s %s", code, out, errb)
	}
	out.Reset()
	if code := run(a, "report", m.Ref(), "--broken"); code != 0 || !strings.Contains(out.String(), "Added you to") || !strings.Contains(out.String(), "/issues/12") {
		t.Fatalf("broken: exit %d: %s %s", code, out, errb)
	}
	if fc.auth[0] != "Bearer ot_test" || fc.reports[0]["version"] != "1.2.0" {
		t.Fatalf("broken sent %v with %q", fc.reports[0], fc.auth[0])
	}
	if code := run(a, "report", m.Ref(), "--works", "--broken"); code != ExitUsage {
		t.Fatalf("both flags: exit %d", code)
	}

	out.Reset()
	if code := run(a, "issues", m.Ref()); code != 0 || !strings.Contains(out.String(), "Fails on every address") || !strings.Contains(out.String(), "#") {
		t.Fatalf("issues: exit %d: %s", code, out)
	}
	out.Reset()
	if code := run(a, "issues", m.Ref(), "--json"); code != 0 {
		t.Fatalf("issues --json: exit %d", code)
	}
	var list api.IssueList
	if err := json.Unmarshal(out.Bytes(), &list); err != nil || len(list.Issues) != 1 || list.Issues[0].MeToo != 4 {
		t.Fatalf("issues JSON: %v %s", err, out)
	}
}
