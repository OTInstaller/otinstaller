package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// changelogRegistry serves holehe-lite with three versions; 1.2.0's notes carry a terminal escape sequence.
func changelogRegistry(t *testing.T) *httptest.Server {
	t.Helper()
	_, m, err := manifest.LoadFile(fixtures + "/valid/docker-tool.yaml")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(m)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/tools/dheeraj/holehe-lite/versions":
			io.WriteString(w, `{"versions":[
				{"version":"1.0.0","status":"removed","published_at":1},
				{"version":"1.2.0","status":"published","published_at":1792000000000,"changelog":"## Fixes\n- Handles rate limits \u001b[31mquietly\u001b[0m\n- Two more sites","changelog_source":"release"},
				{"version":"1.1.0","status":"published","published_at":1790000000000,"changelog":null}]}`)
		case "/v1/tools/dheeraj/holehe-lite":
			json.NewEncoder(w).Encode(map[string]any{"namespace": "dheeraj", "name": "holehe-lite", "latest_version": "1.2.0", "manifest": json.RawMessage(raw)})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestChangelogShowsWhatAnUpdateBrings(t *testing.T) {
	srv := changelogRegistry(t)
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "")

	// Not installed: the latest versions, newest first, without removed ones.
	if code := run(a, "changelog", "dheeraj/holehe-lite"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	s := out.String()
	if !strings.Contains(s, "1.2.0 · 14 Oct 2026\n  ## Fixes\n  - Handles rate limits quietly") || strings.Contains(s, "\x1b") || strings.Contains(s, "1.0.0") {
		t.Fatalf("unexpected notes:\n%q", s)
	}
	if strings.Index(s, "1.2.0") > strings.Index(s, "1.1.0") || !strings.Contains(s, "1.1.0 · ") || !strings.Contains(s, "(no release notes)") {
		t.Fatalf("order or missing notes:\n%s", s)
	}

	// Installed at 1.1.0: only what's newer.
	st, _ := state.Load()
	st.Installed["dheeraj/holehe-lite"] = &state.Installed{Ref: "dheeraj/holehe-lite", Version: "1.1.0", Runtime: "docker", InstalledAt: time.Now()}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	errb.Reset()
	if code := run(a, "changelog", "dheeraj/holehe-lite"); code != 0 || !strings.Contains(errb.String(), "You have 1.1.0") || strings.Contains(out.String(), "1.1.0") {
		t.Fatalf("newer only: exit %d: %s / %s", code, out, errb)
	}
	out.Reset()
	if code := run(a, "changelog", "dheeraj/holehe-lite", "--json"); code != 0 {
		t.Fatalf("json: exit %d", code)
	}
	var j struct {
		Installed string `json:"installed"`
		Versions  []struct {
			Version   string `json:"version"`
			Changelog string `json:"changelog"`
		} `json:"versions"`
	}
	if err := json.Unmarshal(out.Bytes(), &j); err != nil || j.Installed != "1.1.0" || len(j.Versions) != 1 || strings.Contains(j.Versions[0].Changelog, "\x1b") {
		t.Fatalf("json: %v %s", err, out)
	}
	if code := run(a, "changelog", fixtures+"/valid/docker-tool.yaml"); code != ExitUsage {
		t.Fatalf("a local manifest: exit %d", code)
	}
}

func TestInfoShowsWhatsNew(t *testing.T) {
	srv := changelogRegistry(t)
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "")
	if code := run(a, "info", "dheeraj/holehe-lite"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if !strings.Contains(out.String(), "What's new in 1.2.0") || !strings.Contains(out.String(), "`ot changelog dheeraj/holehe-lite`") {
		t.Fatalf("no what's new:\n%s", out)
	}
}
