package cli

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/selfupdate"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// Installing an exact version holds it: `ot update --all` leaves it, and naming the package moves it on.
func TestHolds(t *testing.T) {
	srv := fakeUpdateRegistry(t)
	defer srv.Close()
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	held := func() (string, bool) {
		t.Helper()
		st, _ := state.Load()
		i := st.Installed["dheeraj/holehe-lite"]
		return i.Version, i.Held
	}

	if code := run(a, "install", "dheeraj/holehe-lite@1.2.0"); code != 0 {
		t.Fatalf("install: exit %d: %s", code, errb)
	}
	if v, h := held(); v != "1.2.0" || !h || !strings.Contains(errb.String(), "note: holding dheeraj/holehe-lite at 1.2.0") {
		t.Fatalf("exact install: %s %v: %s", v, h, errb)
	}

	out.Reset()
	errb.Reset()
	run(a, "outdated", "--json")
	var rows []updateRow
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if r := rows[0]; r.Status != "update available" || strings.Join(r.Flags, ",") != "yanked,held" {
		t.Errorf("outdated: %+v", r)
	}
	if !strings.Contains(errb.String(), "note: dheeraj/holehe-lite is held at 1.2.0; `ot update dheeraj/holehe-lite` moves it to 1.3.0") {
		t.Errorf("no held note: %s", errb)
	}

	out.Reset()
	if code := run(a, "update", "--all", "--json"); code != 0 {
		t.Fatalf("update --all: exit %d: %s", code, errb)
	}
	if v, h := held(); v != "1.2.0" || !h {
		t.Fatalf("--all moved a held package: %s %v", v, h)
	}

	out.Reset()
	run(a, "list")
	if !strings.Contains(out.String(), "1.2.0 (held)") {
		t.Errorf("list: %s", out)
	}
	out.Reset()
	run(a, "list", "--json")
	if !strings.Contains(out.String(), `"held": true`) {
		t.Errorf("list --json: %s", out)
	}

	// Naming it updates it and releases the hold.
	errb.Reset()
	if code := run(a, "update", "dheeraj/holehe-lite"); code != 0 {
		t.Fatalf("update: exit %d: %s", code, errb)
	}
	if v, h := held(); v != "1.3.0" || h || !strings.Contains(errb.String(), "is no longer held") {
		t.Fatalf("named update: %s %v: %s", v, h, errb)
	}

	// Held at the latest version, naming it releases the hold without installing anything.
	run(a, "install", "dheeraj/holehe-lite@1.3.0")
	if _, h := held(); !h {
		t.Fatal("an exact install of the latest version is held too")
	}
	errb.Reset()
	if code := run(a, "update", "dheeraj/holehe-lite"); code != 0 {
		t.Fatalf("update: exit %d: %s", code, errb)
	}
	if v, h := held(); v != "1.3.0" || h || strings.Contains(errb.String(), "Installing") {
		t.Fatalf("release without reinstall: %s %v: %s", v, h, errb)
	}

	// Installing without a version releases it too.
	run(a, "install", "dheeraj/holehe-lite@1.2.0")
	errb.Reset()
	run(a, "install", "dheeraj/holehe-lite")
	if v, h := held(); v != "1.3.0" || h {
		t.Fatalf("plain install: %s %v", v, h)
	}
}

// The daily note: once a day, at a terminal, after the command's output, never in CI, under JSON or when switched off.
func TestDailyUpdateNote(t *testing.T) {
	asked := 0
	inner := fakeUpdateHandler(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/latest" {
			asked++
		}
		inner.ServeHTTP(w, r)
	}))
	defer srv.Close()
	otSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"version":"v1.1.0"}`))
	}))
	defer otSrv.Close()
	old := Version
	defer func() { Version = old }()
	Version = "v1.0.0"
	t.Setenv("CI", "")
	t.Setenv("OT_NO_UPDATE_CHECK", "")

	a, out, errb := newTestApp(t, &fakeExec{}, "")
	a.API = api.New(srv.URL+"/v1", "test")
	a.Updater = &selfupdate.Updater{HTTP: otSrv.Client(), API: "http://127.0.0.1:9", LatestURL: otSrv.URL, Downloads: otSrv.URL}
	if code := run(a, "install", "dheeraj/holehe-lite@1.2.0"); code != 0 {
		t.Fatalf("install: exit %d: %s", code, errb)
	}
	a.CheckUpdates = true
	const pkgNote = "note: 1 installed package has a newer version (held at the version you chose); `ot outdated` lists it, `ot update <name>` moves one"
	const otNote = "note: ot v1.1.0 is out (you have v1.0.0); `ot self-update` installs it"
	resetNote := func() {
		c := readLatestCache()
		c.NotedAt = time.Time{}
		c.save()
	}

	for _, c := range []struct {
		name string
		args []string
		env  string
		want bool
	}{
		{"CI", []string{"list"}, "CI", false},
		{"switched off", []string{"list"}, "OT_NO_UPDATE_CHECK", false},
		{"do not track", []string{"list"}, "DO_NOT_TRACK", false},
		{"JSON", []string{"list", "--json"}, "", false},
		{"JSON from the environment", []string{"list"}, "OT_OUTPUT", false},
		{"ot run's own --json", []string{"run", "dheeraj/nope", "--json"}, "", false},
		{"quiet command", []string{"outdated"}, "", false},
		{"completion", []string{"__complete", "inst"}, "", false},
		{"a person at a terminal", []string{"list"}, "", true},
	} {
		if c.env == "OT_OUTPUT" {
			t.Setenv(c.env, "json")
		} else if c.env != "" {
			t.Setenv(c.env, "1")
		}
		out.Reset()
		errb.Reset()
		run(a, c.args...)
		if got := strings.Contains(errb.String(), pkgNote); got != c.want {
			t.Errorf("%s: note %v, want %v: %s", c.name, got, c.want, errb)
		}
		if c.want && !strings.Contains(errb.String(), otNote) {
			t.Errorf("%s: no ot note: %s", c.name, errb)
		}
		if c.env != "" {
			t.Setenv(c.env, "")
		}
	}
	if asked != 1 {
		t.Errorf("the list was fetched %d times, want once", asked)
	}

	// Once a day: the next command says nothing, and doesn't ask again.
	errb.Reset()
	run(a, "list")
	if strings.Contains(errb.String(), "note:") || asked != 1 {
		t.Errorf("second command: asked %d: %s", asked, errb)
	}

	// An agent's session never gets it.
	resetNote()
	a.AgentMode = true
	errb.Reset()
	run(a, "list")
	a.AgentMode = false
	if strings.Contains(errb.String(), "note:") {
		t.Errorf("agent: %s", errb)
	}

	// A day-old list is fetched again; when the registry can't be reached, the old list is kept and it isn't asked
	// again that day.
	c := readLatestCache()
	c.CheckedAt, c.NotedAt = time.Now().Add(-25*time.Hour), time.Time{}
	c.save()
	a.API = api.New("http://127.0.0.1:9/v1", "test")
	errb.Reset()
	run(a, "list")
	if !strings.Contains(errb.String(), pkgNote) {
		t.Errorf("offline, the cached list still counts: %s", errb)
	}
	if c := readLatestCache(); time.Since(c.CheckedAt) > time.Minute || len(c.Packages) == 0 {
		t.Errorf("offline attempt: %+v", c)
	}
	if b, _ := os.ReadFile(state.Path("cache", "latest.json")); !strings.Contains(string(b), "dheeraj/holehe-lite") {
		t.Errorf("cache lost the list: %s", b)
	}

	// Nothing newer, nothing said.
	st, _ := state.Load()
	st.Installed["dheeraj/holehe-lite"].Version = "1.3.0"
	st.Save()
	resetNote()
	Version = "v1.1.0"
	errb.Reset()
	run(a, "list")
	if strings.Contains(errb.String(), "note:") {
		t.Errorf("up to date: %s", errb)
	}
}

func TestUpdatesNote(t *testing.T) {
	for _, c := range []struct {
		updates, held int
		want          string
	}{
		{3, 0, "3 installed packages have newer versions; `ot outdated` lists them, `ot update --all` installs them"},
		{3, 1, "3 installed packages have newer versions (1 held); `ot outdated` lists them, `ot update --all` installs the rest"},
		{1, 0, "1 installed package has a newer version; `ot outdated` lists it, `ot update --all` installs it"},
	} {
		if got := updatesNote(c.updates, c.held); got != c.want {
			t.Errorf("%d/%d: %q", c.updates, c.held, got)
		}
	}
}

// A package that moved counts as an update, found by its old name.
func TestLatestCacheCountsMoves(t *testing.T) {
	c := &latestCache{Packages: []api.LatestPackage{{Ref: "a/b", Latest: "1.0.0"}}, Moved: []api.Move{{From: "a/old", To: "a/b"}}}
	st := &state.State{Installed: map[string]*state.Installed{
		"a/b":   {Ref: "a/b", Version: "1.0.0"},
		"a/old": {Ref: "a/old", Version: "1.0.0", Held: true},
		"x/y":   {Ref: "x/y", Version: "0.1.0"},
	}}
	if u, h := updateCounts(st, c); u != 1 || h != 1 {
		t.Errorf("counts: %d %d", u, h)
	}
}
