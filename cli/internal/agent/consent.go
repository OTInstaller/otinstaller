package agent

import (
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

// Class says what a run does beyond the user's machine, from the manifest's ethics and network sections.
type Class string

const (
	// Passive runs stay on the machine: no network, no target contact, no personal data.
	Passive Class = "passive"
	// Networked runs go online but neither contact the target nor collect personal data.
	Networked Class = "networked"
	// Target runs send requests to services about the target (ethics.touches_target).
	Target Class = "target"
	// Personal runs collect personal data, or take an identifier of a person (email, phone, name, image).
	Personal Class = "personal"
)

// personalInputs are input types that identify a person, so a run on one always needs the person's consent.
var personalInputs = map[string]bool{"email": true, "phone": true, "name": true, "image": true}

// Classify puts a run in the strictest class that applies. values are the resolved inputs.
func Classify(m *manifest.Manifest, values map[string]string) Class {
	if m.Ethics != nil && m.Ethics.CollectsPersonalData {
		return Personal
	}
	for _, in := range m.Inputs {
		if values[in.Name] != "" && personalInputs[in.Type] {
			return Personal
		}
	}
	if m.Ethics == nil || m.Ethics.TouchesTarget {
		return Target
	}
	if m.Network != nil && m.Network.Egress != nil && *m.Network.Egress {
		return Networked
	}
	return Passive
}

// Describe is the plain-language list of what a run does, shown when asking for consent.
func Describe(m *manifest.Manifest) []string {
	var out []string
	if m.Ethics == nil || m.Ethics.TouchesTarget {
		out = append(out, "sends requests to websites or services about the target")
	}
	if m.Ethics != nil && m.Ethics.CollectsPersonalData {
		out = append(out, "collects personal data")
	}
	if m.Ethics != nil && m.Ethics.AuthRequired {
		out = append(out, "uses an account or API key of yours")
	}
	if m.Network != nil && m.Network.Egress != nil && *m.Network.Egress {
		if len(m.Network.Domains) > 0 {
			out = append(out, "connects to "+strings.Join(m.Network.Domains, ", "))
		} else {
			out = append(out, "connects to the internet")
		}
	} else {
		out = append(out, "runs offline")
	}
	return out
}

// Verdict is what the policy says about one planned run.
type Verdict string

const (
	Allow  Verdict = "allow"
	Ask    Verdict = "ask"
	Refuse Verdict = "refuse"
)

// Decision is the policy's answer for a planned run, install or uninstall.
type Decision struct {
	Verdict Verdict `json:"verdict"`
	Class   Class   `json:"class,omitempty"`
	// Code is the error code when refused: agent_disabled, tool_not_allowed or rate_limited.
	Code   string `json:"code,omitempty"`
	Reason string `json:"reason"`
	// Key is what an approval is remembered under: the package, or the package and the target.
	Key string `json:"-"`
	// RetryAfter is set for rate_limited.
	RetryAfter time.Duration `json:"-"`
}

// Session holds one agent connection's approvals and counters. It is safe for concurrent use.
type Session struct {
	Policy *Policy

	mu        sync.Mutex
	approvals map[string]time.Time // key -> expiry
	runs      []time.Time
	byTarget  map[string][]time.Time
	usedToken map[string]bool
	now       func() time.Time
}

// NewSession starts an empty session under a policy.
func NewSession(p *Policy) *Session {
	return &Session{Policy: p, approvals: map[string]time.Time{}, byTarget: map[string][]time.Time{}, usedToken: map[string]bool{}, now: time.Now}
}

// targetKey identifies the target of a run: its input values, sorted, so the same target is recognised whatever
// order inputs come in.
func targetKey(values map[string]string) string {
	var parts []string
	for k, v := range values {
		if v != "" {
			parts = append(parts, k+"="+strings.ToLower(v))
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, "&")
}

// DecideRun is the policy's answer for running m with values. It doesn't count the run; call Started for that.
func (s *Session) DecideRun(m *manifest.Manifest, values map[string]string) Decision {
	ref := m.Ref()
	p := s.Policy
	if !p.Enabled {
		return Decision{Verdict: Refuse, Code: "agent_disabled", Reason: "agent use is turned off (enabled: false in " + PolicyPath() + ")"}
	}
	if ok, why := p.Allowed(ref); !ok {
		return Decision{Verdict: Refuse, Code: "tool_not_allowed", Reason: why}
	}
	if d, limited := s.limited(values); limited {
		return d
	}
	if p.Mode == "sandbox" {
		return Decision{Verdict: Allow, Class: Passive, Reason: "sandbox mode: the tool runs on its own test input"}
	}
	class := Classify(m, values)
	switch class {
	case Passive:
		if p.AutoApprove != "none" {
			return Decision{Verdict: Allow, Class: class, Reason: "passive: no network, no target contact, no personal data"}
		}
	case Networked:
		if p.AutoApprove == "networked" {
			return Decision{Verdict: Allow, Class: class, Reason: "networked runs are approved in " + PolicyPath()}
		}
	}
	// Networked runs are approved per tool; runs that touch a target or a person, per tool and target.
	key := "run " + ref
	if class == Target || class == Personal {
		key += " on " + targetKey(values)
	}
	if s.approved(key) {
		return Decision{Verdict: Allow, Class: class, Key: key, Reason: "approved earlier in this session"}
	}
	return Decision{Verdict: Ask, Class: class, Key: key, Reason: "needs your consent: " + strings.Join(Describe(m), "; ")}
}

// DecideInstall is the policy's answer for installing a package.
func (s *Session) DecideInstall(ref string) Decision {
	p := s.Policy
	if !p.Enabled {
		return Decision{Verdict: Refuse, Code: "agent_disabled", Reason: "agent use is turned off (enabled: false in " + PolicyPath() + ")"}
	}
	if ok, why := p.Allowed(ref); !ok {
		return Decision{Verdict: Refuse, Code: "tool_not_allowed", Reason: why}
	}
	key := "install " + ref
	if p.AllowInstall == "allow" || s.approved(key) {
		return Decision{Verdict: Allow, Key: key, Reason: "installs are allowed"}
	}
	return Decision{Verdict: Ask, Key: key, Reason: "installing pulls and trusts new code"}
}

// DecideUninstall always asks: removing a package is the person's call.
func (s *Session) DecideUninstall(ref string) Decision {
	if !s.Policy.Enabled {
		return Decision{Verdict: Refuse, Code: "agent_disabled", Reason: "agent use is turned off (enabled: false in " + PolicyPath() + ")"}
	}
	return Decision{Verdict: Ask, Key: "uninstall " + ref, Reason: "removes the package from this machine"}
}

func (s *Session) approved(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	exp, ok := s.approvals[key]
	return ok && s.now().Before(exp)
}

// Approve remembers an "allow for this session" answer for the policy's consent_ttl_minutes.
func (s *Session) Approve(key string) {
	if key == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.approvals[key] = s.now().Add(time.Duration(s.Policy.ConsentTTLMinutes) * time.Minute)
}

// limited checks the hourly limits.
func (s *Session) limited(values map[string]string) (Decision, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	hourAgo := now.Add(-time.Hour)
	s.runs = since(s.runs, hourAgo)
	tk := targetKey(values)
	s.byTarget[tk] = since(s.byTarget[tk], hourAgo)
	retry := func(times []time.Time) time.Duration { return times[0].Add(time.Hour).Sub(now).Round(time.Second) }
	if p := s.Policy; p.MaxRunsPerHour > 0 && len(s.runs) >= p.MaxRunsPerHour {
		return Decision{Verdict: Refuse, Code: "rate_limited", RetryAfter: retry(s.runs),
			Reason: fmt.Sprintf("at most %d runs an hour (max_runs_per_hour in %s)", p.MaxRunsPerHour, PolicyPath())}, true
	}
	if p := s.Policy; p.MaxRunsPerTargetPerHour > 0 && len(s.byTarget[tk]) >= p.MaxRunsPerTargetPerHour {
		return Decision{Verdict: Refuse, Code: "rate_limited", RetryAfter: retry(s.byTarget[tk]),
			Reason: fmt.Sprintf("at most %d runs an hour against the same target (max_runs_per_target_per_hour in %s)", p.MaxRunsPerTargetPerHour, PolicyPath())}, true
	}
	return Decision{}, false
}

// Started counts a run against the hourly limits.
func (s *Session) Started(values map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.runs = append(s.runs, now)
	tk := targetKey(values)
	s.byTarget[tk] = append(s.byTarget[tk], now)
}

func since(times []time.Time, t time.Time) []time.Time {
	i := 0
	for i < len(times) && times[i].Before(t) {
		i++
	}
	return times[i:]
}
