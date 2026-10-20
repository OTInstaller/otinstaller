package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/runner"
)

// savedRuns returns the sidecars under the results directory.
func savedRuns(t *testing.T) []map[string]any {
	t.Helper()
	var out []map[string]any
	filepath.Walk(os.Getenv("OT_RESULTS_DIR"), func(path string, info os.FileInfo, err error) error {
		if err == nil && strings.HasSuffix(path, ".meta.json") {
			b, _ := os.ReadFile(path)
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatalf("%s: %v", path, err)
			}
			out = append(out, m)
		}
		return nil
	})
	return out
}

func lastRunCall(fx *fakeExec) []string {
	var call []string
	for _, c := range fx.calls {
		if len(c) > 1 && c[1] == "run" {
			call = c
		}
	}
	return call
}

func TestParseRunArgsTyped(t *testing.T) {
	ra, err := parseRunArgs([]string{`D:\tools\otinstaller.yaml`, "u:johndoe", "e:a@b.com", "--case", "demo", "--no-save"})
	if err != nil {
		t.Fatal(err)
	}
	if ra.Pkg != `D:\tools\otinstaller.yaml` || len(ra.Typed) != 2 || ra.Typed[0] != (runner.TypedInput{Prefix: "u", Value: "johndoe"}) || ra.Case != "demo" || !ra.NoSave {
		t.Fatalf("unexpected parse: %+v", ra)
	}
	ra, err = parseRunArgs([]string{"u:johndoe", "--all", "--parallel", "2"})
	if err != nil || !ra.All || ra.Pkg != "" || len(ra.Typed) != 1 || ra.Parallel != 2 {
		t.Fatalf("--all parse: %+v %v", ra, err)
	}
	for _, bad := range [][]string{
		{"a/b", "johndoe"},    // a bare second positional
		{"a/b", "u:x", "u:y"}, // the same type twice
		{"a/b", "u:"},         // no value
		{"--all", "u:x", "--parallel", "0"},
	} {
		if _, err := parseRunArgs(bad); err == nil {
			t.Errorf("%v: expected an error", bad)
		}
	}
}

func TestRunTypedInputSavesResults(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"github.com/abc"}]}`}
	a, out, errb := newTestApp(t, fx, "")
	path := filepath.Join(fixtures, "valid", "docker-tool.yaml")
	if code := run(a, "run", path, "e:A@b.com"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if call := lastRunCall(fx); call[len(call)-1] != "A@b.com" {
		t.Fatalf("typed input not passed: %v", call)
	}
	// stdout is still the envelope.
	var env struct{ Entities []any }
	if err := json.Unmarshal(out.Bytes(), &env); err != nil || len(env.Entities) != 1 {
		t.Fatalf("stdout is not the envelope: %s", out)
	}
	runs := savedRuns(t)
	if len(runs) != 1 {
		t.Fatalf("want 1 saved run, got %d", len(runs))
	}
	meta := runs[0]
	outPath, _ := meta["output_path"].(string)
	if meta["target"] != "A@b.com" || meta["status"] != "complete" || meta["ref"] != "dheeraj/holehe-lite" ||
		!strings.Contains(outPath, "/holehe-lite/a_b.com/") || !strings.HasSuffix(outPath, ".json") {
		t.Fatalf("unexpected sidecar: %v", meta)
	}
	if b, _ := os.ReadFile(outPath); string(b) != fx.stdout {
		t.Fatalf("saved output differs from the tool's: %q", b)
	}
	if cmd, _ := meta["command"].([]any); len(cmd) == 0 || cmd[0] != "holehe" || cmd[len(cmd)-1] != "A@b.com" {
		t.Fatalf("command not recorded: %v", meta["command"])
	}
	if !strings.Contains(errb.String(), "Saved "+outPath) {
		t.Fatalf("no Saved line on stderr: %s", errb)
	}
}

func TestRunNoSaveAndResultsDir(t *testing.T) {
	fx := &fakeExec{stdout: `{}`}
	a, _, errb := newTestApp(t, fx, "")
	path := filepath.Join(fixtures, "valid", "docker-tool.yaml")
	if code := run(a, "run", path, "--email", "a@b.com", "--no-save"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if n := len(savedRuns(t)); n != 0 {
		t.Fatalf("--no-save saved %d runs", n)
	}
	dir := filepath.Join(t.TempDir(), "elsewhere")
	if code := run(a, "run", path, "--email", "a@b.com", "--results-dir", dir, "--case", "Op 1"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	matches, _ := filepath.Glob(filepath.Join(dir, "cases", "op_1", "holehe-lite", "a_b.com", "*.meta.json"))
	if len(matches) != 1 {
		t.Fatalf("--results-dir/--case: found %v", matches)
	}
}

func TestRunTypedInputErrors(t *testing.T) {
	a, _, _ := newTestApp(t, &fakeExec{}, "")
	path := filepath.Join(fixtures, "valid", "docker-tool.yaml")
	if code := run(a, "run", path, "u:johndoe"); code != ExitUsage {
		t.Errorf("no username input: want %d, got %d", ExitUsage, code)
	}
	if code := run(a, "run", path, "e:a@b.com", "--email", "c@d.com"); code != ExitUsage {
		t.Errorf("email twice: want %d, got %d", ExitUsage, code)
	}
	if code := run(a, "run", path, "e:nope"); code != ExitUsage {
		t.Errorf("typed values are still checked: want %d, got %d", ExitUsage, code)
	}
}

// writeVariant writes a copy of the docker fixture under a new name with its email input replaced.
func writeVariant(t *testing.T, name, inputs, command, testInput string) string {
	t.Helper()
	src, err := os.ReadFile(filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	s := strings.Replace(string(src), "name: holehe-lite", "name: "+name, 1)
	s = strings.Replace(s, "  - name: email\n    type: email\n    required: true\n", inputs, 1)
	s = strings.Replace(s, `"{timeout}", "{email}"]`, command, 1)
	s = strings.Replace(s, `input: { email: "test@example.com" }`, "input: "+testInput, 1)
	dir := t.TempDir()
	path := filepath.Join(dir, "otinstaller.yaml")
	os.WriteFile(path, []byte(s), 0o644)
	return path
}

func TestRunAll(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"x"}]}`}
	a, out, errb := newTestApp(t, fx, "")
	install := func(path string) {
		t.Helper()
		if code := run(a, "install", path); code != 0 {
			t.Fatalf("install %s: exit %d: %s", path, code, errb)
		}
	}
	install(filepath.Join(fixtures, "valid", "docker-tool.yaml")) // email
	install(writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"))
	install(writeVariant(t, "user-b", "  - name: handle\n    type: username\n    required: true\n", `"{timeout}", "{handle}"]`, "{handle: x}"))
	// Needs a second required input --all can't fill, so it is skipped.
	install(writeVariant(t, "user-c", "  - name: user\n    type: username\n    required: true\n  - name: site\n    type: string\n    required: true\n", `"{timeout}", "{site}", "{user}"]`, "{user: x, site: y}"))
	// No username or email input: not listed at all.
	install(writeVariant(t, "phone-only", "  - name: number\n    type: phone\n    required: true\n", `"{timeout}", "{number}"]`, "{number: x}"))
	out.Reset()

	code := run(a, "run", "--all", "u:johndoe", "e:a@b.com", "--format", "json", "--parallel", "2")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var rows []allResult
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	got := map[string]allResult{}
	for _, r := range rows {
		got[r.Tool] = r
	}
	if len(rows) != 4 {
		t.Fatalf("want 4 rows, got %+v", rows)
	}
	for _, name := range []string{"dheeraj/holehe-lite", "dheeraj/user-a", "dheeraj/user-b"} {
		r := got[name]
		if r.Status != "complete" || r.Entities != 1 || r.OutputPath == "" || r.MetaPath == "" {
			t.Errorf("%s: %+v", name, r)
		}
		if _, err := os.Stat(r.MetaPath); err != nil {
			t.Errorf("%s: sidecar missing: %v", name, err)
		}
	}
	if !strings.Contains(got["dheeraj/user-a"].OutputPath, "/user-a/johndoe/") || !strings.Contains(got["dheeraj/holehe-lite"].OutputPath, "/holehe-lite/a_b.com/") {
		t.Errorf("targets: %s, %s", got["dheeraj/user-a"].OutputPath, got["dheeraj/holehe-lite"].OutputPath)
	}
	if r := got["dheeraj/user-c"]; r.Status != "skipped" || !strings.Contains(r.Reason, "--site") {
		t.Errorf("user-c should be skipped for --site: %+v", r)
	}
	var argsSeen []string
	for _, c := range fx.calls {
		if len(c) > 1 && c[1] == "run" {
			argsSeen = append(argsSeen, c[len(c)-1])
		}
	}
	if len(argsSeen) != 3 {
		t.Errorf("want 3 tool runs, got %v", argsSeen)
	}

	// The table summary, and the errors.
	out.Reset()
	if code := run(a, "run", "--all", "u:johndoe"); code != 0 || !strings.Contains(out.String(), "dheeraj/user-a") || strings.Contains(out.String(), "holehe-lite") {
		t.Errorf("table: exit %d\n%s", code, out)
	}
	if code := run(a, "run", "--all", "url:https://example.com"); code != ExitUsage {
		t.Errorf("no tool with a url input: want %d, got %d", ExitUsage, code)
	}
	if code := run(a, "run", "--all"); code != ExitUsage {
		t.Errorf("no typed input: want %d, got %d", ExitUsage, code)
	}
	if code := run(a, "run", "--all", "u:x", "--no-save"); code != ExitUsage {
		t.Errorf("--no-save: want %d, got %d", ExitUsage, code)
	}
}

func TestRunInterruptedKeepsPartialOutput(t *testing.T) {
	fx := &fakeExec{stdout: `{"partial":`}
	a, _, errb := newTestApp(t, fx, "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	root := a.Root()
	root.SetArgs([]string{"run", filepath.Join(fixtures, "valid", "docker-tool.yaml"), "e:a@b.com"})
	err := root.ExecuteContext(ctx)
	if code := ExitCodeFor(err); code != ExitInterrupted {
		t.Fatalf("want exit %d, got %d (%v) %s", ExitInterrupted, code, err, errb)
	}
	runs := savedRuns(t)
	if len(runs) != 1 || runs[0]["status"] != "interrupted" || runs[0]["exit_code"] != -1.0 || runs[0]["bytes"] != float64(len(fx.stdout)) {
		t.Fatalf("unexpected sidecar: %v", runs)
	}
}
