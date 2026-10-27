package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/agent"
	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/share"
)

// savedRunFile writes a saved run the way `ot run` does: the output file and its .meta.json sidecar.
func savedRunFile(t *testing.T, caseName, tool, target, id, output string) string {
	t.Helper()
	dir := results.Dir("")
	if caseName != "" {
		dir = filepath.Join(dir, "cases", caseName)
	}
	dir = filepath.Join(dir, tool, target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	stem := filepath.Join(dir, "20261027-100000_"+tool+"_"+target+"_"+id)
	if err := os.WriteFile(stem+".json", []byte(output), 0o644); err != nil {
		t.Fatal(err)
	}
	var c *string
	if caseName != "" {
		c = &caseName
	}
	m := results.Meta{
		Command: []string{tool, target}, Tool: tool, Ref: "osintverse-community/" + tool, ToolVersion: "1.0.0", Runtime: "docker",
		Target: target, Case: c, Input: map[string]string{"username": target},
		StartedAt: time.Date(2026, 10, 27, 10, 0, 0, 0, time.UTC), EndedAt: time.Date(2026, 10, 27, 10, 0, 4, 0, time.UTC), DurationSeconds: 4,
		Status: results.StatusComplete, OutputPath: filepath.ToSlash(stem + ".json"), SHA256: strings.Repeat("a", 64), Bytes: int64(len(output)),
		StderrPath: filepath.ToSlash(stem + ".stderr.txt"), Envelope: 1, RunID: id, OTVersion: "test", Client: "cli",
		Entities: []envelope.Entity{{Type: "account", Value: "https://github.com/" + target, Source: "github"}},
		Warnings: []string{},
	}
	b, _ := json.Marshal(m)
	if err := os.WriteFile(stem+".meta.json", b, 0o644); err != nil {
		t.Fatal(err)
	}
	return stem + ".json"
}

// fakeShares stands in for the registry's share routes.
type fakeShares struct {
	mu      sync.Mutex
	uploads []map[string]any
	auth    []string
	deletes []string
	mine    []map[string]any
}

func (f *fakeShares) server(t *testing.T) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		body, _ := io.ReadAll(r.Body)
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/shares":
			var p map[string]any
			json.Unmarshal(body, &p)
			f.uploads = append(f.uploads, p)
			f.auth = append(f.auth, r.Header.Get("Authorization"))
			w.WriteHeader(201)
			now := time.Now().UnixMilli()
			json.NewEncoder(w).Encode(map[string]any{"id": "AAAAAAAAAAAAAAAAAAAAAA", "url": "https://otinstaller.com/r/AAAAAAAAAAAAAAAAAAAAAA",
				"created_at": now, "expires_at": now + 86_400_000, "delete_token": "secret-token", "owned": r.Header.Get("Authorization") != "",
				"runs": len(p["runs"].([]any)), "tools": []string{"osintverse-community/sherlock@1.0.0"}})
		case r.Method == http.MethodGet && r.URL.Path == "/me/shares":
			json.NewEncoder(w).Encode(map[string]any{"shares": f.mine})
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/shares/"):
			f.deletes = append(f.deletes, r.URL.Path+" "+r.Header.Get("Authorization")+" "+string(body))
			if strings.HasSuffix(r.URL.Path, "/GONEGONEGONEGONEGONEGO") {
				w.WriteHeader(404)
				w.Write([]byte(`{"error":{"code":"share_not_found","message":"no such shared result"}}`))
				return
			}
			w.WriteHeader(204)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func shareApp(t *testing.T, stdin string) (*App, *fakeShares, *strings.Builder, *strings.Builder) {
	a, out, errb := newTestApp(t, &fakeExec{}, stdin)
	f := &fakeShares{}
	a.API.Base = f.server(t).URL
	o, e := &strings.Builder{}, &strings.Builder{}
	a.Out, a.Err = io.MultiWriter(out, o), io.MultiWriter(errb, e)
	return a, f, o, e
}

func TestShareDryRunLeavesLocalDetailsOut(t *testing.T) {
	a, f, out, _ := shareApp(t, "")
	savedRunFile(t, "acme", "sherlock", "johndoe", "a1b2c3d4", `[{"site":"github","url":"https://github.com/johndoe"}]`)
	if code := run(a, "share", "a1b2c3d4", "--dry-run"); code != 0 {
		t.Fatalf("exit %d", code)
	}
	if len(f.uploads) != 0 {
		t.Fatal("--dry-run uploaded")
	}
	text := out.String()
	for _, local := range []string{"a1b2c3d4", "acme", "results", "stderr", `"command"`, `"case"`, `"target"`, `"path"`} {
		if strings.Contains(text, local) {
			t.Errorf("the payload carries %s:\n%s", local, text)
		}
	}
	var p share.Payload
	if err := json.Unmarshal([]byte(text), &p); err != nil {
		t.Fatal(err)
	}
	r := p.Runs[0]
	if p.Share != 1 || p.Source != "ot" || r.Tool != "osintverse-community/sherlock@1.0.0" || r.Input["username"] != "johndoe" || r.DurationMS != 4000 {
		t.Fatalf("payload: %+v", p)
	}
	if raw, ok := r.Raw.([]any); !ok || len(raw) != 1 || len(r.Entities) != 1 || r.Output.SHA256 != strings.Repeat("a", 64) {
		t.Fatalf("raw or entities lost: %+v", r)
	}
}

func TestShareAsksThenUploadsAndRemembersTheToken(t *testing.T) {
	a, f, out, errb := shareApp(t, "y\n")
	savedRunFile(t, "", "sherlock", "johndoe", "a1b2c3d4", `[]`)
	if code := run(a, "share", "a1b2c3d4"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if !strings.Contains(errb.String(), "Share 1 run (sherlock) on johndoe for 24 hours?") || !strings.Contains(errb.String(), "not linked to any account") {
		t.Errorf("question: %s", errb)
	}
	if len(f.uploads) != 1 || f.auth[0] != "" || !strings.Contains(out.String(), "https://otinstaller.com/r/AAAAAAAAAAAAAAAAAAAAAA") {
		t.Fatalf("uploads %d auth %q out %s", len(f.uploads), f.auth, out)
	}
	saved, err := share.Load()
	if err != nil || len(saved) != 1 || saved[0].DeleteToken != "secret-token" {
		t.Fatalf("record: %+v %v", saved, err)
	}
	if info, _ := os.Stat(filepath.Join(os.Getenv("OT_HOME"), "shares.json")); runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Errorf("shares.json is %v; the delete tokens must be private", info.Mode().Perm())
	}

	// A no shares nothing.
	a, f, _, errb = shareApp(t, "n\n")
	savedRunFile(t, "", "sherlock", "johndoe", "a1b2c3d4", `[]`)
	if code := run(a, "share", "a1b2c3d4"); code != 0 || len(f.uploads) != 0 || !strings.Contains(errb.String(), "Nothing was shared.") {
		t.Fatalf("exit %d, uploads %d: %s", code, len(f.uploads), errb)
	}
}

func TestShareWithoutATerminalNeedsYes(t *testing.T) {
	a, f, _, errb := shareApp(t, "")
	t.Setenv("OT_NONINTERACTIVE", "1")
	savedRunFile(t, "", "sherlock", "johndoe", "a1b2c3d4", `[]`)
	if code := run(a, "share", "a1b2c3d4", "--json"); code != ExitUsage || !strings.Contains(errb.String(), `"input_required"`) {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if code := run(a, "share", "a1b2c3d4", "--yes", "--json"); code != 0 || len(f.uploads) != 1 {
		t.Fatalf("exit %d, uploads %d", code, len(f.uploads))
	}
}

func TestShareLinksToTheAccountUnlessAnonymous(t *testing.T) {
	a, f, _, _ := shareApp(t, "")
	a.API.Token = "ot_signedin"
	savedRunFile(t, "", "sherlock", "johndoe", "a1b2c3d4", `[]`)
	run(a, "share", "a1b2c3d4", "-y")
	run(a, "share", "a1b2c3d4", "-y", "--anonymous")
	if len(f.auth) != 2 || f.auth[0] != "Bearer ot_signedin" || f.auth[1] != "" {
		t.Fatalf("auth headers: %q", f.auth)
	}
}

func TestShareTakesACaseAndRefusesUnknownRuns(t *testing.T) {
	a, f, _, errb := shareApp(t, "")
	savedRunFile(t, "acme", "sherlock", "johndoe", "a1b2c3d4", `[]`)
	savedRunFile(t, "acme", "maigret", "johndoe", "b1b2c3d4", `[]`)
	savedRunFile(t, "", "holehe", "johndoe", "c1b2c3d4", `[]`)
	if code := run(a, "share", "--case", "acme", "c1b2c3d4", "-y"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if runs := f.uploads[0]["runs"].([]any); len(runs) != 3 {
		t.Fatalf("want 3 runs, got %d", len(runs))
	}
	if code := run(a, "share", "deadbeef", "-y", "--json"); code != ExitUsage || !strings.Contains(errb.String(), `"run_not_found"`) {
		t.Fatalf("exit %d: %s", code, errb)
	}
	if code := run(a, "share", "-y"); code != ExitUsage {
		t.Fatalf("no runs named: exit %d", code)
	}
}

func TestShareLeavesLargeOutputsRawOut(t *testing.T) {
	a, _, out, _ := shareApp(t, "")
	savedRunFile(t, "", "sherlock", "johndoe", "a1b2c3d4", `"`+strings.Repeat("x", share.MaxRaw)+`"`)
	run(a, "share", "a1b2c3d4", "--dry-run")
	var p share.Payload
	json.Unmarshal([]byte(out.String()), &p)
	if p.Runs[0].Raw != nil || !p.Runs[0].Output.RawOmitted || len(p.Runs[0].Entities) != 1 {
		t.Fatalf("large output: %+v", p.Runs[0])
	}
}

func TestSharesListsAndDeletes(t *testing.T) {
	a, f, out, errb := shareApp(t, "")
	savedRunFile(t, "", "sherlock", "johndoe", "a1b2c3d4", `[]`)
	run(a, "share", "a1b2c3d4", "-y")
	a.API.Token = "ot_signedin"
	f.mine = []map[string]any{{"id": "BBBBBBBBBBBBBBBBBBBBBB", "url": "https://otinstaller.com/r/BBBBBBBBBBBBBBBBBBBBBB", "tools": []string{"osintverse-community/holehe@2.0.0"},
		"created_at": time.Now().Add(-time.Hour).UnixMilli(), "expires_at": time.Now().Add(23 * time.Hour).UnixMilli()}}
	out.Reset()
	if code := run(a, "shares", "--json"); code != 0 {
		t.Fatalf("exit %d: %s", code, errb)
	}
	var list struct{ Shares []listedShare }
	json.Unmarshal([]byte(out.String()), &list)
	if len(list.Shares) != 2 || list.Shares[0].ID != "AAAAAAAAAAAAAAAAAAAAAA" || !list.Shares[0].Here || list.Shares[1].Here || list.Shares[1].Tools[0] != "holehe" {
		t.Fatalf("list: %+v", list.Shares)
	}
	if strings.Contains(out.String(), "secret-token") {
		t.Error("the list prints delete tokens")
	}

	// This machine's share goes with its token and no sign-in; the account's one as its owner.
	run(a, "shares", "rm", "https://otinstaller.com/r/AAAAAAAAAAAAAAAAAAAAAA")
	run(a, "shares", "rm", "BBBBBBBBBBBBBBBBBBBBBB")
	if len(f.deletes) != 2 || f.deletes[0] != `/shares/AAAAAAAAAAAAAAAAAAAAAA  {"delete_token":"secret-token"}` || f.deletes[1] != "/shares/BBBBBBBBBBBBBBBBBBBBBB Bearer ot_signedin " {
		t.Fatalf("deletes: %q", f.deletes)
	}
	if saved, _ := share.Load(); len(saved) != 0 {
		t.Errorf("deleted share still recorded: %+v", saved)
	}
	out.Reset()
	if code := run(a, "shares", "rm", "GONEGONEGONEGONEGONEGO"); code != 0 || !strings.Contains(out.String(), "already deleted or has expired") {
		t.Fatalf("exit %d: %s", code, out)
	}
	a.API.Token = ""
	if code := run(a, "shares", "rm", "CCCCCCCCCCCCCCCCCCCCCC"); code != ExitUsage {
		t.Fatalf("no token, not signed in: exit %d", code)
	}
}

func TestMCPShareAlwaysAsks(t *testing.T) {
	// Even sandbox mode, where runs go without asking, asks before a share.
	h := newMCP(t, "", `{"mode": "sandbox", "auto_approve": "networked"}`, decide("decline"))
	f := &fakeShares{}
	h.app.API.Base = f.server(t).URL
	savedRunFile(t, "", "sherlock", "johndoe", "a1b2c3d4", `[]`)
	if _, e := h.call("share_runs", map[string]any{"run_ids": []string{"a1b2c3d4"}}); e == nil || e["code"] != "consent_declined" {
		t.Fatalf("declined share: %v", e)
	}
	if len(f.uploads) != 0 || h.asked.Load() != 1 {
		t.Fatalf("uploads %d, asked %d", len(f.uploads), h.asked.Load())
	}

	h = newMCP(t, "", "", decide("allow_once"))
	h.app.API.Base = f.server(t).URL
	savedRunFile(t, "", "sherlock", "johndoe", "a1b2c3d4", `[]`)
	out, e := h.call("share_runs", map[string]any{"run_ids": []string{"a1b2c3d4"}})
	if e != nil || out["url"] != "https://otinstaller.com/r/AAAAAAAAAAAAAAAAAAAAAA" || h.asked.Load() != 1 || len(f.uploads) != 1 {
		t.Fatalf("share: %v %v", out, e)
	}
	if _, leaked := out["delete_token"]; leaked {
		t.Error("the agent got the delete token")
	}
	entries, _ := agent.ReadAudit(time.Time{})
	last := entries[len(entries)-1]
	if last.Action != "share" || last.Outcome != "shared" || last.Share != "AAAAAAAAAAAAAAAAAAAAAA" || last.RunID != "a1b2c3d4" || last.Consent != "elicitation" {
		t.Fatalf("audit: %+v", last)
	}

	// Agents name runs by id; a path is not a run id.
	if _, e := h.call("share_runs", map[string]any{"run_ids": []string{results.Dir("")}}); e == nil || e["code"] != "run_not_found" {
		t.Fatalf("path as run id: %v", e)
	}
}
