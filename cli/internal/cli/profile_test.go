package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

const profileJSON = `{"name":"acme","kind":"org","provider":"github","status":"active","display_name":"Acme OSINT","verified":true,"created_at":1790000000000,
"profile":{"bio":"Tools for newsrooms.","location":"Leeds","website":"https://acme.example/","company":null,"socials":[{"provider":"mastodon","url":"https://infosec.exchange/@acme"}],
"hosts":[{"provider":"github","login":"acme","url":"https://github.com/acme","primary":true}],"members":[],"about_html":null,"pins":["whois-plus"],"details_hidden":false,"host_since":null},
"stats":{"packages":2,"tools":1,"guides":1,"installs_30d":120,"installs_total":900,"stars":4,"healthy":1,"broken":0,"last_published_at":1792000000000},
"tools":[{"namespace":"acme","name":"whois-plus","kind":"tool","summary":"WHOIS lookups","latest_version":"1.2.0","installs_30d":120}]}`

func TestProfile(t *testing.T) {
	var patches []map[string]any
	syncs := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		settings := `{"namespace":{"name":"acme","provider":"github","status":"active"},"custom":{},"pins":[],"hide_details":false,
			"sync":{"status":"ok","synced_at":1792000000000},"hosts":[{"provider":"github","login":"acme","url":"https://github.com/acme","primary":true}]}`
		switch {
		case r.Method == "GET" && r.URL.Path == "/v1/namespaces/acme":
			if r.Header.Get("Authorization") != "" {
				t.Error("public profile reads should be anonymous")
			}
			w.Write([]byte(profileJSON))
		case r.Method == "GET" && r.URL.Path == "/v1/me":
			w.Write([]byte(`{"login":"al","namespaces":[{"name":"acme","status":"active","role":"owner"},{"name":"other","status":"active","role":"publisher"}]}`))
		case r.Method == "PATCH" && r.URL.Path == "/v1/me/namespaces/acme/profile":
			var body map[string]any
			b, _ := io.ReadAll(r.Body)
			json.Unmarshal(b, &body)
			patches = append(patches, body)
			w.Write([]byte(settings))
		case r.Method == "POST" && r.URL.Path == "/v1/me/namespaces/acme/profile/sync":
			syncs++
			if syncs > 1 {
				w.WriteHeader(429)
				w.Write([]byte(`{"error":{"code":"profile_sync_rate_limited","message":"at most 10 profile syncs an hour"}}`))
				return
			}
			w.Write([]byte(settings))
		default:
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"namespace_not_found","message":"nobody is not a registry namespace"}}`))
		}
	}))
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")

	// Anyone can read a profile.
	if code := run(a, "profile", "acme"); code != 0 {
		t.Fatalf("show exit %d: %s", code, errb)
	}
	for _, want := range []string{"Acme OSINT (acme)", "Organization, verified publisher", "Tools for newsrooms.", "Website:", "https://acme.example/",
		"Mastodon:", "https://github.com/acme", "2 (1 tools, 1 guides)", "120 in 30 days, 900 in all", "Pinned:", "acme/whois-plus"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("profile lacks %q:\n%s", want, out)
		}
	}
	if code := run(a, "profile", "nobody"); code != ExitUsage {
		t.Errorf("unknown namespace: want %d, got %d", ExitUsage, code)
	}
	// Editing needs a sign-in; so does "my profile".
	if code := run(a, "profile", "acme", "--sync"); code != ExitUsage {
		t.Errorf("signed-out sync: want %d, got %d", ExitUsage, code)
	}
	if code := run(a, "profile"); code != ExitUsage {
		t.Errorf("signed-out, no namespace: want %d, got %d", ExitUsage, code)
	}

	a.API.Token = "ot_t"
	about := filepath.Join(t.TempDir(), "about.md")
	os.WriteFile(about, []byte("# Hi\n"), 0o644)
	out.Reset()
	errb.Reset()
	code := run(a, "profile", "--set", "bio=Newsroom tools", "--set", "socials=https://x.com/acme, https://bsky.app/profile/acme",
		"--set", "pins=whois-plus,dns", "--set", "about=@"+about, "--set", "hide=true", "--unset", "location", "--sync")
	if code != 0 {
		t.Fatalf("edit exit %d: %s", code, errb)
	}
	if len(patches) != 1 {
		t.Fatalf("want one PATCH, got %d", len(patches))
	}
	p := patches[0]
	custom := p["custom"].(map[string]any)
	if custom["bio"] != "Newsroom tools" || custom["location"] != nil || len(custom["socials"].([]any)) != 2 {
		t.Errorf("custom = %v", custom)
	}
	if _, ok := custom["location"]; !ok {
		t.Error("--unset location should send location: null")
	}
	if p["about"] != "# Hi\n" || p["hide_details"] != true || len(p["pins"].([]any)) != 2 {
		t.Errorf("body = %v", p)
	}
	if !strings.Contains(errb.String(), "Saved acme's profile") || !strings.Contains(errb.String(), "Synced acme from GitHub (acme)") {
		t.Errorf("stderr: %s", errb)
	}
	if !strings.Contains(out.String(), "Acme OSINT (acme)") {
		t.Errorf("should show the profile after editing:\n%s", out)
	}
	if code := run(a, "profile", "--sync"); code != ExitUsage || !strings.Contains(errb.String(), "at most 10 profile syncs") {
		t.Errorf("rate limit: exit %d: %s", code, errb)
	}
	if code := run(a, "profile", "acme", "--set", "colour=blue"); code != ExitUsage {
		t.Errorf("unknown key: want %d, got %d", ExitUsage, code)
	}
	if code := run(a, "profile", "acme", "--set", "bio"); code != ExitUsage {
		t.Errorf("no value: want %d, got %d", ExitUsage, code)
	}
	out.Reset()
	if code := run(a, "profile", "acme", "--json"); code != 0 {
		t.Fatalf("json exit %d", code)
	}
	var n api.Namespace
	if err := json.Unmarshal(out.Bytes(), &n); err != nil || n.Stats.InstallsTotal != 900 || n.Profile.Hosts[0].Login != "acme" {
		t.Errorf("json: %v %+v", err, n)
	}
}
