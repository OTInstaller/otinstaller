package state

import (
	"os"
	"strings"
	"testing"
)

// SetConfig changes only the keys it is given; FileConfig reads the file without environment overrides.
func TestSetConfig(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	t.Setenv("OT_API_URL", "http://env.example/v1")
	if err := os.WriteFile(Path("config.json"), []byte(`{"site_url": "https://s.example", "unknown": [1], "format": "csv"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := SetConfig(map[string]any{"format": nil, "results_dir": "/r", "telemetry": false}); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(Path("config.json"))
	for _, want := range []string{`"site_url": "https://s.example"`, `"unknown": [`, `"results_dir": "/r"`, `"telemetry": false`} {
		if !strings.Contains(string(b), want) {
			t.Errorf("config.json lacks %s:\n%s", want, b)
		}
	}
	if strings.Contains(string(b), "format") || strings.Contains(string(b), "env.example") {
		t.Errorf("config.json:\n%s", b)
	}
	if f := FileConfig(); f.APIURL != "" || f.ResultsDir != "/r" || f.Telemetry == nil || *f.Telemetry {
		t.Errorf("FileConfig: %+v", f)
	}
	if c := LoadConfig(); c.APIURL != "http://env.example/v1" || c.TelemetryEnabled() {
		t.Errorf("LoadConfig: %+v", c)
	}

	// A file that isn't JSON is left alone.
	os.WriteFile(Path("config.json"), []byte("{oops"), 0o600)
	if err := SetConfig(map[string]any{"format": "table"}); err == nil {
		t.Error("rewrote a broken config.json")
	}
	if b, _ := os.ReadFile(Path("config.json")); string(b) != "{oops" {
		t.Errorf("config.json: %s", b)
	}
}

// OT_NO_TELEMETRY (any value) and DO_NOT_TRACK (but 0 or false) turn telemetry off, over config.json.
func TestTelemetryOffByEnv(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	for _, c := range []struct {
		noTelemetry, doNotTrack string
		off                     bool
		source                  string
	}{
		{"", "", false, ""},
		{"0", "", true, "OT_NO_TELEMETRY"},
		{"", "1", true, "DO_NOT_TRACK"},
		{"", " TRUE ", true, "DO_NOT_TRACK"},
		{"", "0", false, ""},
		{"", "False", false, ""},
		{"1", "1", true, "OT_NO_TELEMETRY"},
	} {
		t.Setenv("OT_NO_TELEMETRY", c.noTelemetry)
		t.Setenv("DO_NOT_TRACK", c.doNotTrack)
		off, source := TelemetryOffByEnv()
		if off != c.off || source != c.source || LoadConfig().TelemetryEnabled() == c.off {
			t.Errorf("%q %q: %v %q", c.noTelemetry, c.doNotTrack, off, source)
		}
	}
}

// telemetry.json starts with every milestone reached on a machine that has packages installed, and is written
// atomically, leaving no temporary file.
func TestLoadTelemetry(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	if tel := LoadTelemetry(); len(tel.Milestones) != 0 {
		t.Fatalf("a new machine: %+v", tel)
	}
	tel := LoadTelemetry()
	tel.Milestones = append(tel.Milestones, "first_run")
	if err := tel.Save(); err != nil {
		t.Fatal(err)
	}
	if got := LoadTelemetry(); !got.Reached("first_run") || got.Reached("first_install") {
		t.Errorf("read back: %+v", got)
	}

	t.Setenv("OT_HOME", t.TempDir())
	st, _ := Load()
	st.Installed["a/b"] = &Installed{Ref: "a/b", Version: "1.0.0"}
	if err := st.Save(); err != nil {
		t.Fatal(err)
	}
	if tel := LoadTelemetry(); strings.Join(tel.Milestones, ",") != strings.Join(Milestones, ",") {
		t.Errorf("an upgraded machine: %+v", tel)
	}
	entries, _ := os.ReadDir(Home())
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("left %s behind", e.Name())
		}
	}
	// A broken file is replaced, as for an upgraded machine.
	os.WriteFile(Path("telemetry.json"), []byte("{oops"), 0o600)
	if tel := LoadTelemetry(); len(tel.Milestones) != 3 {
		t.Errorf("broken file: %+v", tel)
	}
}
