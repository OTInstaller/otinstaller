package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// keyVariant is the docker-tool fixture renamed, with its HIBP_API_KEY made required.
func keyVariant(t *testing.T, name string) string {
	t.Helper()
	path := writeVariant(t, name, "  - name: email\n    type: email\n    required: true\n", `"{timeout}", "{email}"]`, `{ email: "test@example.com" }`)
	src, _ := os.ReadFile(path)
	s := strings.Replace(string(src), "required: false\n    description: Adds", "required: true\n    description: Adds", 1)
	os.WriteFile(path, []byte(s), 0o644)
	return path
}

func TestInstallOne(t *testing.T) {
	keyring.MockInit()
	t.Setenv("HIBP_API_KEY", "")
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	path := keyVariant(t, "keyed")
	if code := run(a, "install", path); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	for _, want := range []string{"Installed dheeraj/keyed 1.2.0.", "Try it: ot run dheeraj/keyed e:test@example.com",
		"Needs a key: run `ot keys setup dheeraj/keyed` to set HIBP_API_KEY"} {
		if !strings.Contains(errb.String(), want) {
			t.Errorf("stderr lacks %q:\n%s", want, errb)
		}
	}
	if out.Len() != 0 {
		t.Errorf("text mode printed on stdout: %s", out)
	}

	// JSON: the install record, plus the example and the keys still needed.
	out.Reset()
	if code := run(a, "install", path, "--json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var rec map[string]any
	if err := json.Unmarshal(out.Bytes(), &rec); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if rec["ref"] != "dheeraj/keyed" || rec["version"] != "1.2.0" || rec["example"] != "ot run dheeraj/keyed e:test@example.com" {
		t.Errorf("record: %v", rec)
	}
	if mk, _ := rec["missing_keys"].([]any); len(mk) != 1 || mk[0] != "HIBP_API_KEY" {
		t.Errorf("missing_keys: %v", rec["missing_keys"])
	}
	// Set in the environment, the key is no longer missing.
	t.Setenv("HIBP_API_KEY", "x")
	out.Reset()
	errb.Reset()
	run(a, "install", path, "--json")
	if strings.Contains(out.String(), "missing_keys") {
		t.Errorf("key is set: %s", out)
	}
}

func TestInstallMany(t *testing.T) {
	keyring.MockInit()
	t.Setenv("HIBP_API_KEY", "")
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	one := writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}")
	two := keyVariant(t, "keyed")

	// A bad reference anywhere in the list installs nothing.
	if code := run(a, "install", one, "not a ref", two); code != ExitUsage {
		t.Fatalf("bad ref: exit %d", code)
	}
	if st, _ := state.Load(); len(st.Installed) != 0 {
		t.Fatalf("installed before checking every reference: %v", st.Installed)
	}
	if code := run(a, "install"); code != ExitUsage {
		t.Errorf("no package: exit %d", code)
	}

	errb.Reset()
	if code := run(a, "install", one, two); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	for _, want := range []string{"Try them:\n  ot run dheeraj/user-a u:x\n  ot run dheeraj/keyed e:test@example.com\n",
		"Needs a key: run `ot keys setup dheeraj/keyed` to set HIBP_API_KEY"} {
		if !strings.Contains(errb.String(), want) {
			t.Errorf("stderr lacks %q:\n%s", want, errb)
		}
	}

	// JSON lists every package.
	out.Reset()
	if code := run(a, "install", one, two, "--json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var rows []installResult
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(rows) != 2 || rows[0].Ref != "dheeraj/user-a" || rows[0].Status != "installed" || rows[0].Version != "1.2.0" ||
		rows[0].Example != "ot run dheeraj/user-a u:x" || len(rows[0].MissingKeys) != 0 || rows[1].MissingKeys[0] != "HIBP_API_KEY" {
		t.Errorf("rows: %+v", rows)
	}
}

// Installs go on after a failure and exit with the failures' common code, or 1 when they differ; a missing container
// engine stops the rest.
func TestInstallManyFailures(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/tools/alice/gone/") {
			w.WriteHeader(410)
			w.Write([]byte(`{"error":{"code":"tool_removed","message":"alice/gone was removed from the registry (malware)"}}`))
			return
		}
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"code":"not_found","message":"not found"}}`))
	}))
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	good := writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}")

	if code := run(a, "install", "alice/nope", good, "alice/nada"); code != ExitUsage {
		t.Fatalf("two not found: exit %d: %s", code, errb)
	}
	if !strings.Contains(errb.String(), "error: alice/nope: alice/nope not found in the registry") ||
		!strings.Contains(errb.String(), "error: 2 of 3 failed to install: alice/nope, alice/nada") {
		t.Errorf("stderr: %s", errb)
	}
	if st, _ := state.Load(); st.Installed["dheeraj/user-a"] == nil {
		t.Error("the good package was not installed")
	}

	out.Reset()
	errb.Reset()
	if code := run(a, "install", "alice/nope", "alice/gone", "--json"); code != ExitToolError {
		t.Fatalf("different codes: exit %d: %s", code, errb)
	}
	var rows []installResult
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(rows) != 2 || rows[0].Status != "failed" || rows[0].ExitCode != ExitUsage || rows[1].ExitCode != ExitTrust || !strings.Contains(rows[1].Error, "malware") {
		t.Errorf("rows: %+v", rows)
	}
	if e := readJSONError(t, errb); e.Code != "failed" || e.ExitCode != ExitToolError {
		t.Errorf("error: %+v", e)
	}

	// One package: its own error and code, as before.
	errb.Reset()
	if code := run(a, "install", "alice/gone"); code != ExitTrust || !strings.Contains(errb.String(), "error: alice/gone was removed") {
		t.Errorf("one removed: exit %d: %s", code, errb)
	}

	// No Docker: the first install says so, and the rest aren't tried.
	a.Runner.Engine = ""
	out.Reset()
	errb.Reset()
	other := writeVariant(t, "user-b", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}")
	if code := run(a, "install", good, other, "--json"); code != ExitRuntimeMissing {
		t.Fatalf("no engine: exit %d: %s", code, errb)
	}
	rows = nil
	_ = json.Unmarshal(out.Bytes(), &rows)
	if len(rows) != 2 || rows[0].ExitCode != ExitRuntimeMissing || rows[1].Status != "not_tried" {
		t.Errorf("rows: %+v", rows)
	}
	// The install's own progress lines come first; the JSON error is the last line.
	lines := strings.Split(strings.TrimSpace(errb.String()), "\n")
	if last := lines[len(lines)-1]; !strings.Contains(last, `"code":"runtime_missing"`) || !strings.Contains(last, `"exit_code":5`) {
		t.Errorf("error: %s", last)
	}
}

// `ot playbook -y` installs what is missing in one go, and the summary keeps the playbook's order.
func TestPlaybookYesInstallsMissing(t *testing.T) {
	srv := fakeUpdateRegistry(t)
	defer srv.Close()
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"x"}]}`}
	a, out, errb := newTestApp(t, fx, "")
	a.API = api.New(srv.URL+"/v1", "test")
	if code := run(a, "install", writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}")); code != 0 {
		t.Fatalf("install: exit %d: %s", code, errb)
	}
	dir := filepath.Join(os.Getenv("OT_HOME"), "playbooks")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "mixed.yaml"), []byte("tools: [dheeraj/holehe-lite, dheeraj/user-a]\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "broken.yaml"), []byte("tools: [dheeraj/holehe-lite, dheeraj/nope, dheeraj/nada]\n"), 0o644)

	out.Reset()
	if code := run(a, "playbook", "mixed", "e:a@b.com", "u:x", "-y", "--format", "json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var rows []allResult
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(rows) != 2 || rows[0].Tool != "dheeraj/holehe-lite" || rows[0].Version != "1.3.0" || rows[1].Tool != "dheeraj/user-a" {
		t.Fatalf("rows: %+v", rows)
	}

	errb.Reset()
	if code := run(a, "playbook", "broken", "e:a@b.com", "-y"); code != ExitUsage ||
		!strings.Contains(errb.String(), "installing tools for playbook broken: 2 of 2 failed to install: dheeraj/nope, dheeraj/nada") {
		t.Fatalf("exit %d: %s", code, errb)
	}
}

func TestTrustWarningsNameDeprecation(t *testing.T) {
	r := &api.ManifestResponse{Ref: "dheeraj/old", SignerIdentity: "x", Verified: true, Deprecated: true, DeprecatedMessage: "Use the new one", DeprecatedReplacement: "dheeraj/new"}
	w := trustWarnings(r)
	want := "dheeraj/old is deprecated: Use the new one; `ot install dheeraj/new` installs its replacement"
	if len(w) != 1 || w[0] != want {
		t.Errorf("warnings: %q", w)
	}
	r.DeprecatedMessage, r.DeprecatedReplacement = "", ""
	if w := trustWarnings(r); len(w) != 1 || w[0] != "dheeraj/old is deprecated" {
		t.Errorf("warnings without a message: %q", w)
	}
}
