package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/results"
)

func TestRunsCommand(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"github.com/jd"}]}`}
	a, out, errb := newTestApp(t, fx, "")
	if code := run(a, "runs"); code != 0 || !strings.Contains(out.String(), "No saved runs from the last 7 days under ") {
		t.Fatalf("no runs: exit %d: %s %s", code, out, errb)
	}
	for _, p := range []string{
		writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"),
		writeVariant(t, "user-b", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"),
	} {
		if code := run(a, "install", p); code != 0 {
			t.Fatalf("install: %s", errb)
		}
	}
	for _, args := range [][]string{
		{"run", "dheeraj/user-a", "u:jd"},
		{"run", "dheeraj/user-b", "u:jd"},
		{"run", "dheeraj/user-a", "u:other", "--case", "work"},
	} {
		if code := run(a, args...); code != 0 {
			t.Fatalf("%v: %s", args, errb)
		}
	}
	list := func(args ...string) []runSummary {
		t.Helper()
		out.Reset()
		if code := run(a, append([]string{"runs", "--json"}, args...)...); code != 0 {
			t.Fatalf("runs %v: exit %d: %s", args, code, errb)
		}
		var rs []runSummary
		if err := json.Unmarshal(out.Bytes(), &rs); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		return rs
	}
	all := list()
	if len(all) != 3 || all[0].Target != "other" || all[0].Case != "work" || all[2].Tool != "dheeraj/user-a" || all[2].Target != "jd" {
		t.Fatalf("newest first: %+v", all)
	}
	for _, c := range []struct {
		args []string
		want int
	}{
		{[]string{"--tool", "user-a"}, 2},
		{[]string{"--tool", "dheeraj/user-b"}, 1},
		{[]string{"--target", "jd"}, 2},
		{[]string{"--case", "work"}, 1},
		{[]string{"--status", "failed"}, 0},
		{[]string{"--limit", "1"}, 1},
	} {
		if got := list(c.args...); len(got) != c.want {
			t.Errorf("%v: %d runs, want %d", c.args, len(got), c.want)
		}
	}

	// A run started long ago is left out unless --since says otherwise.
	old := filepath.Join(os.Getenv("OT_RESULTS_DIR"), "user-b")
	metas, _ := filepath.Glob(filepath.Join(old, "*", "*.meta.json"))
	if len(metas) != 1 {
		t.Fatalf("meta files: %v", metas)
	}
	b, _ := os.ReadFile(metas[0])
	var m map[string]any
	json.Unmarshal(b, &m)
	m["started_at"] = time.Now().Add(-30 * 24 * time.Hour).UTC().Format(time.RFC3339)
	b, _ = json.Marshal(m)
	os.WriteFile(metas[0], b, 0o644)
	if got := list(); len(got) != 2 {
		t.Errorf("default --since: %d runs", len(got))
	}
	if got := list("--since", "0"); len(got) != 3 {
		t.Errorf("--since 0: %d runs", len(got))
	}

	// The table, and one run in detail.
	out.Reset()
	errb.Reset()
	if code := run(a, "runs"); code != 0 || !strings.Contains(out.String(), "RUN") || !strings.Contains(errb.String(), "`ot runs <run-id>` shows a run") {
		t.Fatalf("table: exit %d: %s %s", code, out, errb)
	}
	id := all[0].RunID
	out.Reset()
	if code := run(a, "runs", id); code != 0 {
		t.Fatalf("show: exit %d: %s", code, errb)
	}
	for _, want := range []string{"Run " + id + ": dheeraj/user-a 1.2.0 against other", "Status:   complete, exit 0, 1 entity", "Case:     work",
		"  account  github.com/jd", "Next: `ot pivot " + id + "`"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("show lacks %q:\n%s", want, out)
		}
	}
	out.Reset()
	if code := run(a, "runs", id, "--json"); code != 0 {
		t.Fatalf("show --json: exit %d: %s", code, errb)
	}
	var meta results.Meta
	if err := json.Unmarshal(out.Bytes(), &meta); err != nil || meta.RunID != id || len(meta.Entities) != 1 {
		t.Fatalf("show --json: %v %s", err, out)
	}

	// Unknown runs and bad flags exit 2.
	for _, args := range [][]string{{"runs", "zzzzzzzz", "--json"}, {"runs", "nope", "--json"}} {
		errb.Reset()
		if code := run(a, args...); code != ExitUsage {
			t.Errorf("%v: exit %d", args, code)
		}
		if e := readJSONError(t, errb); e.Code != "run_not_found" || !strings.Contains(e.Message, "`ot runs` lists them") {
			t.Errorf("%v: %+v", args, e)
		}
	}
	if code := run(a, "runs", "--status", "weird"); code != ExitUsage {
		t.Errorf("bad status: exit %d", code)
	}
	// --results-dir reads only that folder.
	out.Reset()
	if code := run(a, "runs", "--results-dir", t.TempDir()); code != 0 || !strings.Contains(out.String(), "No saved runs") {
		t.Errorf("empty results dir: exit %d: %s", code, out)
	}
}
