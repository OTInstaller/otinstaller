package cli

// Consent for runs nobody is watching: `ot run`, `--all`, playbooks and auto without a terminal (CI, scripts, agents
// calling ot through a shell) need --yes for a tool that touches a target, goes online or collects personal data, and
// every such run is written to the local audit log. The rules are the agent package's, the same as `ot mcp` uses.

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/otinstaller/otinstaller/cli/internal/agent"
	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// unattended reports whether a run has no person at a terminal to see it, so the consent rules apply.
// OT_CONSENT=off turns them off; that choice is still audited.
func (a *App) unattended() bool { return !a.AgentMode && !a.interactive() }

// cliConsent checks planned runs against the agent policy. A refused tool stops everything; runs that need consent
// stop with consent_required unless --yes was given.
func (a *App) cliConsent(ra *runArgs, jobs []allJob) error {
	if !a.unattended() {
		return nil
	}
	ra.audit = true
	ra.consent = "flag"
	if os.Getenv("OT_CONSENT") == "off" {
		ra.consent = "off"
		return nil
	}
	p, err := agent.LoadPolicy()
	if err != nil {
		return &ExitError{Code: ExitUsage, Err: err}
	}
	s := agent.NewSession(p)
	var ask []string
	for _, j := range jobs {
		d := s.DecideRun(j.inst.Manifest, j.values)
		switch d.Verdict {
		case agent.Refuse:
			return &ExitError{Code: ExitTrust, Reason: d.Code, Err: errors.New(d.Reason)}
		case agent.Ask:
			ask = append(ask, fmt.Sprintf("%s (%s)", j.inst.Ref, strings.Join(agent.Describe(j.inst.Manifest), "; ")))
		}
	}
	if len(ask) == 0 {
		ra.consent = "policy"
		return nil
	}
	if ra.Yes {
		return nil
	}
	what := "this run needs"
	if len(ask) > 1 {
		what = "these runs need"
	}
	return &ExitError{Code: ExitUsage, Reason: "consent_required", Err: fmt.Errorf(
		"%s the consent of the person you run them for, and there is no terminal to ask in: %s. Ask them, then run again with --yes (OT_CONSENT=off turns this check off)",
		what, strings.Join(ask, ", "))}
}

// auditRun writes one unattended run to the audit log.
func (a *App) auditRun(ra *runArgs, inst *state.Installed, values map[string]string, env *envelope.Envelope, meta *results.Meta, runErr error) {
	if !ra.audit {
		return
	}
	p, _ := agent.LoadPolicy()
	e := agent.Entry{
		Client: a.clientKind(), Action: "run", Tool: inst.Ref + "@" + inst.Version, Digest: inst.Artifact,
		Inputs: values, Class: agent.Classify(inst.Manifest, values), Consent: ra.consent, Outcome: "error",
	}
	switch {
	case meta != nil:
		e.Outcome, e.RunID = meta.Status, meta.RunID
		if meta.ExitCode >= 0 {
			code := meta.ExitCode
			e.ExitCode = &code
		}
		e.Duration = int64(meta.DurationSeconds * 1000)
	case env != nil:
		e.Outcome, e.RunID, e.Duration = results.StatusComplete, env.RunID, env.DurationMS
		code := env.ExitCode
		e.ExitCode = &code
	}
	if runErr != nil && e.Outcome == "error" {
		e.Error = runErr.Error()
	}
	if err := agent.Record(p, e); err != nil {
		fmt.Fprintf(a.Err, "warning: could not write the audit log: %v\n", err)
	}
}
