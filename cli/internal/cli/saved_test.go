package cli

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/results"
)

func TestExtractAndDiff(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"github.com/jd"}],"notes":"mail jd@example.com"}`}
	a, out, errb := newTestApp(t, fx, "")
	path := writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}")
	if code := run(a, "install", path); code != 0 {
		t.Fatalf("install: %s", errb)
	}
	if code := run(a, "diff", "dheeraj/user-a", "jd"); code != ExitUsage || !strings.Contains(errb.String(), "found 0") {
		t.Fatalf("no runs: exit %d: %s", code, errb)
	}
	if code := run(a, "run", "dheeraj/user-a", "u:jd"); code != 0 {
		t.Fatalf("run 1: %s", errb)
	}
	fx.stdout = `{"entities":[{"type":"account","value":"gitlab.com/jd"}]}`
	if code := run(a, "run", "dheeraj/user-a", "u:jd"); code != 0 {
		t.Fatalf("run 2: %s", errb)
	}

	out.Reset()
	if code := run(a, "diff", "dheeraj/user-a", "jd", "--json"); code != 0 {
		t.Fatalf("diff: exit %d: %s", code, errb)
	}
	var c results.Change
	if err := json.Unmarshal(out.Bytes(), &c); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(c.AddedEntities) != 1 || c.AddedEntities[0] != "account: gitlab.com/jd" || len(c.RemovedEntities) != 1 {
		t.Fatalf("diff: %+v", c)
	}
	out.Reset()
	if code := run(a, "diff", "user-a", "jd"); code != 0 || !strings.Contains(out.String(), "+ entity account: gitlab.com/jd") {
		t.Fatalf("diff text: exit %d: %s", code, out)
	}

	out.Reset()
	if code := run(a, "extract", "dheeraj/user-a", "--json"); code != 0 {
		t.Fatalf("extract: exit %d: %s", code, errb)
	}
	var ind results.Indicators
	if err := json.Unmarshal(out.Bytes(), &ind); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(ind.Emails) != 1 || ind.Emails[0] != "jd@example.com" || len(ind.Entities["account"]) != 2 {
		t.Fatalf("extract: %+v", ind)
	}
	if code := run(a, "extract", "nothing-here"); code != ExitUsage {
		t.Errorf("unknown tool: exit %d", code)
	}
	if code := run(a, "extract"); code != ExitUsage {
		t.Errorf("no argument: exit %d", code)
	}
}
