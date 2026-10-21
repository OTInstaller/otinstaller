package cli

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/zalando/go-keyring"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

const schemas = "../../../spec/schema"

// schemaFor compiles one of the published JSON Schemas (the run summary refers to the envelope's).
func schemaFor(t *testing.T, name string) *jsonschema.Schema {
	t.Helper()
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	for _, f := range []string{"envelope-v1.json", "run-all-v1.json", "error-v1.json"} {
		b, err := os.ReadFile(filepath.Join(schemas, f))
		if err != nil {
			t.Fatal(err)
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(b))
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if err := c.AddResource("https://otinstaller.com/schema/"+f, doc); err != nil {
			t.Fatal(err)
		}
	}
	s, err := c.Compile("https://otinstaller.com/schema/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func mustMatch(t *testing.T, s *jsonschema.Schema, data []byte) {
	t.Helper()
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("not JSON: %v\n%s", err, data)
	}
	if err := s.Validate(doc); err != nil {
		t.Fatalf("does not match the schema: %v\n%s", err, data)
	}
}

// jsonError reads the one JSON error line ot printed on stderr.
func readJSONError(t *testing.T, errb *bytes.Buffer) jsonError {
	t.Helper()
	line := strings.TrimSpace(errb.String())
	if strings.Contains(line, "\n") {
		t.Fatalf("want one line on stderr, got:\n%s", line)
	}
	mustMatch(t, schemaFor(t, "error-v1.json"), []byte(line))
	var body struct{ Error jsonError }
	_ = json.Unmarshal([]byte(line), &body)
	return body.Error
}

func TestJSONRequested(t *testing.T) {
	for _, c := range []struct {
		args []string
		want bool
	}{
		{[]string{"search", "x", "--json"}, true},
		{[]string{"run", "a/b", "-f", "json"}, true},
		{[]string{"run", "a/b", "--format=json"}, true},
		{[]string{"run", "--all", "u:x", "-f", "jsonl"}, true},
		{[]string{"run", "a/b", "-f", "table"}, false},
		{[]string{"run", "a/b", "--", "--json"}, false},
		{[]string{"list"}, false},
	} {
		if got := jsonRequested(c.args); got != c.want {
			t.Errorf("%v: got %v", c.args, got)
		}
	}
}

func TestErrorCodes(t *testing.T) {
	for _, c := range []struct {
		err  error
		code int
		want string
	}{
		{&api.Error{Code: "tool_not_found", Message: "x"}, ExitUsage, "tool_not_found"},
		{&ExitError{Code: ExitUsage, Reason: "not_installed", Err: errors.New("x")}, ExitUsage, "not_installed"},
		{&api.UnreachableError{Base: "http://x", Err: errors.New("refused")}, ExitToolError, "registry_unreachable"},
		{&ExitError{Code: ExitMissingKey, Err: errors.New("x")}, ExitMissingKey, "secret_missing"},
		{errors.New("x"), ExitTimeout, "timeout"},
		{errors.New("x"), ExitToolError, "failed"},
	} {
		if got := errorCode(c.err, c.code); got != c.want {
			t.Errorf("%v: got %s, want %s", c.err, got, c.want)
		}
	}
}

func TestJSONErrorsGoToStderr(t *testing.T) {
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	// The registry at 127.0.0.1:9 never answers.
	if code := run(a, "search", "whois", "--json"); code != ExitToolError {
		t.Fatalf("exit %d", code)
	}
	if out.Len() != 0 {
		t.Fatalf("stdout should be empty: %s", out)
	}
	e := readJSONError(t, errb)
	if e.Code != "registry_unreachable" || e.ExitCode != ExitToolError || e.Docs != errorDocs+"registry_unreachable" {
		t.Fatalf("%+v", e)
	}

	// OT_OUTPUT=json turns it on for every command, and the registry's own code and hint are kept.
	t.Setenv("OT_OUTPUT", "json")
	errb.Reset()
	if code := run(a, "whoami"); code != ExitUsage {
		t.Fatalf("whoami: exit %d", code)
	}
	if e := readJSONError(t, errb); e.Code != "not_signed_in" {
		t.Fatalf("%+v", e)
	}
	errb.Reset()
	writeJSONError(errb, &ExitError{Code: ExitUsage, Err: &api.Error{Code: "manifest_invalid", Message: "bad", Hint: "fix it", Problems: []api.Problem{{Code: "manifest_schema", Message: "summary is missing"}}}}, ExitUsage)
	if e := readJSONError(t, errb); e.Message != "bad" || e.Hint != "fix it" || len(e.Problems) != 1 {
		t.Fatalf("%+v", e)
	}
	// cobra's own errors are usage errors too.
	errb.Reset()
	if code := run(a, "list", "--bogus"); code != ExitUsage {
		t.Fatalf("unknown flag: exit %d", code)
	}
	if e := readJSONError(t, errb); e.Code != "usage" {
		t.Fatalf("%+v", e)
	}
}

func TestNoPromptsWithoutATerminal(t *testing.T) {
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	t.Setenv("OT_NONINTERACTIVE", "1")
	// Not installed: before, an empty answer meant yes.
	if code := run(a, "run", "dheeraj/holehe-lite", "e:a@b.com", "-f", "json"); code != ExitUsage {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if e := readJSONError(t, errb); e.Code != "not_installed" || !strings.Contains(e.Message, "--yes") {
		t.Fatalf("%+v", e)
	}
	// init would ask for the summary.
	errb.Reset()
	dir := t.TempDir()
	if code := run(a, "init", dir); code != ExitUsage || !strings.Contains(errb.String(), "no terminal") {
		t.Fatalf("init: exit %d: %s", code, errb)
	}
	// Links are printed, not opened.
	a.OpenURL = func(string) error { t.Fatal("opened a browser"); return nil }
	out.Reset()
	if code := run(a, "report", "alice/whois-plus"); code != 0 || !strings.HasSuffix(strings.TrimSpace(out.String()), "/alice/whois-plus/report") {
		t.Fatalf("report: exit %d: %s", code, out)
	}
}

func TestRunEnvelopeProvenance(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"github.com/abc"}],"note":"` + strings.Repeat("x", 200) + `"}`}
	a, out, errb := newTestApp(t, fx, "")
	t.Setenv("CI", "")
	path := filepath.Join(fixtures, "valid", "docker-tool.yaml")
	if code := run(a, "run", path, "e:a@b.com"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	mustMatch(t, schemaFor(t, "envelope-v1.json"), out.Bytes())
	var env struct {
		RunID     string `json:"run_id"`
		OTVersion string `json:"ot_version"`
		Client    string
		Artifact  struct{ Kind, Ref string }
		Output    struct {
			SHA256     string
			Bytes      int64
			Path       string
			MetaPath   string `json:"meta_path"`
			RawOmitted bool   `json:"raw_omitted"`
		}
		Raw any
	}
	_ = json.Unmarshal(out.Bytes(), &env)
	if env.RunID == "" || env.OTVersion != "test" && env.OTVersion != Version || env.Client != "cli" || env.Artifact.Kind != "image" || !strings.Contains(env.Artifact.Ref, "@sha256:") {
		t.Fatalf("provenance: %+v", env)
	}
	if env.Output.Bytes != int64(len(fx.stdout)) || len(env.Output.SHA256) != 64 || !strings.Contains(env.Output.Path, env.RunID) {
		t.Fatalf("output: %+v", env.Output)
	}
	meta := savedRuns(t)
	if len(meta) != 1 || meta[0]["run_id"] != env.RunID || meta[0]["sha256"] != env.Output.SHA256 {
		t.Fatalf("sidecar: %v", meta)
	}

	// --max-raw leaves raw out of what is printed; the saved file stays complete.
	out.Reset()
	if code := run(a, "run", path, "e:a@b.com", "--max-raw", "100", "--no-save"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	mustMatch(t, schemaFor(t, "envelope-v1.json"), out.Bytes())
	env.Raw, env.Output.RawOmitted, env.Output.Path = "x", false, ""
	_ = json.Unmarshal(out.Bytes(), &env)
	if env.Raw != nil || !env.Output.RawOmitted || env.Output.Path != "" {
		t.Fatalf("--max-raw: %s", out)
	}
}

func TestRunAllJSONLines(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[{"type":"account","value":"x"},{"type":"account","value":"x"},{"type":"url","value":"https://x"}]}`}
	a, out, errb := newTestApp(t, fx, "")
	for _, p := range []string{
		writeVariant(t, "user-a", "  - name: user\n    type: username\n    required: true\n", `"{timeout}", "{user}"]`, "{user: x}"),
		writeVariant(t, "user-c", "  - name: user\n    type: username\n    required: true\n  - name: site\n    type: string\n    required: true\n", `"{timeout}", "{site}", "{user}"]`, "{user: x, site: y}"),
	} {
		if code := run(a, "install", p, "--json"); code != 0 {
			t.Fatalf("install: exit %d: %s", code, errb)
		}
	}
	out.Reset()
	if code := run(a, "run", "--all", "u:johndoe", "-f", "jsonl"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	s := schemaFor(t, "run-all-v1.json")
	var lines []map[string]any
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		mustMatch(t, s, sc.Bytes())
		var m map[string]any
		_ = json.Unmarshal(sc.Bytes(), &m)
		lines = append(lines, m)
	}
	if len(lines) != 3 {
		t.Fatalf("want a skipped row, a run and the summary, got %v", lines)
	}
	if lines[0]["status"] != "skipped" || lines[1]["status"] != "complete" {
		t.Fatalf("order: %v", lines)
	}
	if top := lines[1]["top_entities"].([]any); len(top) != 2 || lines[1]["entities"].(float64) != 3 || lines[1]["run_id"] == "" {
		t.Fatalf("row: %v", lines[1])
	}
	sum := lines[2]["summary"].(map[string]any)
	if sum["total"].(float64) != 2 || sum["complete"].(float64) != 1 || sum["skipped"].(float64) != 1 || sum["exit_code"].(float64) != 0 {
		t.Fatalf("summary: %v", sum)
	}
}

// Every command that prints data prints only JSON on stdout in JSON mode.
func TestJSONModeStdoutIsJSON(t *testing.T) {
	keyring.MockInitWithError(errors.New("no keychain here"))
	t.Cleanup(keyring.MockInit)
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	t.Setenv("OT_OUTPUT", "json")
	path := filepath.Join(fixtures, "valid", "docker-tool.yaml")
	for _, args := range [][]string{
		{"list"},
		{"install", path},
		{"list"},
		{"info", path},
		{"keys", "list"},
		{"validate", path},
		{"outdated"},
		{"doctor"},
		{"uninstall", "dheeraj/holehe-lite"},
	} {
		out.Reset()
		errb.Reset()
		run(a, args...)
		if !json.Valid(out.Bytes()) {
			t.Errorf("%v: stdout is not JSON:\n%s", args, out)
		}
		for _, line := range strings.Split(strings.TrimSpace(errb.String()), "\n") {
			if strings.HasPrefix(line, "{") && !json.Valid([]byte(line)) {
				t.Errorf("%v: bad JSON error line: %s", args, line)
			}
		}
	}
	// doctor without a keychain warns instead of failing on it.
	out.Reset()
	run(a, "doctor")
	var d struct {
		Checks []doctorCheck
	}
	_ = json.Unmarshal(out.Bytes(), &d)
	for _, c := range d.Checks {
		if c.Name == "keychain" && c.Status != "warn" {
			t.Errorf("keychain: %+v", c)
		}
	}
}
