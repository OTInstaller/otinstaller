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

// fakeUpdateRegistry serves dheeraj/holehe-lite at 1.3.0 (1.2.0 yanked) and says dheeraj/gone was removed;
// dheeraj/flagged is at 1.2.0, deprecated, possibly broken, without its source, and moved to dheeraj/fresh.
// Anything else is not in the registry.
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
		case "/v1/tools/dheeraj/holehe-lite":
			json.NewEncoder(w).Encode(map[string]any{"namespace": "dheeraj", "name": "holehe-lite", "latest_version": "1.3.0", "status": "active", "health": "healthy", "manifest": doc})
		case "/v1/tools/dheeraj/holehe-lite/versions":
			json.NewEncoder(w).Encode(map[string]any{"versions": []map[string]any{{"version": "1.3.0", "status": "published"}, {"version": "1.2.0", "status": "yanked"}}})
		case "/v1/tools/dheeraj/holehe-lite/latest/manifest":
			json.NewEncoder(w).Encode(map[string]any{"ref": "dheeraj/holehe-lite", "version": "1.3.0", "status": "published", "manifest": doc})
		case "/v1/tools/dheeraj/flagged":
			json.NewEncoder(w).Encode(map[string]any{"namespace": "dheeraj", "name": "fresh", "latest_version": "1.2.0", "status": "deprecated", "health": "broken",
				"source_unavailable": true, "deprecated_message": "No longer maintained.", "deprecated_replacement": "dheeraj/better", "moved_to": "dheeraj/fresh"})
		case "/v1/tools/dheeraj/flagged/versions":
			json.NewEncoder(w).Encode(map[string]any{"versions": []map[string]any{{"version": "1.2.0", "status": "published"}}})
		case "/v1/tools/dheeraj/gone", "/v1/tools/dheeraj/gone/latest/manifest":
			w.WriteHeader(410)
			w.Write([]byte(`{"error":{"code":"tool_removed","message":"dheeraj/gone was removed from the registry (malware)"}}`))
		default:
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"not_found","message":"not found"}}`))
		}
	}))
}

// Lifecycle flags come with the status, whatever it is, plus a warning each.
func TestOutdatedFlags(t *testing.T) {
	srv := fakeUpdateRegistry(t)
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	for _, path := range []string{
		filepath.Join(fixtures, "valid", "docker-tool.yaml"), // dheeraj/holehe-lite 1.2.0, yanked
		writeVariant(t, "flagged", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"),
	} {
		if code := run(a, "install", path); code != 0 {
			t.Fatalf("install: exit %d: %s", code, errb)
		}
	}
	out.Reset()
	errb.Reset()
	if code := run(a, "outdated", "--json"); code != 0 {
		t.Fatalf("outdated: exit %d: %s", code, errb)
	}
	var list []updateRow
	if err := json.Unmarshal(out.Bytes(), &list); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(list) != 2 || list[0].Ref != "dheeraj/flagged" || list[1].Ref != "dheeraj/holehe-lite" {
		t.Fatalf("rows keep their order: %+v", list)
	}
	if r := list[0]; r.Status != "up to date" || strings.Join(r.Flags, ",") != "deprecated,possibly_broken,source_unavailable,moved" ||
		r.Replacement != "dheeraj/better" || r.Note != "moved to dheeraj/fresh" {
		t.Errorf("flagged: %+v", r)
	}
	if r := list[1]; r.Status != "update available" || strings.Join(r.Flags, ",") != "yanked" {
		t.Errorf("holehe-lite: %+v", r)
	}
	for _, want := range []string{
		"warning: dheeraj/flagged is deprecated: No longer maintained; its publisher suggests dheeraj/better (`ot install dheeraj/better`)",
		"warning: dheeraj/flagged is marked possibly broken by recent health checks",
		"warning: the source repository of dheeraj/flagged is no longer available",
		"warning: dheeraj/flagged has moved to dheeraj/fresh",
		"warning: dheeraj/holehe-lite@1.2.0 was yanked by its publisher; `ot update dheeraj/holehe-lite` installs 1.3.0",
	} {
		if !strings.Contains(errb.String(), want) {
			t.Errorf("stderr lacks %q:\n%s", want, errb)
		}
	}
	// The table shows the flags after the status.
	out.Reset()
	run(a, "outdated")
	if !strings.Contains(out.String(), "update available [yanked]") || !strings.Contains(out.String(), "[deprecated, possibly broken, source unavailable, moved]") {
		t.Errorf("table: %s", out)
	}
	// Updating clears the yanked flag; the version installed now isn't yanked.
	out.Reset()
	errb.Reset()
	if code := run(a, "update", "dheeraj/holehe-lite", "--json"); code != 0 {
		t.Fatalf("update: exit %d: %s", code, errb)
	}
	list = nil
	_ = json.Unmarshal(out.Bytes(), &list)
	if len(list) != 1 || list[0].Status != "updated" || len(list[0].Flags) != 0 || strings.Contains(errb.String(), "yanked") {
		t.Errorf("after update: %+v %s", list, errb)
	}
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
