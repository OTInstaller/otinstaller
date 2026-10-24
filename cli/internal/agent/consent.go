package agent

import (
	"fmt"
	"os"
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
	// Target runs send requests to services about the target (ethics.touches_target), or use the person's own
	// account or API keys, which can cost them money or get the account limited.
	Target Class = "target"
	// Personal runs collect personal data, or take an identifier of a person (email, phone, name, image).
	Personal Class = "personal"
)

// personalInputs are input types that identify a person, so a run on one always needs the person's consent.
var personalInputs = map[string]bool{"email": true, "phone": true, "name": true, "image": true}

// identifierInputs are the input types that name a target, as opposed to options (string, integer, boolean, enum).
var identifierInputs = map[string]bool{"email": true, "username": true, "phone": true, "domain": true, "ip": true, "url": true,
	"name": true, "image": true, "crypto_address": true, "hash": true, "company": true}

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
	if m.Ethics == nil || m.Ethics.TouchesTarget || m.Ethics.AuthRequired {
		return Target
	}
	for _, s := range m.Secrets {
		if s.Required {
			return Target
		}
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
	switch {
	case m.Ethics != nil && m.Ethics.NotifiesTarget != nil:
		if *m.Ethics.NotifiesTarget {
			out = append(out, "may notify the target (a sign-up or reset email, a login alert)")
		}
	case m.Ethics == nil || m.Ethics.TouchesTarget:
		// Unset on a tool that touches the target: say so rather than guess it is quiet.
		out = append(out, "may notify the target (the publisher doesn't say)")
	}
	if m.Ethics != nil && m.Ethics.CollectsPersonalData {
		out = append(out, "collects personal data")
	}
	if m.Ethics != nil && m.Ethics.AuthRequired {
		out = append(out, "uses an account or API key of yours")
	} else {
		for _, s := range m.Secrets {
			if s.Required {
				out = append(out, "uses your API key "+s.Name)
				break
			}
		}
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
	// Code is the error code when refused: agent_disabled, tool_not_allowed, rate_limited or policy_invalid.
	Code   string `json:"code,omitempty"`
	Reason string `json:"reason"`
	// Key is what an approval is remembered under: the package, or the package and the target.
	Key string `json:"-"`
	// Approved says the run is allowed by an earlier "allow for this session".
	Approved bool `json:"-"`
	// RetryAfter is set for rate_limited.
	RetryAfter time.Duration `json:"-"`
}

// Session holds one agent connection's approvals and counters. It is safe for concurrent use. The policy file is
// read again whenever it changes, so `enabled: false` stops the very next call, not the next session.
type Session struct {
	Policy *Policy

	mu        sync.Mutex
	approvals map[string]time.Time // key -> expiry
	runs      []time.Time
	byTarget  map[string][]time.Time
	used      map[string]bool // consent tokens and answers already spent
	now       func() time.Time
	// fileStamp is the policy file's size and modification time when it was last read; badPolicy is why it
	// couldn't be read, which refuses every side effect until it is fixed.
	fileStamp string
	badPolicy error
}

// NewSession starts an empty session under a policy.
func NewSession(p *Policy) *Session {
	return &Session{Policy: p, approvals: map[string]time.Time{}, byTarget: map[string][]time.Time{}, used: map[string]bool{}, now: time.Now,
		fileStamp: policyStamp()}
}

func policyStamp() string {
	info, err := os.Stat(PolicyPath())
	if err != nil {
		return "missing"
	}
	return fmt.Sprintf("%d %d", info.Size(), info.ModTime().UnixNano())
}

// Refresh reads the policy file again if it changed since it was last read, and returns the policy in force. A file
// that has become invalid doesn't fall back to the defaults: decisions refuse until it is fixed.
func (s *Session) Refresh() *Policy {
	stamp := policyStamp()
	s.mu.Lock()
	defer s.mu.Unlock()
	if stamp == s.fileStamp {
		return s.Policy
	}
	s.fileStamp = stamp
	p, err := LoadPolicy()
	if err != nil {
		s.badPolicy = err
		return s.Policy
	}
	s.Policy, s.badPolicy = p, nil
	return p
}

// refused is the decision when the policy itself says no to anything.
func (s *Session) refused() (Decision, bool) {
	p := s.Refresh()
	s.mu.Lock()
	bad := s.badPolicy
	s.mu.Unlock()
	if bad != nil {
		return Decision{Verdict: Refuse, Code: "policy_invalid", Reason: bad.Error()}, true
	}
	if !p.Enabled {
		return Decision{Verdict: Refuse, Code: "agent_disabled", Reason: "agent use is turned off (enabled: false in " + PolicyPath() + ")"}, true
	}
	return Decision{}, false
}

// TargetKey identifies the target of a run: the values of its identifier inputs (domain, email, ...), trimmed, lower
// case and sorted, so the same target is recognised whatever order inputs come in and whatever options are added.
// A tool with no identifier inputs is keyed on all of them.
func TargetKey(m *manifest.Manifest, values map[string]string) string {
	var parts []string
	add := func(only bool) {
		for _, in := range m.Inputs {
			if v := strings.ToLower(strings.TrimSpace(values[in.Name])); v != "" && (!only || identifierInputs[in.Type]) {
				parts = append(parts, in.Name+"="+v)
			}
		}
	}
	add(true)
	if len(parts) == 0 {
		add(false)
	}
	sort.Strings(parts)
	return strings.Join(parts, "&")
}

// DecideRun is the policy's answer for running m with values. It doesn't count the run; call Started for that.
func (s *Session) DecideRun(m *manifest.Manifest, values map[string]string) Decision {
	if d, no := s.refused(); no {
		return d
	}
	ref := m.Ref()
	p := s.Policy
	if ok, why := p.Allowed(ref); !ok {
		return Decision{Verdict: Refuse, Code: "tool_not_allowed", Reason: why}
	}
	if d, limited := s.limited(m, values); limited {
		return d
	}
	class := Classify(m, values)
	if p.Mode == "sandbox" {
		return Decision{Verdict: Allow, Class: class, Reason: "sandbox mode: the tool runs on its own test input, not your target"}
	}
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
		key += " on " + TargetKey(m, values)
	}
	if s.approved(key) {
		return Decision{Verdict: Allow, Class: class, Key: key, Approved: true, Reason: "approved earlier in this session"}
	}
	return Decision{Verdict: Ask, Class: class, Key: key, Reason: "needs your consent: " + strings.Join(Describe(m), "; ")}
}

// DecideInstall is the policy's answer for installing a version of a package. A session approval covers that version
// only, so "allow for this session" never covers an update the person hasn't seen.
func (s *Session) DecideInstall(ref, version string) Decision {
	if d, no := s.refused(); no {
		return d
	}
	p := s.Policy
	if ok, why := p.Allowed(ref); !ok {
		return Decision{Verdict: Refuse, Code: "tool_not_allowed", Reason: why}
	}
	key := "install " + ref
	if version != "" {
		key += "@" + version
	}
	if p.AllowInstall == "allow" {
		return Decision{Verdict: Allow, Reason: "installs are allowed (allow_install in " + PolicyPath() + ")"}
	}
	if s.approved(key) {
		return Decision{Verdict: Allow, Key: key, Approved: true, Reason: "approved earlier in this session"}
	}
	return Decision{Verdict: Ask, Key: key, Reason: "installing pulls and trusts new code"}
}

// DecideUninstall always asks: removing a package is the person's call. The allow and deny lists don't apply.
func (s *Session) DecideUninstall(ref string) Decision {
	if d, no := s.refused(); no {
		return d
	}
	return Decision{Verdict: Ask, Reason: "removes the package from this machine"}
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
func (s *Session) limited(m *manifest.Manifest, values map[string]string) (Decision, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	hourAgo := now.Add(-time.Hour)
	s.runs = since(s.runs, hourAgo)
	tk := TargetKey(m, values)
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
func (s *Session) Started(m *manifest.Manifest, values map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.runs = append(s.runs, now)
	tk := TargetKey(m, values)
	s.byTarget[tk] = append(s.byTarget[tk], now)
}

// SpendOnce marks a consent token or answer as used, and reports whether it was still unused.
func (s *Session) SpendOnce(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.used[id] {
		return false
	}
	s.used[id] = true
	return true
}

func since(times []time.Time, t time.Time) []time.Time {
	i := 0
	for i < len(times) && times[i].Before(t) {
		i++
	}
	return times[i:]
}
