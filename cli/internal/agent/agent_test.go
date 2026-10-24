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
		// Using the person's account or API key always asks.
		{func() *manifest.Manifest {
			m := tool(false, false, true, "domain")
			m.Ethics.AuthRequired = true
			return m
		}(), Target},
		{func() *manifest.Manifest {
			m := tool(false, false, true, "domain")
			m.Secrets = []manifest.Secret{{Name: "SHODAN_API_KEY", Required: true}}
			return m
		}(), Target},
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
	s.Started(m, in)
	s.Started(m, in)
	if d := s.DecideRun(m, in); d.Code != "rate_limited" || d.RetryAfter <= 0 {
		t.Fatalf("limit: %+v", d)
	}
	// Spaces, case and extra options don't make a new target.
	m.Inputs = append(m.Inputs, manifest.Input{Name: "depth", Type: "integer"})
	if d := s.DecideRun(m, map[string]string{"target": " A.com ", "depth": "3"}); d.Code != "rate_limited" {
		t.Fatalf("same target spelled differently: %+v", d)
	}
	p.Enabled = false
	if d := s.DecideInstall("bob/x", ""); d.Code != "agent_disabled" {
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
	for _, bad := range []string{`{"auto_approve": "everything"}`, `{"consent_ttl_minutes": 0}`, `{"max_runs_per_hour": -1}`, `{"max_output_chars": 100}`} {
		os.WriteFile(PolicyPath(), []byte(bad), 0o600)
		if _, err := LoadPolicy(); err == nil {
			t.Fatalf("%s: a bad value must not loosen the policy silently", bad)
		}
	}
}

func TestPolicyChangesApplyToARunningSession(t *testing.T) {
	t.Setenv("OT_HOME", t.TempDir())
	s := NewSession(DefaultPolicy())
	m := tool(false, false, false, "domain")
	if d := s.DecideRun(m, nil); d.Verdict != Allow {
		t.Fatalf("before: %+v", d)
	}
	os.MkdirAll(os.Getenv("OT_HOME"), 0o700)
	os.WriteFile(PolicyPath(), []byte(`{"enabled": false}`), 0o600)
	if d := s.DecideRun(m, nil); d.Code != "agent_disabled" {
		t.Fatalf("kill switch: %+v", d)
	}
	// A broken file refuses rather than falling back to the defaults.
	os.WriteFile(PolicyPath(), []byte(`{"enabled": tru`), 0o600)
	if d := s.DecideInstall("a/b", ""); d.Code != "policy_invalid" {
		t.Fatalf("broken file: %+v", d)
	}
	os.Remove(PolicyPath())
	if d := s.DecideRun(m, nil); d.Verdict != Allow {
		t.Fatalf("back to the defaults: %+v", d)
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
	// A new server process has a new key, so a token from before a restart never opens.
	old := s.NewToken(h)
	defer func(k []byte) { sessionKey = k }(sessionKey)
	sessionKey = []byte("another process's key, 32 bytes")
	if s.UseToken(old, h) {
		t.Fatal("a token from before a restart works")
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

func TestSealedStatesAreUnique(t *testing.T) {
	h := CallHash("run_tool", "img", map[string]any{"a": 1})
	a, b := Seal("cs_", h), Seal("cs_", h)
	if a == b || !Open("cs_", a, h) || !Open("cs_", b, h) || Open("cs_", a, CallHash("run_tool", "img", map[string]any{"a": 2})) {
		t.Fatalf("seals: %s %s", a, b)
	}
	s := NewSession(DefaultPolicy())
	if !s.SpendOnce(a) || s.SpendOnce(a) || !s.SpendOnce(b) {
		t.Fatal("each sealed answer is spent once, independently")
	}
}

func TestDescribeNotifiesTarget(t *testing.T) {
	quiet, loud := false, true
	for _, c := range []struct {
		name   string
		m      *manifest.Manifest
		want   string
		absent bool
	}{
		{"unset on a tool that touches the target", tool(true, false, true, "domain"), "the publisher doesn't say", false},
		{"unset on a passive tool", tool(false, false, false, "domain"), "may notify", true},
		{"says it can't", func() *manifest.Manifest {
			m := tool(true, false, true, "domain")
			m.Ethics.NotifiesTarget = &quiet
			return m
		}(), "may notify", true},
		{"says it may", func() *manifest.Manifest {
			m := tool(true, false, true, "domain")
			m.Ethics.NotifiesTarget = &loud
			return m
		}(), "a login alert", false},
	} {
		got := strings.Join(Describe(c.m), "; ")
		if strings.Contains(got, c.want) == c.absent {
			t.Errorf("%s: Describe = %q", c.name, got)
		}
	}
}
