// Package agent decides what an AI agent (or any caller without a terminal) may run without asking: it classifies
// runs by what they do to a target, applies the local policy file, keeps a session's approvals and limits, signs
// consent tokens, and writes the local audit log. The MCP server and `ot run` without a terminal both use it, so an
// agent gets the same answer whichever way it calls ot. The design is section 4.5 of docs/agent-friendly-plan.md.
package agent

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"strings"

	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// Policy is <ot home>/agent-policy.json. Every field is optional; missing ones keep their default.
type Policy struct {
	// Enabled false is the kill switch: every run, install and uninstall through an agent is refused.
	Enabled bool `json:"enabled"`
	// Mode "sandbox" runs each tool on its own manifest test input instead of the agent's target.
	Mode string `json:"mode"`
	// AllowTools, when set, are the only packages an agent may run ("ns/*" matches a namespace). DenyTools always win.
	AllowTools []string `json:"allow_tools"`
	DenyTools  []string `json:"deny_tools"`
	// AutoApprove is the most an agent may run without asking: none, passive or networked. Runs that touch a target
	// or collect personal data always ask.
	AutoApprove string `json:"auto_approve"`
	// ConsentTTLMinutes is how long "allow for this session" lasts.
	ConsentTTLMinutes int `json:"consent_ttl_minutes"`
	// Limits per server session (or per `ot run` process).
	MaxRunsPerHour          int `json:"max_runs_per_hour"`
	MaxParallel             int `json:"max_parallel"`
	MaxRunsPerTargetPerHour int `json:"max_runs_per_target_per_hour"`
	// MaxOutputChars caps what a run returns to the agent; the saved file is always complete.
	MaxOutputChars int `json:"max_output_chars"`
	// AllowInstall is ask or allow. Installs always need a verified signature.
	AllowInstall string `json:"allow_install"`
	// RedactTargetsInAudit leaves input values out of the audit log, for shared machines.
	RedactTargetsInAudit bool `json:"redact_targets_in_audit"`
}

// DefaultPolicy is what applies when there is no policy file.
func DefaultPolicy() *Policy {
	return &Policy{
		Enabled:                 true,
		Mode:                    "live",
		AutoApprove:             "passive",
		ConsentTTLMinutes:       60,
		MaxRunsPerHour:          30,
		MaxParallel:             4,
		MaxRunsPerTargetPerHour: 10,
		MaxOutputChars:          60000,
		AllowInstall:            "ask",
	}
}

// PolicyPath is where the policy file lives.
func PolicyPath() string { return state.Path("agent-policy.json") }

// LoadPolicy reads the policy file over the defaults. A missing file is the defaults; a broken one is an error, so a
// typo never silently loosens the policy.
func LoadPolicy() (*Policy, error) {
	p := DefaultPolicy()
	b, err := os.ReadFile(PolicyPath())
	if errors.Is(err, os.ErrNotExist) {
		return p, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, p); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w; fix it or remove it to use the defaults", PolicyPath(), err)
	}
	return p, p.check()
}

func (p *Policy) check() error {
	bad := func(field, val, allowed string) error {
		return fmt.Errorf("%s: %s is %q; use %s", PolicyPath(), field, val, allowed)
	}
	switch {
	case p.Mode != "live" && p.Mode != "sandbox":
		return bad("mode", p.Mode, "live or sandbox")
	case p.AutoApprove != "none" && p.AutoApprove != "passive" && p.AutoApprove != "networked":
		return bad("auto_approve", p.AutoApprove, "none, passive or networked")
	case p.AllowInstall != "ask" && p.AllowInstall != "allow":
		return bad("allow_install", p.AllowInstall, "ask or allow")
	}
	for _, n := range []struct {
		field  string
		v, min int
	}{{"consent_ttl_minutes", p.ConsentTTLMinutes, 1}, {"max_runs_per_hour", p.MaxRunsPerHour, 0}, {"max_runs_per_target_per_hour", p.MaxRunsPerTargetPerHour, 0},
		{"max_parallel", p.MaxParallel, 1}, {"max_output_chars", p.MaxOutputChars, 2000}} {
		if n.v < n.min {
			return fmt.Errorf("%s: %s is %d; it must be at least %d (0 for no limit, for the run limits)", PolicyPath(), n.field, n.v, n.min)
		}
	}
	return nil
}

// Save writes the policy file, for `ot mcp policy reset`.
func (p *Policy) Save() error {
	if err := os.MkdirAll(state.Home(), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(p, "", "  ")
	return os.WriteFile(PolicyPath(), append(b, '\n'), 0o600)
}

// Allowed reports whether the policy lets an agent use the package at all, and why not.
func (p *Policy) Allowed(ref string) (bool, string) {
	for _, pat := range p.DenyTools {
		if matches(pat, ref) {
			return false, fmt.Sprintf("%s is in deny_tools in %s", ref, PolicyPath())
		}
	}
	if len(p.AllowTools) == 0 {
		return true, ""
	}
	for _, pat := range p.AllowTools {
		if matches(pat, ref) {
			return true, ""
		}
	}
	return false, fmt.Sprintf("%s is not in allow_tools in %s", ref, PolicyPath())
}

func matches(pattern, ref string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	ok, err := path.Match(pattern, strings.ToLower(ref))
	return err == nil && ok
}
