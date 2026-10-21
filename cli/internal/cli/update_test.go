package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// fakeUpdateRegistry serves dheeraj/holehe-lite at 1.3.0 and says dheeraj/gone was removed;
// anything else is not in the registry.
func fakeUpdateRegistry(t *testing.T) *httptest.Server {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := manifest.Parse([]byte(strings.Replace(string(raw), "version: 1.2.0", "version: 1.3.0", 1)))
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/tools/dheeraj/holehe-lite/latest/manifest":
			json.NewEncoder(w).Encode(map[string]any{"ref": "dheeraj/holehe-lite", "version": "1.3.0", "status": "published", "manifest": doc})
		case "/v1/tools/dheeraj/gone/latest/manifest":
			w.WriteHeader(410)
			w.Write([]byte(`{"error":{"code":"tool_removed","message":"dheeraj/gone was removed from the registry (malware)"}}`))
		default:
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"not_found","message":"not found"}}`))
		}
	}))
}

func TestOutdatedAndUpdate(t *testing.T) {
	srv := fakeUpdateRegistry(t)
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	for _, path := range []string{
		filepath.Join(fixtures, "valid", "docker-tool.yaml"), // dheeraj/holehe-lite 1.2.0
		writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"),
		writeVariant(t, "gone", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"),
	} {
		if code := run(a, "install", path); code != 0 {
			t.Fatalf("install: exit %d: %s", code, errb)
		}
	}
	rows := func() map[string]updateRow {
		t.Helper()
		var list []updateRow
		if err := json.Unmarshal(out.Bytes(), &list); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		got := map[string]updateRow{}
		for _, r := range list {
			got[r.Ref] = r
		}
		return got
	}

	out.Reset()
	if code := run(a, "outdated", "--json"); code != 0 {
		t.Fatalf("outdated: exit %d: %s", code, errb)
	}
	got := rows()
	if r := got["dheeraj/holehe-lite"]; r.Status != "update available" || r.Installed != "1.2.0" || r.Latest != "1.3.0" {
		t.Errorf("holehe-lite: %+v", r)
	}
	if r := got["dheeraj/user-a"]; r.Status != "not in registry" {
		t.Errorf("user-a: %+v", r)
	}
	if r := got["dheeraj/gone"]; r.Status != "removed" || !strings.Contains(r.Note, "malware") {
		t.Errorf("gone: %+v", r)
	}
	if st, _ := state.Load(); st.Installed["dheeraj/holehe-lite"].Version != "1.2.0" {
		t.Fatal("outdated must not change anything")
	}

	out.Reset()
	if code := run(a, "update", "dheeraj/holehe-lite", "--json"); code != 0 {
		t.Fatalf("update: exit %d: %s", code, errb)
	}
	if r := rows()["dheeraj/holehe-lite"]; r.Status != "updated" || r.Installed != "1.3.0" || r.Note != "from 1.2.0" {
		t.Errorf("update row: %+v", r)
	}
	if st, _ := state.Load(); st.Installed["dheeraj/holehe-lite"].Version != "1.3.0" {
		t.Fatal("state not updated")
	}

	// --all updates what it can and reports the rest; nothing failed, so exit 0.
	out.Reset()
	if code := run(a, "update", "--all"); code != 0 || !strings.Contains(out.String(), "up to date") || !strings.Contains(out.String(), "not in registry") {
		t.Fatalf("update --all: exit %d: %s %s", code, out, errb)
	}
	// A named package that can't be updated is a failure.
	if code := run(a, "update", "dheeraj/gone"); code != ExitToolError {
		t.Errorf("update removed: exit %d", code)
	}
	for _, args := range [][]string{{"update"}, {"update", "--all", "dheeraj/user-a"}, {"update", "dheeraj/nope"}} {
		if code := run(a, args...); code != ExitUsage {
			t.Errorf("%v: exit %d", args, code)
		}
	}
}

// The registry serves a manifest every released ot accepts plus the full one; ot uses the full one only when its own
// schema accepts it.
func TestRegistryManifestPrefersTheFullOne(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	full, _, err := manifest.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	fullJSON, _ := json.Marshal(full)
	compat := strings.Replace(string(fullJSON), `,"typical_seconds":40`, "", 1)
	if compat == string(fullJSON) {
		t.Fatal("the fixture has no typical_seconds to leave out")
	}
	future := strings.Replace(string(fullJSON), `"notifies_target":false`, `"notifies_target":false,"from_the_future":true`, 1)
	for _, c := range []struct {
		name, full string
		typical    int
	}{
		{"full accepted", string(fullJSON), 40},
		{"full has fields this ot doesn't know", future, 0},
		{"no full", "", 0},
	} {
		resp := &api.ManifestResponse{Manifest: json.RawMessage(compat)}
		if c.full != "" {
			resp.ManifestFull = json.RawMessage(c.full)
		}
		_, m, _, err := registryManifest(resp)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if m.Runtime.TypicalSeconds != c.typical {
			t.Errorf("%s: typical_seconds = %d, want %d", c.name, m.Runtime.TypicalSeconds, c.typical)
		}
	}
}
