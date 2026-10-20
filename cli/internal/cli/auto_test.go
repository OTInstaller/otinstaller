package cli

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestAuto(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"x"}]}`}
	a, out, errb := newTestApp(t, fx, "")
	for _, path := range []string{
		filepath.Join(fixtures, "valid", "docker-tool.yaml"), // email
		writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"),
		writeVariant(t, "dom-a", "  - name: domain\n    type: domain\n    required: true\n", `"{timeout}", "{domain}"]`, "{domain: example.com}"),
	} {
		if code := run(a, "install", path); code != 0 {
			t.Fatalf("install: exit %d: %s", code, errb)
		}
	}
	rows := func() map[string]allResult {
		t.Helper()
		var list []allResult
		if err := json.Unmarshal(out.Bytes(), &list); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
		got := map[string]allResult{}
		for _, r := range list {
			got[r.Tool] = r
		}
		return got
	}
	runs := func() int {
		n := 0
		for _, c := range fx.calls {
			if len(c) > 1 && c[1] == "run" {
				n++
			}
		}
		return n
	}

	out.Reset()
	if code := run(a, "auto", "example.com", "--format", "json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if got := rows(); len(got) != 1 || got["dheeraj/dom-a"].Status != "complete" {
		t.Fatalf("domain: %+v", got)
	}

	// --dry-run lists without running.
	before := runs()
	out.Reset()
	if code := run(a, "auto", "a@b.com", "--dry-run", "--format", "json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if got := rows(); got["dheeraj/holehe-lite"].Status != "would run" || runs() != before {
		t.Fatalf("dry run: %+v, %d runs", got, runs()-before)
	}

	// --type overrides the guess.
	out.Reset()
	if code := run(a, "auto", "example.com", "--type", "username", "--format", "json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if got := rows(); len(got) != 1 || got["dheeraj/user-a"].Status != "complete" ||
		!strings.Contains(filepath.ToSlash(got["dheeraj/user-a"].OutputPath), "/user-a/example.com/") {
		t.Fatalf("--type: %+v", got)
	}

	// The table format says what it guessed.
	errb.Reset()
	if code := run(a, "auto", "johndoe", "--dry-run"); code != 0 || !strings.Contains(errb.String(), "johndoe is a username") {
		t.Fatalf("exit %d: %s", code, errb)
	}

	// Progress lines on stderr as each tool finishes; otinstaller's --live is accepted.
	errb.Reset()
	if code := run(a, "auto", "johndoe", "--live"); code != 0 || !strings.Contains(errb.String(), "[1/1] dheeraj/user-a complete") {
		t.Fatalf("progress: exit %d: %s", code, errb)
	}

	for _, c := range []struct {
		args []string
		want string
	}{
		{[]string{"auto", "x", "--type", "planet"}, "--type must be"},
		{[]string{"auto", "a.com", "b@c.com", "--type", "domain"}, "exactly one"},
		{[]string{"auto", "+14155552671"}, "no installed tool has a phone input"},
		{[]string{"auto", "x", "--all"}, "--all is for"},
		{[]string{"run", "dheeraj/user-a", "u:x", "--dry-run"}, "--dry-run goes with --all"},
	} {
		errb.Reset()
		if code := run(a, c.args...); code != ExitUsage || !strings.Contains(errb.String(), c.want) {
			t.Errorf("%v: exit %d, want %q in %s", c.args, code, c.want, errb)
		}
	}
	if code := run(a, "auto"); code != ExitUsage {
		t.Errorf("no target: exit %d", code)
	}
}
