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
