package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

const someEntities = `{"entities":[{"type":"account","value":"github.com/person"}]}`

// countingRegistry is fakeUpdateHandler's registry (dheeraj/holehe-lite 1.3.0 to install), recording the counts ot
// sends: the raw bodies of POST /installs and POST /runs.
type countingRegistry struct {
	srv      *httptest.Server
	mu       sync.Mutex
	installs []string
	runs     []string
	// hold, when set, keeps POST /runs from answering until it is closed (or 5 s pass).
	hold chan struct{}
}

func newCountingRegistry(t *testing.T) *countingRegistry {
	t.Helper()
	return countingRegistryFor(t, fakeUpdateHandler(t))
}

// countingRegistryFor records the counts and passes every other request to inner.
func countingRegistryFor(t *testing.T, inner http.Handler) *countingRegistry {
	t.Helper()
	reg := &countingRegistry{}
	reg.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || (r.URL.Path != "/v1/runs" && r.URL.Path != "/v1/installs") {
			inner.ServeHTTP(w, r)
			return
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Origin") != "" || !strings.HasPrefix(r.Header.Get("User-Agent"), "ot/") {
			t.Errorf("counts are anonymous and come from ot: %v", r.Header)
		}
		b, _ := io.ReadAll(r.Body)
		reg.mu.Lock()
		hold := reg.hold
		if r.URL.Path == "/v1/runs" {
			reg.runs = append(reg.runs, string(b))
		} else {
			reg.installs = append(reg.installs, string(b))
		}
		reg.mu.Unlock()
		if hold != nil && r.URL.Path == "/v1/runs" {
			select {
			case <-hold:
			case <-time.After(5 * time.Second):
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(reg.srv.Close)
	return reg
}

// sent decodes what arrived.
func (reg *countingRegistry) sent(t *testing.T) ([]api.Install, []api.RunsBody) {
	t.Helper()
	reg.mu.Lock()
	defer reg.mu.Unlock()
	var installs []api.Install
	var runs []api.RunsBody
	for _, b := range reg.installs {
		var in api.Install
		if err := json.Unmarshal([]byte(b), &in); err != nil {
			t.Fatalf("POST /installs: %v: %s", err, b)
		}
		installs = append(installs, in)
	}
	for _, b := range reg.runs {
		var body api.RunsBody
		if err := json.Unmarshal([]byte(b), &body); err != nil {
			t.Fatalf("POST /runs: %v: %s", err, b)
		}
		runs = append(runs, body)
	}
	return installs, runs
}

// rows are every run counted, in every POST /runs.
func (reg *countingRegistry) rows(t *testing.T) []api.RunCount {
	t.Helper()
	_, bodies := reg.sent(t)
	var rows []api.RunCount
	for _, b := range bodies {
		rows = append(rows, b.Runs...)
	}
	return rows
}

// waitRows waits up to 5 s for n rows, for ot mcp, whose counts go after the call returns.
func (reg *countingRegistry) waitRows(t *testing.T, n int) []api.RunCount {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		if rows := reg.rows(t); len(rows) >= n || time.Now().After(deadline) {
			return rows
		}
	}
}

func (reg *countingRegistry) nothingSent(t *testing.T) {
	t.Helper()
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if len(reg.installs)+len(reg.runs) > 0 {
		t.Errorf("counts were sent: installs %v, runs %v", reg.installs, reg.runs)
	}
}

// countingApp is newTestApp with telemetry on, talking to a counting registry. Tests run as a dev build, which counts
// against any registry but the public one.
func countingApp(t *testing.T, fx *fakeExec) (*App, *countingRegistry, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	reg := newCountingRegistry(t)
	a, out, errb := newTestApp(t, fx, "")
	t.Setenv("OT_NO_TELEMETRY", "")
	t.Setenv("CI", "")
	a.Config = state.LoadConfig()
	a.API = api.New(reg.srv.URL+"/v1", "test")
	return a, reg, out, errb
}

// seedTool puts a manifest in state as if it came from the registry, as installedFixture does; change, when set,
// edits it first. A machine with a tool installed before ot first counts starts with its milestones reached.
func seedTool(t *testing.T, path string, change func(*manifest.Manifest)) *manifest.Manifest {
	t.Helper()
	_, m, err := manifest.LoadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if change != nil {
		change(m)
	}
	st, _ := state.Load()
	st.Installed[m.Ref()] = &state.Installed{Ref: m.Ref(), Version: m.Version, Runtime: "docker", Artifact: m.Runtime.Image, Manifest: m, InstalledAt: time.Now()}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	return m
}

func fixturePath() string { return filepath.Join(fixtures, "valid", "docker-tool.yaml") }

// keysOf lists a JSON object's keys, sorted.
func keysOf(t *testing.T, raw []byte) []string {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("%v: %s", err, raw)
	}
	var keys []string
	for k := range doc {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// blockingExec runs every tool until its context ends, and says when the first one started.
type blockingExec struct {
	fakeExec
	started chan struct{}
	once    sync.Once
}

func (f *blockingExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if len(args) > 0 && args[0] == "run" {
		f.once.Do(func() { close(f.started) })
		<-ctx.Done()
		return 137, nil
	}
	return f.fakeExec.Run(ctx, name, args, env, stdin, stdout, stderr)
}

// failPullExec is fakeExec whose `docker pull` fails, as on a network that drops the registry.
type failPullExec struct{ fakeExec }

func (f *failPullExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	if len(args) > 0 && args[0] == "pull" {
		io.WriteString(stderr, "Error response from daemon: Get \"https://ghcr.io/v2/\": net/http: TLS handshake timeout")
		return 1, nil
	}
	return f.fakeExec.Run(ctx, name, args, env, stdin, stdout, stderr)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// Counts carry the allow-list and nothing else: no input, target, finding, results path, run id, case name, key name
// or value, and never the token.
func TestUsageSendsOnlyTheAllowList(t *testing.T) {
	a, reg, out, errb := countingApp(t, &fakeExec{stdout: someEntities})
	t.Setenv("HIBP_API_KEY", "sekrit-value")
	a.API.Token = "ot_secret_token"
	if code := run(a, "run", "dheeraj/holehe-lite", "e:person@example.com", "--case", "secret-case", "--yes"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var env envelope.Envelope
	if err := json.Unmarshal(out.Bytes(), &env); err != nil || env.RunID == "" {
		t.Fatalf("envelope: %v: %s", err, out)
	}
	installs, runs := reg.sent(t)
	if len(installs) != 1 || len(runs) != 1 || len(runs[0].Runs) != 1 {
		t.Fatalf("want one install and one run: %v %v", reg.installs, reg.runs)
	}
	want := api.Install{Tool: "dheeraj/holehe-lite", Version: "1.3.0", Client: "cli", First: true, OS: runtime.GOOS, Arch: runtime.GOARCH, Engine: "docker", OTVersion: "dev"}
	if installs[0] != want {
		t.Errorf("install: %+v, want %+v", installs[0], want)
	}
	if got := strings.Join(keysOf(t, []byte(reg.installs[0])), ","); got != "arch,client,engine,first,from_backup,os,ot_version,tool,version" {
		t.Errorf("install keys: %s", got)
	}
	body := runs[0]
	if body.Client != "cli" || body.OS != runtime.GOOS || body.Arch != runtime.GOARCH || body.OTVersion != "dev" || body.MCPClient != "" {
		t.Errorf("runs: %+v", body)
	}
	if r := body.Runs[0]; r.Tool != "dheeraj/holehe-lite" || r.Version != "1.3.0" || r.Outcome != "ok" || r.Engine != "docker" || r.Via != "run" || r.DurationMS < 0 {
		t.Errorf("run: %+v", r)
	}
	allowed := []string{"arch", "client", "install_failures", "mcp_client", "milestones", "os", "ot_version", "runs"}
	for _, k := range keysOf(t, []byte(reg.runs[0])) {
		if !slices.Contains(allowed, k) {
			t.Errorf("POST /runs has %q", k)
		}
	}
	var raw struct{ Runs []json.RawMessage }
	json.Unmarshal([]byte(reg.runs[0]), &raw)
	if got := strings.Join(keysOf(t, raw.Runs[0]), ","); got != "duration_ms,engine,outcome,tool,version,via" {
		t.Errorf("run keys: %s", got)
	}
	resultsDir := os.Getenv("OT_RESULTS_DIR")
	quoted, _ := json.Marshal(resultsDir)
	for _, b := range append(append([]string{}, reg.installs...), reg.runs...) {
		for _, secret := range []string{"person@example.com", "github.com/person", "secret-case", "HIBP_API_KEY", "sekrit-value",
			"ot_secret_token", env.RunID, resultsDir, strings.Trim(string(quoted), `"`)} {
			if strings.Contains(b, secret) {
				t.Errorf("%q was sent: %s", secret, b)
			}
		}
	}
}

// Nothing is counted with any of the off switches, for local manifests, or by a dev build talking to the public
// registry. DO_NOT_TRACK=0 or false doesn't turn it off.
func TestUsageOffSwitches(t *testing.T) {
	for _, c := range []struct {
		name  string
		setup func(t *testing.T, a *App) []string
		rows  int
	}{
		{"OT_NO_TELEMETRY, any value", func(t *testing.T, a *App) []string {
			t.Setenv("OT_NO_TELEMETRY", "0")
			return nil
		}, 0},
		{"DO_NOT_TRACK=1", func(t *testing.T, a *App) []string {
			t.Setenv("DO_NOT_TRACK", "1")
			return nil
		}, 0},
		{"DO_NOT_TRACK=true", func(t *testing.T, a *App) []string {
			t.Setenv("DO_NOT_TRACK", "true")
			return nil
		}, 0},
		{"DO_NOT_TRACK=0", func(t *testing.T, a *App) []string {
			t.Setenv("DO_NOT_TRACK", "0")
			return nil
		}, 1},
		{"DO_NOT_TRACK=false", func(t *testing.T, a *App) []string {
			t.Setenv("DO_NOT_TRACK", "False")
			return nil
		}, 1},
		{"config.json", func(t *testing.T, a *App) []string {
			if err := state.SetConfig(map[string]any{"telemetry": false}); err != nil {
				t.Fatal(err)
			}
			return nil
		}, 0},
		{"ot telemetry off", func(t *testing.T, a *App) []string {
			if code := run(a, "telemetry", "off"); code != 0 {
				t.Fatalf("telemetry off: exit %d", code)
			}
			if cfg := readConfigFile(t); cfg["telemetry"] != false {
				t.Errorf("config.json: %v", cfg)
			}
			return nil
		}, 0},
		{"a local manifest", func(t *testing.T, a *App) []string {
			return []string{"run", fixturePath(), "--email", "a@b.com"}
		}, 0},
		{"a local install run under its registry name", func(t *testing.T, a *App) []string {
			if code := run(a, "install", fixturePath()); code != 0 {
				t.Fatalf("install: exit %d", code)
			}
			return nil
		}, 0},
	} {
		t.Run(c.name, func(t *testing.T) {
			a, reg, _, errb := countingApp(t, &fakeExec{stdout: someEntities})
			if !strings.HasPrefix(c.name, "a local") {
				seedTool(t, fixturePath(), nil)
			}
			args := c.setup(t, a)
			a.Config.Telemetry = state.LoadConfig().Telemetry
			if args == nil {
				args = []string{"run", "dheeraj/holehe-lite", "e:a@b.com"}
			}
			if code := run(a, args...); code != 0 {
				t.Fatalf("exit %d: %s", code, errb)
			}
			if c.rows == 0 {
				reg.nothingSent(t)
			} else if rows := reg.rows(t); len(rows) != c.rows {
				t.Errorf("want %d rows: %v", c.rows, rows)
			}
		})
	}

	t.Run("a dev build and the public registry", func(t *testing.T) {
		a, _, _, errb := countingApp(t, &fakeExec{stdout: someEntities})
		seedTool(t, fixturePath(), nil)
		var mu sync.Mutex
		var asked []string
		a.API = api.New(state.DefaultAPIURL, "test")
		a.API.HTTP = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			mu.Lock()
			asked = append(asked, r.Method+" "+r.URL.Path)
			mu.Unlock()
			return nil, errors.New("tests never reach the public registry")
		})}
		if code := run(a, "run", "dheeraj/holehe-lite", "e:a@b.com"); code != 0 {
			t.Fatalf("exit %d: %s", code, errb)
		}
		mu.Lock()
		if len(asked) != 0 {
			t.Errorf("a dev build sent %v", asked)
		}
		mu.Unlock()
		// A release build would have: the dev-build rule is what held it back.
		old := Version
		Version = "v9.9.9"
		defer func() { Version = old }()
		run(a, "run", "dheeraj/holehe-lite", "e:a@b.com")
		mu.Lock()
		defer mu.Unlock()
		if !slices.Contains(asked, "POST /v1/runs") {
			t.Errorf("a release build should count: %v", asked)
		}
	})
}

// One hook counts every run: --all, auto and a playbook each count one row per tool that ran, with what started it.
func TestUsageCountsEveryRunOfABatch(t *testing.T) {
	a, reg, _, errb := countingApp(t, &fakeExec{stdout: `{"entities":[{"type":"ip","value":"192.0.2.1"}]}`})
	var tools []string
	for _, name := range []string{"dns-a", "dns-b", "dns-c"} {
		tools = append(tools, seedTool(t, toolVariant(t, name, "domain", false, false, false), nil).Ref())
	}
	os.MkdirAll(state.Path("playbooks"), 0o755)
	pb := "name: three\ndescription: Three domain tools\ninputs: [domain]\ntools:\n  - " + strings.Join(tools, "\n  - ") + "\n"
	if err := os.WriteFile(state.Path("playbooks", "three.yaml"), []byte(pb), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		args []string
		via  string
	}{
		{[]string{"run", "--all", "d:example.com"}, "all"},
		{[]string{"auto", "example.com"}, "auto"},
		{[]string{"playbook", "three", "d:example.com"}, "playbook"},
	} {
		before := len(reg.rows(t))
		if code := run(a, c.args...); code != 0 {
			t.Fatalf("%v: exit %d: %s", c.args, code, errb)
		}
		rows := reg.rows(t)[before:]
		var got []string
		for _, r := range rows {
			if r.Via != c.via || r.Outcome != "ok" {
				t.Errorf("%v: %+v", c.args, r)
			}
			got = append(got, r.Tool)
		}
		sort.Strings(got)
		if strings.Join(got, " ") != strings.Join(tools, " ") {
			t.Errorf("%v: counted %v, want one run of each of %v", c.args, got, tools)
		}
	}
}

// Each way a run can end is counted as its outcome.
func TestUsageOutcomes(t *testing.T) {
	for _, c := range []struct {
		name   string
		exec   runner.Exec
		noEng  bool
		change func(*manifest.Manifest)
		cancel bool
		want   string
		code   int
	}{
		{name: "found something", exec: &fakeExec{stdout: someEntities}, want: "ok"},
		{name: "found nothing", exec: &fakeExec{stdout: `{"entities":[]}`}, want: "empty"},
		{name: "a non-zero exit", exec: &exitExec{code: 1}, want: "error", code: ExitToolError},
		{name: "exit 125", exec: &exitExec{code: 125}, want: "engine_error", code: ExitToolError},
		{name: "a timeout", exec: &blockingExec{started: make(chan struct{})}, change: func(m *manifest.Manifest) { m.Runtime.TimeoutSeconds = 1 },
			want: "timeout", code: ExitTimeout},
		{name: "Ctrl-C", exec: &blockingExec{started: make(chan struct{})}, cancel: true, want: "interrupted", code: ExitInterrupted},
		{name: "no engine", exec: &fakeExec{}, noEng: true, want: "no_engine", code: ExitRuntimeMissing},
		{name: "a missing key", exec: &fakeExec{}, change: func(m *manifest.Manifest) { m.Secrets[0].Required = true },
			want: "missing_key", code: ExitMissingKey},
	} {
		t.Run(c.name, func(t *testing.T) {
			a, reg, _, errb := countingApp(t, &fakeExec{})
			t.Setenv("HIBP_API_KEY", "")
			a.Runner.Exec = c.exec
			if c.noEng {
				a.Runner.Engine = ""
			}
			seedTool(t, fixturePath(), c.change)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if b, ok := c.exec.(*blockingExec); ok && c.cancel {
				go func() { <-b.started; cancel() }()
			}
			if code := a.Execute(ctx, []string{"run", "dheeraj/holehe-lite", "e:a@b.com"}); code != c.code {
				t.Fatalf("exit %d, want %d: %s", code, c.code, errb)
			}
			rows := reg.rows(t)
			if len(rows) != 1 || rows[0].Outcome != c.want || rows[0].Via != "run" {
				t.Fatalf("want one %s run: %+v", c.want, rows)
			}
			if c.noEng && rows[0].Engine != "none" {
				t.Errorf("engine: %+v", rows[0])
			}
		})
	}
}

// What the run hook can't reach end to end: a tool that never started, and a native tool's own exit 125.
func TestRunOutcome(t *testing.T) {
	ctx := context.Background()
	docker := &state.Installed{Runtime: "docker"}
	native := &state.Installed{Runtime: "pipx", Native: true}
	sandboxed := &state.Installed{Runtime: "pipx"}
	for _, c := range []struct {
		inst *state.Installed
		env  *envelope.Envelope
		meta *results.Meta
		err  error
		want string
	}{
		{docker, nil, nil, errors.New("results folder not writable"), "not_started"},
		{docker, nil, nil, &runner.TimeoutError{Seconds: 1}, "timeout"},
		{native, &envelope.Envelope{ExitCode: 125}, nil, nil, "error"},
		{sandboxed, &envelope.Envelope{ExitCode: 125}, nil, nil, "engine_error"},
		{docker, nil, &results.Meta{ExitCode: 0, Entities: []envelope.Entity{{Type: "ip", Value: "192.0.2.1"}}}, nil, "ok"},
		{docker, nil, &results.Meta{ExitCode: 0}, errors.New("couldn't write the sidecar"), "empty"},
	} {
		if got := runOutcome(ctx, c.inst, c.env, c.meta, c.err); got != c.want {
			t.Errorf("%+v %v: %s, want %s", c.inst, c.err, got, c.want)
		}
	}
	gone, cancel := context.WithCancel(ctx)
	cancel()
	if got := runOutcome(gone, docker, nil, &results.Meta{ExitCode: -1}, errors.New("interrupted")); got != "interrupted" {
		t.Errorf("cancelled: %s", got)
	}
}

// A missing key is counted for a single run (even before the tool is installed), never for the tools --all skips.
func TestUsageMissingKeyOnlyForSingleRuns(t *testing.T) {
	a, reg, _, errb := countingApp(t, &fakeExec{stdout: someEntities})
	t.Setenv("HIBP_API_KEY", "")
	needsKey := func(m *manifest.Manifest) { m.Secrets[0].Required = true }
	seedTool(t, toolVariant(t, "keyed", "domain", false, false, false), needsKey)
	if code := run(a, "run", "--all", "d:example.com"); code != 0 {
		t.Fatalf("--all with only a skipped tool: exit %d: %s", code, errb)
	}
	reg.nothingSent(t)
	if code := run(a, "run", "dheeraj/keyed", "d:example.com"); code != ExitMissingKey {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if rows := reg.rows(t); len(rows) != 1 || rows[0].Outcome != "missing_key" || rows[0].Tool != "dheeraj/keyed" {
		t.Fatalf("rows: %+v", rows)
	}
}

// An install that fails is counted, with its reason, in POST /runs; only a working one is an install.
func TestUsageCountsInstallFailures(t *testing.T) {
	a, reg, _, errb := countingApp(t, &fakeExec{})
	a.Runner.Exec = &failPullExec{}
	if code := run(a, "install", "dheeraj/holehe-lite"); code != ExitToolError {
		t.Fatalf("exit %d: %s", code, errb)
	}
	installs, runs := reg.sent(t)
	if len(installs) != 0 || len(runs) != 1 || len(runs[0].Runs) != 0 {
		t.Fatalf("installs %v, runs %v", reg.installs, reg.runs)
	}
	if f := runs[0].InstallFailures; len(f) != 1 || f[0] != (api.InstallFailure{Tool: "dheeraj/holehe-lite", Version: "1.3.0", Reason: "pull_failed"}) {
		t.Errorf("failures: %+v", f)
	}
}

// When the command ends, ot waits a moment for its counts, never long: a registry that takes 5 s holds it up for
// usageWait, and is then out of reach for an hour, so the next command doesn't wait at all.
func TestUsageExitWaitIsBounded(t *testing.T) {
	a, reg, _, errb := countingApp(t, &fakeExec{stdout: someEntities})
	seedTool(t, fixturePath(), nil)
	hold := make(chan struct{})
	reg.mu.Lock()
	reg.hold = hold
	reg.mu.Unlock()
	t.Cleanup(func() { close(hold) }) // before the server closes
	old := usageWait
	t.Cleanup(func() { usageWait = old })

	usageWait = 200 * time.Millisecond
	start := time.Now()
	if code := run(a, "run", "dheeraj/holehe-lite", "e:a@b.com"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("the command took %s with a registry that takes 5 s", d)
	}
	if tel := state.LoadTelemetry(); time.Since(tel.UnreachableAt) > time.Minute {
		t.Fatalf("the registry should count as out of reach: %+v", tel)
	}
	usageWait = 2 * time.Second
	start = time.Now()
	run(a, "run", "dheeraj/holehe-lite", "e:a@b.com")
	if d := time.Since(start); d > 1500*time.Millisecond {
		t.Errorf("waited %s for a registry out of reach", d)
	}
}

// Runs from an AI agent are counted with client mcp and the client's name; `ot telemetry off` stops them without
// a restart.
func TestUsageMCPRunsCountAsMCP(t *testing.T) {
	reg := newCountingRegistry(t)
	old := usageDebounce
	usageDebounce = 20 * time.Millisecond
	t.Cleanup(func() { usageDebounce = old })
	h := newMCP(t, `{"entities":[{"type":"subdomain","value":"www.example.com"}]}`, "", nil)
	t.Setenv("OT_NO_TELEMETRY", "")
	t.Setenv("CI", "")
	h.app.Config = state.LoadConfig()
	h.app.API = api.New(reg.srv.URL+"/v1", "test")
	seedTool(t, toolVariant(t, "dns-local", "domain", false, false, false), nil)
	defer h.app.sink().wait(5 * time.Second)

	args := map[string]any{"tool": "dheeraj/dns-local", "target": "example.com"}
	if _, e := h.call("run_tool", args); e != nil {
		t.Fatal(e)
	}
	rows := reg.waitRows(t, 1)
	_, bodies := reg.sent(t)
	if len(rows) != 1 || rows[0].Via != "mcp" || rows[0].Outcome != "ok" || bodies[0].Client != "mcp" || bodies[0].MCPClient != "other" {
		t.Fatalf("bodies: %+v", bodies)
	}

	if err := state.SetConfig(map[string]any{"telemetry": false}); err != nil {
		t.Fatal(err)
	}
	if _, e := h.call("run_tool", args); e != nil {
		t.Fatal(e)
	}
	h.app.sink().wait(5 * time.Second)
	if rows := reg.rows(t); len(rows) != 1 {
		t.Errorf("counted after `ot telemetry off`: %+v", rows)
	}
}

func TestMCPClientSlug(t *testing.T) {
	for name, want := range map[string]string{
		"claude-code": "claude_code", "Claude Code": "claude_code", "claude-ai": "claude_desktop", "cursor-vscode": "cursor",
		"Visual Studio Code": "vscode", "Visual Studio Code - Insiders": "vscode", "codex-mcp-client": "codex",
		"gemini-cli-mcp-client": "gemini", "windsurf-client": "windsurf", "Zed": "zed", "Cline": "cline",
		"continue-client": "continue", "goose": "goose", "test-client": "other", "optimized-agent": "other", "": "other",
	} {
		if got := mcpClientSlug(name); got != want {
			t.Errorf("%q: %s, want %s", name, got, want)
		}
	}
}

// The one-time notice: at a terminal, before the first command that may count, never for JSON, CI, help, ot start
// or ot telemetry, and once.
func TestUsageNoticeOnce(t *testing.T) {
	const notice = "note: ot counts installs and runs (the tool, its version and how each run ended; never your inputs, targets or results) so we can see which tools work. `ot telemetry off` turns it off: https://otinstaller.com/policy/privacy\n"
	a, _, _, errb := countingApp(t, &fakeExec{})
	for _, c := range []struct {
		args       []string
		env, value string
	}{
		{[]string{"list", "--json"}, "", ""},
		{[]string{"list"}, "OT_OUTPUT", "json"},
		{[]string{"list"}, "CI", "1"},
		{[]string{"list"}, "OT_NONINTERACTIVE", "1"},
		{[]string{"help"}, "", ""},
		{[]string{"start", "--dry-run"}, "", ""},
	} {
		if c.env != "" {
			t.Setenv(c.env, c.value)
		}
		errb.Reset()
		run(a, c.args...)
		if strings.Contains(errb.String(), "note: ot counts") {
			t.Errorf("%v %s: %s", c.args, c.env, errb)
		}
		if c.env != "" {
			t.Setenv(c.env, "")
		}
	}
	errb.Reset()
	run(a, "list")
	if !strings.HasPrefix(errb.String(), notice) {
		t.Fatalf("no notice: %q", errb)
	}
	errb.Reset()
	run(a, "list")
	if strings.Contains(errb.String(), "note: ot counts") {
		t.Errorf("shown twice: %s", errb)
	}
	if state.LoadTelemetry().NoticeShownAt.IsZero() {
		t.Error("telemetry.json doesn't remember it")
	}

	// `ot telemetry` says all the notice does, so it isn't shown after it; with telemetry off it never is.
	a, _, _, errb = countingApp(t, &fakeExec{})
	run(a, "telemetry")
	errb.Reset()
	run(a, "list")
	if strings.Contains(errb.String(), "note: ot counts") {
		t.Errorf("after ot telemetry: %s", errb)
	}
	a, _, _, errb = countingApp(t, &fakeExec{})
	t.Setenv("DO_NOT_TRACK", "1")
	a.Config = state.LoadConfig()
	run(a, "list")
	if strings.Contains(errb.String(), "note: ot counts") {
		t.Errorf("with telemetry off: %s", errb)
	}
}

// OT_TELEMETRY_DEBUG=1 prints each POST on stderr and sends nothing.
func TestUsageDebugPrintsAndSendsNothing(t *testing.T) {
	a, reg, _, errb := countingApp(t, &fakeExec{stdout: someEntities})
	t.Setenv("OT_TELEMETRY_DEBUG", "1")
	if code := run(a, "run", "dheeraj/holehe-lite", "e:person@example.com", "--yes"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	for _, want := range []string{`telemetry: POST /installs {"tool":"dheeraj/holehe-lite","version":"1.3.0","client":"cli"`,
		`telemetry: POST /runs {"ot_version":"dev","client":"cli"`, `"outcome":"ok"`, `"milestones":["first_run","first_ok_run"]`} {
		if !strings.Contains(errb.String(), want) {
			t.Errorf("stderr lacks %s:\n%s", want, errb)
		}
	}
	for _, line := range strings.Split(errb.String(), "\n") {
		if strings.HasPrefix(line, "telemetry: ") && strings.Contains(line, "person@example.com") {
			t.Errorf("the payload has the input: %s", line)
		}
	}
	reg.nothingSent(t)
	// Debugging sends nothing, so it uses up no milestone.
	if tel := state.LoadTelemetry(); len(tel.Milestones) != 0 {
		t.Errorf("telemetry.json: %+v", tel)
	}
}

// Milestones are each reported once per machine, and never by an ot that finds tools installed when it first counts
// (an upgrade, not a new person).
func TestUsageMilestones(t *testing.T) {
	a, reg, _, errb := countingApp(t, &fakeExec{stdout: `{"entities":[]}`})
	if code := run(a, "run", "dheeraj/holehe-lite", "e:a@b.com", "--yes"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	a.Runner.Exec = &fakeExec{stdout: someEntities}
	run(a, "run", "dheeraj/holehe-lite", "e:a@b.com")
	run(a, "run", "dheeraj/holehe-lite", "e:a@b.com")
	run(a, "install", "dheeraj/holehe-lite@1.2.0")
	installs, runs := reg.sent(t)
	if len(installs) != 2 || !installs[0].First || installs[1].First {
		t.Errorf("installs: %+v", installs)
	}
	var got []string
	for _, b := range runs {
		got = append(got, strings.Join(b.Milestones, "+"))
	}
	// An empty first run is a first run, not yet a first run that found something.
	if !slices.Equal(got, []string{"first_run", "first_ok_run", ""}) {
		t.Errorf("milestones per POST: %q", got)
	}
	if tel := state.LoadTelemetry(); strings.Join(tel.Milestones, ",") != "first_install,first_run,first_ok_run" {
		t.Errorf("telemetry.json: %+v", tel)
	}

	a, reg, _, errb = countingApp(t, &fakeExec{stdout: someEntities})
	seedTool(t, fixturePath(), nil)
	if code := run(a, "run", "dheeraj/holehe-lite", "e:a@b.com"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if _, runs := reg.sent(t); len(runs) != 1 || len(runs[0].Milestones) != 0 {
		t.Errorf("after an upgrade: %+v", runs)
	}
}

// `ot telemetry` says where the setting comes from; on with an environment variable set warns that it still wins.
func TestTelemetryCommand(t *testing.T) {
	a, _, out, errb := countingApp(t, &fakeExec{})
	status := func() telemetryStatus {
		t.Helper()
		out.Reset()
		if code := run(a, "telemetry", "status", "--json"); code != 0 {
			t.Fatalf("exit %d: %s", code, errb)
		}
		var st telemetryStatus
		if err := json.Unmarshal(out.Bytes(), &st); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		return st
	}
	if st := status(); !st.Enabled || st.Source != "default" || !st.Counting || !slices.Contains(st.Sends, "outcome") || !slices.Contains(st.Never, "inputs") {
		t.Errorf("default: %+v", st)
	}
	out.Reset()
	if code := run(a, "telemetry", "off"); code != 0 || !strings.Contains(out.String(), "Telemetry is off") {
		t.Fatalf("off: exit %d: %s", code, out)
	}
	if st := status(); st.Enabled || st.Source != "config" || st.Counting {
		t.Errorf("off: %+v", st)
	}
	t.Setenv("DO_NOT_TRACK", "1")
	out.Reset()
	if code := run(a, "telemetry", "on"); code != 0 || !strings.Contains(out.String(), "Telemetry stays off: DO_NOT_TRACK is set") {
		t.Fatalf("on: exit %d: %s", code, out)
	}
	errb.Reset()
	if code := run(a, "telemetry", "on", "--json"); code != 0 || !strings.Contains(errb.String(), "warning: DO_NOT_TRACK is set") {
		t.Fatalf("on --json: exit %d: %s", code, errb)
	}
	if cfg := readConfigFile(t); cfg["telemetry"] != nil {
		t.Errorf("on is the default, so the key goes: %v", cfg)
	}
	if st := status(); st.Enabled || st.Source != "DO_NOT_TRACK" || a.Config.TelemetryEnabled() {
		t.Errorf("DO_NOT_TRACK: %+v", st)
	}
	out.Reset()
	run(a, "telemetry")
	if !strings.Contains(out.String(), "Telemetry is off (DO_NOT_TRACK is set in your environment)") {
		t.Errorf("status: %s", out)
	}
	if code := run(a, "telemetry", "maybe"); code != ExitUsage {
		t.Errorf("unknown: exit %d", code)
	}
}

// engineName says native for tools run on the host.
func TestEngineName(t *testing.T) {
	a, _, _ := newTestApp(t, &fakeExec{}, "")
	if a.engineName(true) != "native" || a.engineName(false) != "docker" {
		t.Errorf("%q %q", a.engineName(true), a.engineName(false))
	}
	a.Runner.Engine = ""
	if a.engineName(false) != "" {
		t.Errorf("no engine: %q", a.engineName(false))
	}
}

// ot start's telemetry choice applies to its own installs, and says what the one-time notice would.
func TestUsageStartAppliesTheChoice(t *testing.T) {
	starter := fakeStarterRegistry(t)
	t.Cleanup(starter.Close)
	reg := countingRegistryFor(t, starter.Config.Handler)
	a, _, errb := newTestApp(t, &fakeExec{}, "")
	t.Setenv("OT_NO_TELEMETRY", "")
	t.Setenv("CI", "")
	if err := state.SetConfig(map[string]any{"telemetry": false}); err != nil {
		t.Fatal(err)
	}
	a.Config = state.LoadConfig()
	a.API = api.New(reg.srv.URL+"/v1", "test")

	if code := run(a, "start", "--tools", "osintverse-community/sherlock", "--telemetry", "on", "--yes"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if installs, _ := reg.sent(t); len(installs) != 1 || installs[0].Tool != "osintverse-community/sherlock" || !installs[0].First {
		t.Fatalf("installs: %+v", installs)
	}
	if cfg := readConfigFile(t); cfg["telemetry"] != nil {
		t.Errorf("config.json: %v", cfg)
	}
	if state.LoadTelemetry().NoticeShownAt.IsZero() {
		t.Error("ot start's choice should count as the notice")
	}
	if code := run(a, "start", "--tools", "osintverse-community/maigret", "--telemetry", "off", "--yes"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if installs, _ := reg.sent(t); len(installs) != 1 {
		t.Errorf("counted after --telemetry off: %+v", installs)
	}
}
