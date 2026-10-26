package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/huh"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/playbook"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// fakeStartRegistry is fakeStarterRegistry plus the tool list the wizard reads, in two pages.
func fakeStartRegistry(t *testing.T) *httptest.Server {
	t.Helper()
	starter := fakeStarterRegistry(t)
	t.Cleanup(starter.Close)
	target, _ := url.Parse(starter.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tools" {
			proxy.ServeHTTP(w, r)
			return
		}
		if r.URL.Query().Get("kind") != "tool" {
			t.Errorf("tool list without kind=tool: %s", r.URL)
		}
		page := map[string]any{"results": []map[string]any{{"namespace": "osintverse-community", "name": "sherlock", "kind": "tool",
			"summary": "Finds sherlock accounts", "inputs": []string{"username"}, "status": "active", "needs_keys": true}}, "next_cursor": "1"}
		if r.URL.Query().Get("cursor") == "1" {
			page = map[string]any{"results": []map[string]any{{"namespace": "osintverse-community", "name": "maigret", "kind": "tool",
				"summary": "Finds maigret accounts", "inputs": []string{"username"}, "status": "deprecated"}}}
		}
		json.NewEncoder(w).Encode(page)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func readConfigFile(t *testing.T) map[string]any {
	t.Helper()
	b, err := os.ReadFile(state.Path("config.json"))
	if err != nil {
		return nil
	}
	var doc map[string]any
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatalf("config.json: %v: %s", err, b)
	}
	return doc
}

// With --yes, ot start installs the packs' tools and the named ones, and writes only the settings it was given.
func TestStartWithFlags(t *testing.T) {
	srv := fakeStartRegistry(t)
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	if err := state.SetConfig(map[string]any{"site_url": "https://example.test"}); err != nil {
		t.Fatal(err)
	}

	if code := run(a, "start", "--playbooks", "username-investigation", "--tools", "osintverse-community/sherlock",
		"--format", "table", "--telemetry", "off", "--yes"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	st, _ := state.Load()
	if st.Installed["osintverse-community/sherlock"] == nil || st.Installed["osintverse-community/maigret"] == nil || len(st.Installed) != 2 {
		t.Fatalf("installed: %v", st.Installed)
	}
	cfg := readConfigFile(t)
	if cfg["format"] != "table" || cfg["telemetry"] != false || cfg["site_url"] != "https://example.test" || len(cfg) != 3 {
		t.Errorf("config.json: %v", cfg)
	}
	for _, want := range []string{"Saved format table, telemetry off to ", "Installing 2 tools...", "Next:\n  ot playbook username-investigation u:johndoe\n"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("stdout lacks %q:\n%s", want, out)
		}
	}

	// Again, back to the defaults: nothing to install, and the keys go rather than being set to the defaults.
	out.Reset()
	if code := run(a, "start", "--playbooks", "username-investigation", "--format", "json", "--telemetry", "on", "--yes", "--json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var rep startReport
	if err := json.Unmarshal(out.Bytes(), &rep); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(rep.Install) != 0 || len(rep.AlreadyInstalled) != 2 || rep.ConfigChanges["format"] != nil || len(rep.ConfigChanges) != 2 {
		t.Errorf("report: %+v", rep)
	}
	if rep.Command != "ot start --playbooks username-investigation --yes" {
		t.Errorf("command: %s", rep.Command)
	}
	if cfg := readConfigFile(t); len(cfg) != 1 || cfg["site_url"] != "https://example.test" {
		t.Errorf("config.json: %v", cfg)
	}
}

// Nothing prompts without a terminal, and --json is only for --yes and --dry-run.
func TestStartNeedsYesWithoutATerminal(t *testing.T) {
	a, _, errb := newTestApp(t, &fakeExec{}, "")
	if code := run(a, "start", "--json"); code != ExitUsage {
		t.Fatalf("--json alone: exit %d", code)
	}
	if e := readJSONError(t, errb); e.Code != "input_required" || !strings.Contains(e.Message, "--yes or --dry-run") {
		t.Errorf("--json alone: %+v", e)
	}
	errb.Reset()
	t.Setenv("OT_NONINTERACTIVE", "1")
	if code := run(a, "start", "--tools", "osintverse-community/sherlock", "--format", "json"); code != ExitUsage {
		t.Fatalf("no terminal: exit %d", code)
	}
	// --format is the setting here, not this command's output, so the error stays text.
	if !strings.HasPrefix(errb.String(), "error: `ot start` asks what to install") || !strings.Contains(errb.String(), "pass --yes") {
		t.Errorf("no terminal: %s", errb)
	}
	if st, _ := state.Load(); len(st.Installed) != 0 {
		t.Fatalf("installed: %v", st.Installed)
	}
}

// Bad flags change nothing.
func TestStartChecksFlags(t *testing.T) {
	a, _, errb := newTestApp(t, &fakeExec{}, "")
	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"--playbooks", "people"}, `no bundled playbook "people"`},
		{[]string{"--agents", "emacs"}, `unknown AI client "emacs"`},
		{[]string{"--format", "jsonl"}, `unknown format "jsonl"`},
		{[]string{"--telemetry", "maybe"}, "--telemetry is on or off"},
		{[]string{"--registry", "ftp://example.com"}, "the registry is a URL"},
		{[]string{"--tools", "osintverse-community/sherlock@1.0.0"}, "installs latest versions"},
		{[]string{"--tools", "sherlock"}, "is not a package"},
	} {
		errb.Reset()
		args := append([]string{"start", "--yes", "--format", "table"}, c.args...)
		if code := run(a, args...); code != ExitUsage || !strings.Contains(errb.String(), c.want) {
			t.Errorf("%v: exit %d: %s", c.args, code, errb)
		}
	}
	if _, err := os.Stat(state.Path("config.json")); err == nil {
		t.Error("config.json was written")
	}
}

// --dry-run says what the flags would do and changes nothing.
func TestStartDryRun(t *testing.T) {
	t.Chdir(t.TempDir())
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	if code := run(a, "start", "--playbooks", "domain-recon", "--agents", "vscode", "--results-dir", "./results",
		"--registry", "http://127.0.0.1:8787", "--dry-run", "--json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var rep startReport
	if err := json.Unmarshal(out.Bytes(), &rep); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if !rep.DryRun || strings.Join(rep.Install, " ") != "osintverse-community/dnstwist osintverse-community/crtsh-subdomains" ||
		len(rep.Agents) != 1 || rep.Agents[0].Status != "planned" || rep.ConfigChanges["api_url"] != "http://127.0.0.1:8787/v1" ||
		len(rep.ConfigChanges) != 1 {
		t.Errorf("report: %+v", rep)
	}
	if rep.Command != "ot start --playbooks domain-recon --agents vscode --registry http://127.0.0.1:8787/v1 --yes" {
		t.Errorf("command: %s", rep.Command)
	}
	if _, err := os.Stat(state.Path("config.json")); err == nil {
		t.Error("config.json was written")
	}
	if _, err := os.Stat(".vscode"); err == nil {
		t.Error(".vscode was written")
	}

	out.Reset()
	if code := run(a, "start", "--tools", "osintverse-community/sherlock", "--dry-run"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	for _, want := range []string{"ot start would:\n", "  Install 1 tool: osintverse-community/sherlock\n", "  Keep the settings as they are\n",
		"  ot start --tools osintverse-community/sherlock --yes\n"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("stdout lacks %q:\n%s", want, out)
		}
	}
}

// At a terminal the wizard decides, starting from the flags; what it chose is applied.
func TestStartWizard(t *testing.T) {
	srv := fakeStartRegistry(t) // reads the fixtures, so before the folder changes
	t.Chdir(t.TempDir())
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	var seen *startCatalog
	a.StartWizard = func(ctx context.Context, cat *startCatalog, c *startChoices) error {
		seen = cat
		if strings.Join(c.Playbooks, ",") != "username-investigation" {
			t.Errorf("not pre-filled from the flags: %+v", c)
		}
		// Every pack tool picked but the deprecated one: the pack goes, sherlock is named on its own.
		c.pick([]string{"osintverse-community/sherlock"}, c.Playbooks, cat)
		c.Format, c.Agents = "csv", []string{"vscode"}
		return nil
	}
	if code := run(a, "start", "--playbooks", "username-investigation"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if seen == nil || len(seen.Tools) != 2 || len(seen.Playbooks) != 5 || seen.Engine != "" {
		t.Fatalf("catalog: %+v", seen)
	}
	st, _ := state.Load()
	if st.Installed["osintverse-community/sherlock"] == nil || len(st.Installed) != 1 {
		t.Fatalf("installed: %v", st.Installed)
	}
	if cfg := readConfigFile(t); cfg["format"] != "csv" {
		t.Errorf("config.json: %v", cfg)
	}
	b, err := os.ReadFile(filepath.Join(".vscode", "mcp.json"))
	if err != nil || !strings.Contains(string(b), `"otinstaller"`) {
		t.Errorf("vscode config: %v %s", err, b)
	}
	if !strings.Contains(out.String(), "Added the otinstaller MCP server to ") || !strings.Contains(out.String(), "  ot mcp policy\n") {
		t.Errorf("stdout: %s", out)
	}

	// Run again, VS Code is already set up; the wizard's list leaves out what is installed.
	out.Reset()
	a.StartWizard = func(ctx context.Context, cat *startCatalog, c *startChoices) error {
		if !cat.Installed["osintverse-community/sherlock"] {
			t.Errorf("installed: %v", cat.Installed)
		}
		c.Agents = []string{"vscode"}
		return nil
	}
	if code := run(a, "start"); code != 0 || !strings.Contains(out.String(), "VS Code already has the otinstaller MCP server.") {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}

	// Cancelled (Ctrl-C) or declined at the review: nothing changes.
	for _, c := range []struct {
		err  error
		code int
	}{{huh.ErrUserAborted, ExitInterrupted}, {errStartDeclined, 0}} {
		a.StartWizard = func(ctx context.Context, cat *startCatalog, ch *startChoices) error {
			ch.Format = "raw"
			return c.err
		}
		if code := run(a, "start"); code != c.code {
			t.Errorf("%v: exit %d", c.err, code)
		}
		if cfg := readConfigFile(t); cfg["format"] != "csv" {
			t.Errorf("%v: config.json: %v", c.err, cfg)
		}
	}
}

func TestStartPickAndCommandLine(t *testing.T) {
	bundled, err := playbook.Bundled()
	if err != nil {
		t.Fatal(err)
	}
	cat := &startCatalog{Playbooks: bundled, Installed: map[string]bool{"osintverse-community/maigret": true}}
	c := &startChoices{}
	// maigret is installed already, so username-investigation stays; domain-recon lost a tool, so it goes.
	c.pick([]string{"osintverse-community/sherlock", "osintverse-community/dnstwist", "osintverse-community/holehe"},
		[]string{"username-investigation", "domain-recon"}, cat)
	if strings.Join(c.Playbooks, ",") != "username-investigation" || strings.Join(c.Tools, ",") != "osintverse-community/dnstwist,osintverse-community/holehe" {
		t.Fatalf("pick: %+v", c)
	}
	c.Agents, c.Format, c.ResultsDir, c.Telemetry, c.Registry, c.Keys = []string{"claude", "cursor"}, "table", `C:\osint runs`, "off", state.DefaultAPIURL, true
	want := "ot start --playbooks username-investigation --tools osintverse-community/dnstwist,osintverse-community/holehe " +
		`--agents claude,cursor --format table --results-dir 'C:\osint runs' --telemetry off --keys --yes`
	if got := startCommandLine(c, true); got != want {
		t.Errorf("command line:\n got %s\nwant %s", got, want)
	}
}

func TestStartConfigChanges(t *testing.T) {
	off := false
	for _, c := range []struct {
		file   state.Config
		choice startChoices
		want   string
	}{
		{state.Config{}, startChoices{Format: "json", ResultsDir: resultsHere, Telemetry: "on", Registry: state.DefaultAPIURL}, ""},
		{state.Config{Format: "table", Telemetry: &off}, startChoices{Format: "json", Telemetry: "on"}, "format back to the default, telemetry back to the default"},
		{state.Config{ResultsDir: "/r"}, startChoices{ResultsDir: "/r"}, ""},
		{state.Config{ResultsDir: "/r"}, startChoices{ResultsDir: resultsHere}, "results_dir back to the default"},
		{state.Config{APIURL: "http://x/v1/"}, startChoices{Registry: "http://x/v1"}, ""},
		{state.Config{}, startChoices{Format: "csv", Telemetry: "off", Registry: "http://x/v1"}, "api_url http://x/v1, format csv, telemetry off"},
	} {
		if got := describeChanges(c.choice.configChanges(&c.file)); got != c.want {
			t.Errorf("%+v over %+v: %q, want %q", c.choice, c.file, got, c.want)
		}
	}
}

// The review note shows paths and config keys as they are, not as huh's markup.
func TestStartNoteText(t *testing.T) {
	if got := noteText(`C:\osint runs, results_dir *x* ` + "`y`"); got != `C:\\osint runs, results\_dir \*x\* \`+"`y\\`" {
		t.Errorf("noteText: %s", got)
	}
}

func TestStartRegistryURL(t *testing.T) {
	for in, want := range map[string]string{
		"http://127.0.0.1:8787":         "http://127.0.0.1:8787/v1",
		"https://reg.example.com/v1/":   "https://reg.example.com/v1",
		"https://reg.example.com/api/x": "https://reg.example.com/api/x",
	} {
		if got, err := registryURL(in); err != nil || got != want {
			t.Errorf("%s: %q %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "example.com", "file:///etc"} {
		if _, err := registryURL(bad); err == nil {
			t.Errorf("%q: no error", bad)
		}
	}
}
