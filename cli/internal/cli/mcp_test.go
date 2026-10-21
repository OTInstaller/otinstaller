package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/otinstaller/otinstaller/cli/internal/agent"
)

// toolVariant writes a copy of the docker-tool fixture with other inputs, network and ethics.
func toolVariant(t *testing.T, name, inputType string, egress, touches, personal bool) string {
	t.Helper()
	src, err := os.ReadFile(filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	s := strings.Replace(string(src), "name: holehe-lite", "name: "+name, 1)
	s = strings.Replace(s, "  - name: email\n    type: email\n", "  - name: target\n    type: "+inputType+"\n", 1)
	s = strings.Replace(s, `"{email}"]`, `"{target}"]`, 1)
	s = strings.Replace(s, `input: { email: "test@example.com" }`, `input: { target: "example.com" }`, 1)
	if !egress {
		s = strings.Replace(s, "  egress: true\n  domains: [\"*.twitter.com\", \"api.github.com\"]\n", "  egress: false\n", 1)
	}
	s = strings.Replace(s, "touches_target: false", "touches_target: "+map[bool]string{true: "true", false: "false"}[touches], 1)
	s = strings.Replace(s, "collects_personal_data: true", "collects_personal_data: "+map[bool]string{true: "true", false: "false"}[personal], 1)
	path := filepath.Join(t.TempDir(), "otinstaller.yaml")
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

type mcpHarness struct {
	t       *testing.T
	app     *App
	fx      *fakeExec
	server  *mcpServer
	session *mcp.ClientSession
	asked   atomic.Int32
}

// newMCP installs the given manifests with the CLI, then connects an in-memory client to an MCP server. answer, when
// set, is how the client's person answers consent questions; nil makes a client without elicitation.
func newMCP(t *testing.T, stdout, policy string, answer func(*mcp.ElicitRequest) *mcp.ElicitResult, manifests ...string) *mcpHarness {
	t.Helper()
	fx := &fakeExec{stdout: stdout}
	a, _, errb := newTestApp(t, fx, "")
	for _, p := range manifests {
		if code := run(a, "install", p); code != 0 {
			t.Fatalf("install %s: exit %d: %s", p, code, errb)
		}
	}
	if policy != "" {
		os.WriteFile(agent.PolicyPath(), []byte(policy), 0o600)
	}
	fx.calls = nil
	p, err := agent.LoadPolicy()
	if err != nil {
		t.Fatal(err)
	}
	h := &mcpHarness{t: t, app: a, fx: fx}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	h.server = a.serveMCP(ctx, p, "")
	ct, st := mcp.NewInMemoryTransports()
	if _, err := h.server.srv.Connect(ctx, st, nil); err != nil {
		t.Fatal(err)
	}
	opts := &mcp.ClientOptions{}
	if answer != nil {
		opts.ElicitationHandler = func(_ context.Context, req *mcp.ElicitRequest) (*mcp.ElicitResult, error) {
			h.asked.Add(1)
			return answer(req), nil
		}
	}
	cs, err := mcp.NewClient(&mcp.Implementation{Name: "test-client", Version: "1"}, opts).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	h.session = cs
	return h
}

func decide(d string) func(*mcp.ElicitRequest) *mcp.ElicitResult {
	return func(*mcp.ElicitRequest) *mcp.ElicitResult {
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"decision": d}}
	}
}

// call calls a tool and returns its structured result, or its error body when it failed.
func (h *mcpHarness) call(name string, args map[string]any) (map[string]any, map[string]any) {
	h.t.Helper()
	res, err := h.session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		h.t.Fatalf("%s: %v", name, err)
	}
	if res.IsError {
		text := res.Content[0].(*mcp.TextContent).Text
		var body struct{ Error map[string]any }
		if err := json.Unmarshal([]byte(text), &body); err != nil {
			h.t.Fatalf("%s: error is not JSON: %s", name, text)
		}
		return nil, body.Error
	}
	var out map[string]any
	b, _ := json.Marshal(res.StructuredContent)
	_ = json.Unmarshal(b, &out)
	return out, nil
}

func TestMCPListsTools(t *testing.T) {
	h := newMCP(t, "", "", nil)
	res, err := h.session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]*mcp.Tool{}
	for _, tool := range res.Tools {
		byName[tool.Name] = tool
		if tool.Title == "" || tool.Description == "" || tool.OutputSchema == nil {
			t.Errorf("%s: needs a title, description and output schema", tool.Name)
		}
	}
	if len(res.Tools) != 24 {
		t.Errorf("want 24 tools, got %d", len(res.Tools))
	}
	for _, name := range []string{"search_tools", "get_tool", "get_run", "suggest_pivots", "validate_manifest"} {
		if tl := byName[name]; tl == nil || !tl.Annotations.ReadOnlyHint {
			t.Errorf("%s should be read-only", name)
		}
	}
	for _, name := range []string{"run_tool", "run_all", "uninstall_tool"} {
		if tl := byName[name]; tl == nil || tl.Annotations.ReadOnlyHint || tl.Annotations.DestructiveHint == nil || !*tl.Annotations.DestructiveHint {
			t.Errorf("%s should be marked destructive so clients ask", name)
		}
	}
	prompts, err := h.session.ListPrompts(context.Background(), nil)
	if err != nil || len(prompts.Prompts) != 8 {
		t.Fatalf("prompts: %v %v", prompts, err)
	}
}

func TestMCPPassiveRunNeedsNoConsent(t *testing.T) {
	stdout := `{"entities":[{"type":"subdomain","value":"www.example.com"},{"type":"email","value":"x\u001b[31m@example.com"}]}`
	h := newMCP(t, stdout, "", decide("decline"), toolVariant(t, "dns-local", "domain", false, false, false))
	out, e := h.call("run_tool", map[string]any{"tool": "dheeraj/dns-local", "target": "example.com"})
	if e != nil {
		t.Fatalf("passive run refused: %v", e)
	}
	if h.asked.Load() != 0 || out["status"] != "complete" || out["consent"] != "policy" || out["entities_total"].(float64) != 2 {
		t.Fatalf("asked %d times: %v", h.asked.Load(), out)
	}
	// Tool output is cleaned of terminal escapes.
	ents := out["entities"].([]any)
	if v := ents[1].(map[string]any)["value"]; v != "x@example.com" {
		t.Errorf("not cleaned: %q", v)
	}
	runID := out["run_id"].(string)

	// The run can be read back, and pivoted on.
	got, e := h.call("get_run", map[string]any{"run_id": runID, "view": "summary"})
	if e != nil || got["run"].(map[string]any)["run_id"] != runID {
		t.Fatalf("get_run: %v %v", got, e)
	}
	piv, e := h.call("suggest_pivots", map[string]any{"run_id": runID})
	if e != nil {
		t.Fatal(e)
	}
	var sawDomain bool
	for _, p := range piv["pivots"].([]any) {
		p := p.(map[string]any)
		if p["input_type"] == "domain" && p["value"] == "www.example.com" && len(p["installed_tools"].([]any)) == 1 {
			sawDomain = true
		}
	}
	if !sawDomain {
		t.Errorf("a subdomain should pivot to the installed domain tool: %v", piv)
	}
	runs, _ := h.call("list_runs", map[string]any{"tool": "dheeraj/dns-local"})
	if len(runs["runs"].([]any)) != 1 {
		t.Errorf("list_runs: %v", runs)
	}
	// Every run is audited.
	entries, _ := agent.ReadAudit(time.Now().Add(-time.Minute))
	if len(entries) != 1 || entries[0].Consent != "policy" || entries[0].Client != "mcp:test-client 1" || entries[0].RunID != runID {
		t.Fatalf("audit: %+v", entries)
	}
}

func TestMCPConsentByElicitation(t *testing.T) {
	var decision atomic.Value
	decision.Store("allow_once")
	answer := func(req *mcp.ElicitRequest) *mcp.ElicitResult {
		if !strings.Contains(req.Params.Message, "collects personal data") || !strings.Contains(req.Params.Message, "Run dheeraj/holehe-lite 1.2.0 on email=") {
			t.Errorf("the question should say what the run does: %s", req.Params.Message)
		}
		return &mcp.ElicitResult{Action: "accept", Content: map[string]any{"decision": decision.Load().(string)}}
	}
	h := newMCP(t, `{"entities":[{"type":"account","value":"github.com/abc"}]}`, "", answer, filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	args := map[string]any{"tool": "dheeraj/holehe-lite", "inputs": map[string]any{"email": "a@b.com"}}

	out, e := h.call("run_tool", args)
	if e != nil || out["status"] != "complete" || out["consent"] != "elicitation" || h.asked.Load() != 1 {
		t.Fatalf("allow once: %v %v (asked %d)", out, e, h.asked.Load())
	}
	// Allow once means the next run asks again; declining stops it.
	decision.Store("decline")
	if _, e := h.call("run_tool", args); e == nil || e["code"] != "consent_declined" || h.asked.Load() != 2 {
		t.Fatalf("decline: %v (asked %d)", e, h.asked.Load())
	}
	// Allow for the session covers the same tool and target, not another target.
	decision.Store("allow_session")
	h.call("run_tool", args)
	if out, _ := h.call("run_tool", args); out["consent"] != "session" || h.asked.Load() != 3 {
		t.Fatalf("session approval: %v (asked %d)", out, h.asked.Load())
	}
	other := map[string]any{"tool": "dheeraj/holehe-lite", "target": "c@d.com"}
	h.call("run_tool", other)
	if h.asked.Load() != 4 {
		t.Fatalf("another target must ask again (asked %d)", h.asked.Load())
	}
	st, _ := h.call("get_consent_status", map[string]any{"tool": "dheeraj/holehe-lite", "target": "a@b.com"})
	if st["verdict"] != "allow" {
		t.Errorf("consent status: %v", st)
	}
}

func TestMCPConsentTokenFallback(t *testing.T) {
	h := newMCP(t, `{"entities":[]}`, "", nil, filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	args := map[string]any{"tool": "dheeraj/holehe-lite", "target": "a@b.com"}
	_, e := h.call("run_tool", args)
	if e == nil || e["code"] != "consent_required" || e["consent_token"] == nil || !strings.Contains(e["summary"].(string), "collects personal data") {
		t.Fatalf("want consent_required with a token: %v", e)
	}
	if calls := len(h.fx.calls); calls != 0 {
		t.Fatalf("nothing may run before consent; %d calls", calls)
	}
	token := e["consent_token"].(string)
	// The token is for this exact call only.
	if _, e := h.call("run_tool", map[string]any{"tool": "dheeraj/holehe-lite", "target": "x@y.com", "consent_token": token}); e == nil || e["code"] != "consent_token_invalid" {
		t.Fatalf("token on another call: %v", e)
	}
	args["consent_token"] = token
	if out, e := h.call("run_tool", args); e != nil || out["consent"] != "token" {
		t.Fatalf("with the token: %v %v", out, e)
	}
	if _, e := h.call("run_tool", args); e == nil || e["code"] != "consent_token_invalid" {
		t.Fatalf("a token works once: %v", e)
	}
}

func TestMCPPolicyAndTrust(t *testing.T) {
	passive := toolVariant(t, "dns-local", "domain", false, false, false)
	h := newMCP(t, `{"entities":[]}`, `{"deny_tools": ["dheeraj/holehe-*"]}`, decide("allow_once"), filepath.Join(fixtures, "valid", "docker-tool.yaml"), passive)
	if _, e := h.call("run_tool", map[string]any{"tool": "dheeraj/holehe-lite", "target": "a@b.com"}); e == nil || e["code"] != "tool_not_allowed" {
		t.Fatalf("deny_tools: %v", e)
	}
	if _, e := h.call("run_tool", map[string]any{"tool": "dheeraj/nope", "target": "x"}); e == nil || e["code"] != "not_installed" {
		t.Fatalf("not installed: %v", e)
	}
	if _, e := h.call("install_tool", map[string]any{"tool": passive}); e == nil || e["code"] != "usage" {
		t.Fatalf("local manifests can't be installed by agents: %v", e)
	}
	// A batch skips refused tools and runs the rest.
	out, e := h.call("run_all", map[string]any{"target": "example.com", "dry_run": true})
	if e != nil || out["status"] != "planned" {
		t.Fatalf("dry run: %v %v", out, e)
	}
	out, e = h.call("run_all", map[string]any{"target": "example.com"})
	if e != nil || out["status"] != "complete" || out["summary"].(map[string]any)["complete"].(float64) != 1 {
		t.Fatalf("run_all: %v %v", out, e)
	}
}

func TestUnattendedCLIRunsNeedYes(t *testing.T) {
	fx := &fakeExec{stdout: `{"entities":[]}`}
	a, _, errb := newTestApp(t, fx, "")
	path := filepath.Join(fixtures, "valid", "docker-tool.yaml")
	run(a, "install", path)
	t.Setenv("OT_NONINTERACTIVE", "1")
	errb.Reset()
	if code := run(a, "run", "dheeraj/holehe-lite", "e:a@b.com", "--json"); code != ExitUsage {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if e := readJSONError(t, errb); e.Code != "consent_required" || !strings.Contains(e.Message, "--yes") {
		t.Fatalf("%+v", e)
	}
	if code := run(a, "run", "dheeraj/holehe-lite", "e:a@b.com", "--yes"); code != 0 {
		t.Fatalf("--yes: exit %d: %s", code, errb)
	}
	entries, _ := agent.ReadAudit(time.Now().Add(-time.Minute))
	if len(entries) != 1 || entries[0].Consent != "flag" || entries[0].Outcome != "complete" {
		t.Fatalf("audit: %+v", entries)
	}
	// Passive tools need nothing.
	run(a, "install", toolVariant(t, "dns-local", "domain", false, false, false))
	if code := run(a, "run", "dheeraj/dns-local", "d:example.com"); code != 0 {
		t.Fatalf("passive: exit %d: %s", code, errb)
	}
	t.Setenv("OT_CONSENT", "off")
	if code := run(a, "run", "dheeraj/holehe-lite", "e:a@b.com"); code != 0 {
		t.Fatalf("OT_CONSENT=off: exit %d: %s", code, errb)
	}
}

func TestMCPInstallClients(t *testing.T) {
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	cursor := filepath.Join(home, ".cursor", "mcp.json")
	os.MkdirAll(filepath.Dir(cursor), 0o755)
	os.WriteFile(cursor, []byte(`{"mcpServers": {"other": {"command": "x"}}, "keep": true}`), 0o644)
	if code := run(a, "mcp", "install", "cursor"); code != 0 {
		t.Fatalf("cursor: exit %d: %s", code, errb)
	}
	var doc map[string]any
	b, _ := os.ReadFile(cursor)
	json.Unmarshal(b, &doc)
	servers := doc["mcpServers"].(map[string]any)
	if servers["other"] == nil || doc["keep"] != true || servers["otinstaller"].(map[string]any)["args"].([]any)[0] != "mcp" {
		t.Fatalf("cursor config: %s", b)
	}
	if code := run(a, "mcp", "install", "codex"); code != 0 {
		t.Fatalf("codex: exit %d: %s", code, errb)
	}
	if b, _ := os.ReadFile(filepath.Join(home, ".codex", "config.toml")); !strings.Contains(string(b), "[mcp_servers.otinstaller]") {
		t.Fatalf("codex config: %s", b)
	}
	if code := run(a, "mcp", "install", "codex"); code != ExitUsage {
		t.Errorf("a second codex install should refuse, got %d", code)
	}
	out.Reset()
	if code := run(a, "mcp", "install", "vscode", "--print"); code != 0 || !strings.Contains(out.String(), `"servers"`) {
		t.Fatalf("vscode --print: exit %d: %s", code, out)
	}
	if code := run(a, "mcp", "install", "notepad"); code != ExitUsage {
		t.Errorf("unknown client: %d", code)
	}
}

// The MCP tools page lists everything the server offers; regenerate it from `ot mcp tools --json` when this fails.
func TestMCPToolsDocsMatch(t *testing.T) {
	doc, err := os.ReadFile("../../../web/src/pages/docs/mcp-tools.md")
	if err != nil {
		t.Fatal(err)
	}
	a, _, _ := newTestApp(t, &fakeExec{}, "")
	list, err := a.describeMCP(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range list.Tools {
		if !strings.Contains(string(doc), "| `"+tool.Name+"` | "+tool.Description+" |") {
			t.Errorf("web/src/pages/docs/mcp-tools.md is out of date for %s", tool.Name)
		}
	}
	for _, p := range list.Prompts {
		if !strings.Contains(string(doc), "`"+p.Name+"`") {
			t.Errorf("web/src/pages/docs/mcp-tools.md lacks the prompt %s", p.Name)
		}
	}
}
