package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// fakeStarterRegistry serves the username-investigation playbook's tools: sherlock, healthy, and maigret, deprecated.
func fakeStarterRegistry(t *testing.T) *httptest.Server {
	t.Helper()
	docs := map[string]any{}
	for _, name := range []string{"sherlock", "maigret"} {
		path := writeVariant(t, name, "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}")
		raw, _ := os.ReadFile(path)
		doc, _, err := manifest.Parse([]byte(strings.Replace(string(raw), "namespace: dheeraj", "namespace: osintverse-community", 1)))
		if err != nil {
			t.Fatal(err)
		}
		docs[name] = doc
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rest, ok := strings.CutPrefix(r.URL.Path, "/v1/tools/osintverse-community/")
		name, sub, _ := strings.Cut(rest, "/")
		if !ok || docs[name] == nil {
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"not_found","message":"not found"}}`))
			return
		}
		ref := "osintverse-community/" + name
		switch sub {
		case "":
			status := map[bool]string{true: "deprecated", false: "active"}[name == "maigret"]
			json.NewEncoder(w).Encode(map[string]any{"namespace": "osintverse-community", "name": name, "kind": "tool", "summary": "Finds " + name + " accounts",
				"latest_version": "1.2.0", "inputs": []string{"username"}, "status": status, "health": "healthy", "manifest": docs[name]})
		case "latest/manifest":
			json.NewEncoder(w).Encode(map[string]any{"ref": ref, "version": "1.2.0", "status": "published", "manifest": docs[name]})
		default:
			w.WriteHeader(404)
		}
	}))
}

// On a fresh machine, at a terminal, ot auto offers the starter playbook's tools and runs once they are installed.
func TestFreshMachineOffersStarters(t *testing.T) {
	srv := fakeStarterRegistry(t)
	defer srv.Close()
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"x"}]}`}
	a, out, errb := newTestApp(t, fx, "n\n")
	a.API = api.New(srv.URL+"/v1", "test")

	// No: nothing is installed, and the error says how to do it later.
	if code := run(a, "auto", "johndoe"); code != ExitUsage {
		t.Fatalf("declined: exit %d: %s", code, errb)
	}
	for _, want := range []string{"No installed tool takes a username. The bundled username-investigation playbook has some:",
		"  osintverse-community/sherlock 1.2.0: Finds sherlock accounts (", "note: leaving out osintverse-community/maigret: it is deprecated",
		"Install 1 tool and run? [y/N]", "ot playbook username-investigation u:johndoe --yes"} {
		if !strings.Contains(errb.String(), want) {
			t.Errorf("stderr lacks %q:\n%s", want, errb)
		}
	}
	if st, _ := state.Load(); len(st.Installed) != 0 {
		t.Fatalf("installed after a no: %v", st.Installed)
	}

	// A dry run never offers.
	errb.Reset()
	a.In = strings.NewReader("y\n")
	if code := run(a, "auto", "johndoe", "--dry-run"); code != ExitUsage || strings.Contains(errb.String(), "Install") {
		t.Fatalf("dry run: exit %d: %s", code, errb)
	}

	// Yes: sherlock is installed (maigret left out), then the run goes ahead.
	errb.Reset()
	out.Reset()
	a.In = strings.NewReader("y\n")
	if code := run(a, "auto", "johndoe", "--format", "json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var rows []allResult
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(rows) != 1 || rows[0].Tool != "osintverse-community/sherlock" || rows[0].Status != "complete" {
		t.Fatalf("rows: %+v", rows)
	}
	if st, _ := state.Load(); st.Installed["osintverse-community/sherlock"] == nil || st.Installed["osintverse-community/maigret"] != nil {
		t.Fatalf("installed: %v", st.Installed)
	}
}

// Without a terminal nothing is installed: not_installed, with the command that would install and run.
func TestFreshMachineWithoutTerminal(t *testing.T) {
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	t.Setenv("OT_NONINTERACTIVE", "1")
	for _, c := range []struct {
		args       []string
		hint       string
		targetType string
	}{
		{[]string{"run", "--all", "u:johndoe", "--json"}, "`ot playbook username-investigation u:johndoe --yes`", "username"},
		{[]string{"auto", "jane@example.com", "--json"}, "`ot playbook email-investigation e:jane@example.com --yes`", "email"},
		{[]string{"auto", "https://example.com/a b", "--json"}, "`ot search --input url`", "url"},
	} {
		out.Reset()
		errb.Reset()
		if code := run(a, c.args...); code != ExitUsage {
			t.Fatalf("%v: exit %d: %s", c.args, code, errb)
		}
		e := readJSONError(t, errb)
		if e.Code != "not_installed" || e.Message != "no installed tool has "+withArticle(c.targetType)+" input" || !strings.Contains(e.Hint, c.hint) {
			t.Errorf("%v: %+v", c.args, e)
		}
		if out.Len() != 0 {
			t.Errorf("%v: stdout: %s", c.args, out)
		}
	}
}

// `ot playbook` without --yes asks at a terminal, and installs only what the person agreed to.
func TestPlaybookAsksAtATerminal(t *testing.T) {
	srv := fakeStarterRegistry(t)
	defer srv.Close()
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"x"}]}`}
	a, out, errb := newTestApp(t, fx, "y\n")
	a.API = api.New(srv.URL+"/v1", "test")
	if code := run(a, "playbook", "username-investigation", "u:johndoe", "--format", "json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if !strings.Contains(errb.String(), "Playbook username-investigation needs tools that are not installed:") || !strings.Contains(errb.String(), "Install 1 tool and run? [y/N]") {
		t.Errorf("stderr: %s", errb)
	}
	var rows []allResult
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil || len(rows) != 1 || rows[0].Tool != "osintverse-community/sherlock" {
		t.Fatalf("rows: %v %s", err, out)
	}
}

// Agents are never offered installs: run_all says what to install with install_tool.
func TestMCPRunAllWithNothingInstalled(t *testing.T) {
	h := newMCP(t, "", "", nil)
	_, e := h.call("run_all", map[string]any{"target": "johndoe"})
	if e == nil || e["code"] != "not_installed" || !strings.Contains(e["hint"].(string), "install_tool") {
		t.Fatalf("run_all: %v", e)
	}
	if tools, _ := e["suggested_tools"].([]any); len(tools) != 2 || tools[0] != "osintverse-community/sherlock" {
		t.Errorf("suggested_tools: %v", e["suggested_tools"])
	}
	if st, _ := state.Load(); len(st.Installed) != 0 {
		t.Fatalf("installed: %v", st.Installed)
	}
}
