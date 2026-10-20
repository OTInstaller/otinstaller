package results

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestSanitize(t *testing.T) {
	for in, want := range map[string]string{
		"JohnDoe":               "johndoe",
		"a@b.com":               "a_b.com",
		"https://example.com/":  "https_example.com",
		"../../etc/passwd":      "etc_passwd",
		"__a  b__":              "a_b",
		"":                      "target",
		"@@@":                   "target",
		strings.Repeat("x", 99): strings.Repeat("x", 80),
	} {
		if got := Sanitize(in); got != want {
			t.Errorf("Sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDir(t *testing.T) {
	t.Setenv("OT_RESULTS_DIR", "")
	t.Setenv("OTINSTALLER_RESULTS_DIR", "")
	if d := Dir(""); d != "results" {
		t.Errorf("default: %q", d)
	}
	t.Setenv("OTINSTALLER_RESULTS_DIR", "legacy")
	if d := Dir(""); d != "legacy" {
		t.Errorf("legacy variable: %q", d)
	}
	t.Setenv("OT_RESULTS_DIR", "env")
	if d := Dir(""); d != "env" {
		t.Errorf("OT_RESULTS_DIR: %q", d)
	}
	if d := Dir("flag"); d != "flag" {
		t.Errorf("flag: %q", d)
	}
}

func TestStartFinish(t *testing.T) {
	dir := t.TempDir()
	rec, err := Start(dir, "sherlock", "JohnDoe", "Demo Case", "json")
	if err != nil {
		t.Fatal(err)
	}
	want := regexp.MustCompile(`cases[/\\]demo_case[/\\]sherlock[/\\]johndoe[/\\]\d{8}-\d{6}_sherlock_johndoe_[0-9a-f]{8}\.json$`)
	if !want.MatchString(rec.OutputPath) {
		t.Fatalf("unexpected output path %s", rec.OutputPath)
	}
	io.WriteString(rec.Stdout(), `{"ok":`)
	io.WriteString(rec.Stdout(), `true}`)
	caseName := "Demo Case"
	meta := &Meta{Tool: "sherlock", Target: "JohnDoe", Case: &caseName, ExitCode: 0, Status: StatusComplete}
	if err := rec.Finish(meta); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(rec.StderrPath); !os.IsNotExist(err) {
		t.Error("an empty stderr file was created")
	}
	sum := sha256.Sum256([]byte(`{"ok":true}`))
	b, err := os.ReadFile(rec.MetaPath)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got["sha256"] != hex.EncodeToString(sum[:]) || got["bytes"] != 11.0 || got["case"] != "Demo Case" || got["status"] != "complete" {
		t.Fatalf("unexpected sidecar: %s", b)
	}
	if got["output_path"] != filepath.ToSlash(rec.OutputPath) {
		t.Errorf("output_path %v", got["output_path"])
	}
	for _, k := range []string{"command", "tool_version", "started_at", "ended_at", "duration_seconds", "exit_code", "entities", "warnings"} {
		if _, ok := got[k]; !ok {
			t.Errorf("sidecar has no %s", k)
		}
	}
}

func TestStderrFileOnlyWhenWritten(t *testing.T) {
	rec, err := Start(t.TempDir(), "tool", "x", "", "text")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(rec.OutputPath, ".txt") {
		t.Errorf("text output saved as %s", rec.OutputPath)
	}
	io.WriteString(rec.Stderr(), "warning: slow\n")
	meta := &Meta{}
	if err := rec.Finish(meta); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(rec.StderrPath); string(b) != "warning: slow\n" || meta.StderrPath == "" {
		t.Fatalf("stderr not saved: %q %q", b, meta.StderrPath)
	}
}
