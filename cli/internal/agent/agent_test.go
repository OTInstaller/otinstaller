package agent

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

func tool(touches, personal, egress bool, inputType string) *manifest.Manifest {
	return &manifest.Manifest{
		Namespace: "alice", Name: "probe", Version: "1.0.0",
		Inputs:  []manifest.Input{{Name: "target", Type: inputType, Required: true}},
		Ethics:  &manifest.Ethics{TouchesTarget: touches, CollectsPersonalData: personal},
		Network: &manifest.Network{Egress: &egress},
	}
}

func TestClassify(t *testing.T) {
	in := map[string]string{"target": "x"}
	for _, c := range []struct {
		m    *manifest.Manifest
		want Class
	}{
		{tool(false, false, false, "domain"), Passive},
		{tool(false, false, true, "domain"), Networked},
		{tool(true, false, true, "domain"), Target},
		{tool(false, true, false, "domain"), Personal},
		{tool(false, false, false, "email"), Personal}, // an email address identifies a person
		{&manifest.Manifest{Namespace: "a", Name: "b"}, Target},
	} {
		if got := Classify(c.m, in); got != c.want {
			t.Errorf("%+v: got %s, want %s", c.m.Ethics, got, c.want)
		}
	}
}

func TestDecideRun(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	s := NewSession(DefaultPolicy())
	a := map[string]string{"target": "a.com"}
	b := map[string]string{"target": "b.com"}

	if d := s.DecideRun(tool(false, false, false, "domain"), a); d.Verdict != Allow {
		t.Fatalf("passive: %+v", d)
	}
	net := tool(false, false, true, "domain")
	d := s.DecideRun(net, a)
	if d.Verdict != Ask {
		t.Fatalf("networked: %+v", d)
	}
	// Networked approvals are per tool.
	s.Approve(d.Key)
	if d := s.DecideRun(net, b); d.Verdict != Allow {
		t.Fatalf("networked after approval: %+v", d)
	}
	// Target approvals are per tool and target.
	tgt := tool(true, false, true, "domain")
	d = s.DecideRun(tgt, a)
	s.Approve(d.Key)
	if d := s.DecideRun(tgt, a); d.Verdict != Allow {
		t.Fatalf("same target: %+v", d)
	}
	if d := s.DecideRun(tgt, b); d.Verdict != Ask || !strings.Contains(d.Reason, "sends requests") {
		t.Fatalf("other target: %+v", d)
	}
	// Approvals expire.
	s.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
	if d := s.DecideRun(tgt, a); d.Verdict != Ask {
		t.Fatalf("expired: %+v", d)
	}
}

func TestPolicyLimitsAndLists(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	p := DefaultPolicy()
	p.MaxRunsPerTargetPerHour = 2
	p.DenyTools = []string{"alice/*"}
	s := NewSession(p)
	m := tool(false, false, false, "domain")
	if d := s.DecideRun(m, nil); d.Verdict != Refuse || d.Code != "tool_not_allowed" {
		t.Fatalf("deny: %+v", d)
	}
	p.DenyTools = nil
	in := map[string]string{"target": "a.com"}
	s.Started(in)
	s.Started(in)
	if d := s.DecideRun(m, in); d.Code != "rate_limited" || d.RetryAfter <= 0 {
		t.Fatalf("limit: %+v", d)
	}
	p.Enabled = false
	if d := s.DecideInstall("bob/x"); d.Code != "agent_disabled" {
		t.Fatalf("kill switch: %+v", d)
	}
}

func TestLoadPolicy(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	if p, err := LoadPolicy(); err != nil || p.AutoApprove != "passive" {
		t.Fatalf("defaults: %+v %v", p, err)
	}
	os.MkdirAll(os.Getenv("OT_HOME"), 0o700)
	os.WriteFile(PolicyPath(), []byte(`{"auto_approve": "networked", "max_parallel": 2}`), 0o600)
	if p, err := LoadPolicy(); err != nil || p.AutoApprove != "networked" || p.MaxParallel != 2 || !p.Enabled {
		t.Fatalf("file over defaults: %+v %v", p, err)
	}
	os.WriteFile(PolicyPath(), []byte(`{"auto_approve": "everything"}`), 0o600)
	if _, err := LoadPolicy(); err == nil {
		t.Fatal("a bad value must not loosen the policy silently")
	}
}

func TestConsentTokens(t *testing.T) {
	s := NewSession(DefaultPolicy())
	h := CallHash("run_tool", "img@sha256:1", map[string]any{"tool": "a/b", "inputs": map[string]any{"d": "x"}})
	other := CallHash("run_tool", "img@sha256:1", map[string]any{"tool": "a/b", "inputs": map[string]any{"d": "y"}})
	tok := s.NewToken(h)
	if s.UseToken(tok, other) {
		t.Fatal("a token works only for its own call")
	}
	if !s.UseToken(tok, h) || s.UseToken(tok, h) {
		t.Fatal("a token works exactly once")
	}
	if CallHash("run_tool", "i", map[string]any{"a": 1, "consent_token": "x"}) != CallHash("run_tool", "i", map[string]any{"a": 1}) {
		t.Fatal("the token itself is not part of the call")
	}
}

func TestAuditLog(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	p := DefaultPolicy()
	p.RedactTargetsInAudit = true
	if err := Record(p, Entry{Client: "test", Action: "run", Tool: "a/b@1", Inputs: map[string]string{"email": "a@b.com"}, Consent: "policy", Outcome: "complete"}); err != nil {
		t.Fatal(err)
	}
	got, err := ReadAudit(time.Now().Add(-time.Minute))
	if err != nil || len(got) != 1 || got[0].Inputs != nil || got[0].InputsHash == "" {
		t.Fatalf("%+v %v", got, err)
	}
}
