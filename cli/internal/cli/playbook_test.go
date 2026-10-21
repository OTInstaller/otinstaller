package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlaybook(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"x"}]}`}
	a, out, errb := newTestApp(t, fx, "")
	for _, path := range []string{
		writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"),
		writeVariant(t, "user-b", "  - name: handle\n    type: username\n    required: true\n", `"{timeout}", "{handle}"]`, "{handle: x}"),
		writeVariant(t, "phone-only", "  - name: number\n    type: phone\n    required: true\n", `"{timeout}", "{number}"]`, "{number: x}"),
	} {
		if code := run(a, "install", path); code != 0 {
			t.Fatalf("install: exit %d: %s", code, errb)
		}
	}
	dir := filepath.Join(os.Getenv("OT_HOME"), "playbooks")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "people.yaml"), []byte("description: test\ntools:\n  - dheeraj/user-a\n  - dheeraj/phone-only\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "missing.yaml"), []byte("tools: [dheeraj/user-a, dheeraj/not-here]\n"), 0o644)

	out.Reset()
	if code := run(a, "playbook", "--list"); code != 0 || !strings.Contains(out.String(), "people") || !strings.Contains(out.String(), "domain-recon") {
		t.Fatalf("list: exit %d: %s %s", code, out, errb)
	}

	out.Reset()
	if code := run(a, "playbook", "people", "u:johndoe", "--format", "json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var rows []allResult
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	if len(rows) != 2 || rows[0].Tool != "dheeraj/user-a" || rows[0].Status != "complete" ||
		rows[1].Tool != "dheeraj/phone-only" || rows[1].Status != "skipped" || !strings.Contains(rows[1].Reason, "no username input") {
		t.Fatalf("rows: %+v", rows)
	}
	// user-b has a username input but is not in the playbook; runs are saved under the playbook's case.
	if !strings.Contains(filepath.ToSlash(rows[0].OutputPath), "/cases/playbook-people/user-a/johndoe/") {
		t.Errorf("output path: %s", rows[0].OutputPath)
	}
	if runs := savedRuns(t); len(runs) != 1 || runs[0]["case"] != "playbook-people" {
		t.Errorf("saved runs: %v", runs)
	}

	// A bare target gets its type guessed.
	out.Reset()
	if code := run(a, "playbook", "people", "janedoe", "--format", "json"); code != 0 {
		t.Fatalf("bare target: exit %d: %s", code, errb)
	}
	if err := json.Unmarshal(out.Bytes(), &rows); err != nil || rows[0].Status != "complete" {
		t.Fatalf("bare target: %v %+v", err, rows)
	}

	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"playbook", "missing", "u:x"}, "ot install dheeraj/not-here"},
		{[]string{"playbook", "people", "d:example.com"}, "none of the playbook's tools"},
		{[]string{"playbook", "people"}, "needs at least one typed input"},
		{[]string{"playbook", "nope", "u:x"}, "no playbook"},
		{[]string{"playbook", "people", "u:x", "--all"}, "--all is for"},
	} {
		errb.Reset()
		if code := run(a, c.args...); code != ExitUsage || !strings.Contains(errb.String(), c.want) {
			t.Errorf("%v: exit %d, want %q in %s", c.args, code, c.want, errb)
		}
	}
}
