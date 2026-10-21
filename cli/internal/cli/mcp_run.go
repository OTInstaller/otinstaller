package cli

// The MCP server's tools with side effects: installing and uninstalling, running tools one at a time or in batches,
// and stopping runs. Each one asks the agent policy first, and the person when the policy says so (mcp_server.go).
// Runs outlive the call that starts them: a call waits up to wait_seconds, then returns a run_id to poll.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/otinstaller/otinstaller/cli/internal/agent"
	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/playbook"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

type runIn struct {
	Tool         string            `json:"tool" jsonschema:"the installed package, namespace/name"`
	Inputs       map[string]string `json:"inputs,omitempty" jsonschema:"input values by input name; get_tool lists the inputs"`
	Target       string            `json:"target,omitempty" jsonschema:"instead of inputs: one target, filled into the tool's input of input_type"`
	InputType    string            `json:"input_type,omitempty" jsonschema:"the type of target (email, username, domain, ...); guessed when left out"`
	Case         string            `json:"case,omitempty" jsonschema:"save the run under this case, to group an investigation's runs"`
	WaitSeconds  int               `json:"wait_seconds,omitempty" jsonschema:"how long to wait for the result before returning a run_id to poll with get_run (default 60, at most 300)"`
	ConsentToken string            `json:"consent_token,omitempty" jsonschema:"only after the person said yes to the summary of a consent_required error for this exact call"`
}

type runOut struct {
	RunID         string             `json:"run_id"`
	Status        string             `json:"status" jsonschema:"running, complete, failed (the tool exited non-zero), timeout, interrupted or error"`
	Tool          string             `json:"tool"`
	ExitCode      *int               `json:"exit_code,omitempty"`
	DurationMS    int64              `json:"duration_ms,omitempty"`
	Entities      []envelope.Entity  `json:"entities"`
	EntitiesTotal int                `json:"entities_total"`
	Truncated     bool               `json:"truncated,omitempty" jsonschema:"only some entities fit; read the rest with get_run"`
	Warnings      []string           `json:"warnings,omitempty"`
	Artifact      *envelope.Artifact `json:"artifact,omitempty"`
	Output        *envelope.Output   `json:"output,omitempty"`
	Consent       string             `json:"consent,omitempty" jsonschema:"how the run was allowed: policy, elicitation, session, token or sandbox"`
	Error         string             `json:"error,omitempty"`
	Note          string             `json:"note"`
}

type installIn struct {
	Tool         string `json:"tool" jsonschema:"the package, namespace/name or namespace/name@version"`
	ConsentToken string `json:"consent_token,omitempty" jsonschema:"only after the person said yes, for this exact call"`
}

type batchIn struct {
	Target       string   `json:"target" jsonschema:"the target every tool runs against"`
	InputType    string   `json:"input_type,omitempty" jsonschema:"username, domain, email, phone, ip or url; guessed when left out"`
	Tools        []string `json:"tools,omitempty" jsonschema:"only these installed tools (default: every installed tool that takes the target)"`
	Parallel     int      `json:"parallel,omitempty" jsonschema:"how many run at once (default and maximum: max_parallel in the policy)"`
	Case         string   `json:"case,omitempty"`
	DryRun       bool     `json:"dry_run,omitempty" jsonschema:"list what would run, and what would need consent, without running anything"`
	WaitSeconds  int      `json:"wait_seconds,omitempty" jsonschema:"how long to wait before returning a batch_id to poll with get_batch (default 60, at most 300)"`
	ConsentToken string   `json:"consent_token,omitempty"`
}

type playbookIn struct {
	Name         string `json:"name" jsonschema:"the playbook; list_playbooks lists them"`
	Target       string `json:"target"`
	InputType    string `json:"input_type,omitempty"`
	Parallel     int    `json:"parallel,omitempty"`
	Case         string `json:"case,omitempty" jsonschema:"default: the playbook's own case"`
	DryRun       bool   `json:"dry_run,omitempty"`
	WaitSeconds  int    `json:"wait_seconds,omitempty"`
	ConsentToken string `json:"consent_token,omitempty"`
}

type batchOut struct {
	BatchID string         `json:"batch_id"`
	Status  string         `json:"status" jsonschema:"running, complete (every run completed), failed, interrupted or planned (dry_run)"`
	Case    string         `json:"case,omitempty"`
	Rows    []*allResult   `json:"rows"`
	Summary map[string]int `json:"summary"`
	Note    string         `json:"note"`
}

type uninstallIn struct {
	Tool         string `json:"tool" jsonschema:"the installed package, namespace/name"`
	ConsentToken string `json:"consent_token,omitempty"`
}

type idIn struct {
	ID string `json:"id" jsonschema:"a run_id or batch_id"`
}

type idOut struct {
	ID     string `json:"id"`
	Status string `json:"status"`
}

type batchIDIn struct {
	BatchID string `json:"batch_id"`
}

// liveRun is a run or batch this server started.
type liveRun struct {
	id, kind, tool string
	started        time.Time
	cancel         context.CancelFunc
	done           chan struct{}
	consent        string
	caseName       string

	// A single run's result.
	env  *envelope.Envelope
	meta *results.Meta
	err  error

	// A batch's rows; finished counts the rows that are done, under mu.
	mu       sync.Mutex
	rows     []*allResult
	finished int
	outcome  error
}

func (lr *liveRun) isDone() bool {
	select {
	case <-lr.done:
		return true
	default:
		return false
	}
}

func (s *mcpServer) liveRun(id string) *liveRun {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.live[strings.TrimSpace(id)]
}

func (s *mcpServer) track(lr *liveRun) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.live[lr.id] = lr
}

// waitFor waits for a run or batch to end, up to seconds, or until the call is cancelled (which stops the run).
func waitFor(ctx context.Context, lr *liveRun, seconds int) {
	seconds = orInt(seconds, 60)
	if seconds > 300 {
		seconds = 300
	}
	t := time.NewTimer(time.Duration(seconds) * time.Second)
	defer t.Stop()
	select {
	case <-lr.done:
	case <-t.C:
	case <-ctx.Done():
		lr.cancel()
		<-lr.done
	}
}

var effectful = func(destructive, idempotent bool) *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{DestructiveHint: ptr(destructive), IdempotentHint: idempotent, OpenWorldHint: ptr(true)}
}

func (s *mcpServer) addRunTools() {
	mcp.AddTool(s.srv, &mcp.Tool{Name: "install_tool", Title: "Install a tool", Annotations: effectful(false, true),
		Description: "Install a published tool: pull its image by digest and verify its signature (or fetch its Python wheel by hash). Agents may only install signed, current, healthy versions. Asks the person first unless the policy allows installs."},
		s.installTool)
	mcp.AddTool(s.srv, &mcp.Tool{Name: "uninstall_tool", Title: "Uninstall a tool", Annotations: effectful(true, true),
		Description: "Remove an installed tool. Always asks the person."},
		s.uninstallTool)
	mcp.AddTool(s.srv, &mcp.Tool{Name: "run_tool", Title: "Run a tool", Annotations: effectful(true, false),
		Description: "Run an installed tool in its sandbox and save the result. Give inputs by name, or one target with its type. Passive tools run straight away; tools that touch a target, go online or involve a person ask the person first (or return consent_required with a token to use only after they say yes). Waits up to wait_seconds, then returns a run_id for get_run."},
		s.runTool)
	mcp.AddTool(s.srv, &mcp.Tool{Name: "run_all", Title: "Run every tool on a target", Annotations: effectful(true, false),
		Description: "Run every installed tool that takes the target (or the ones named), a few at a time, with one consent question for the whole set. Use dry_run first to see what would run. Returns a batch_id for get_batch if it takes longer than wait_seconds."},
		s.runAll)
	mcp.AddTool(s.srv, &mcp.Tool{Name: "run_playbook", Title: "Run a playbook", Annotations: effectful(true, false),
		Description: "Run a playbook (a named set of tools) against a target, like run_all limited to its tools. Its tools must be installed; install_tool installs them."},
		s.runPlaybook)
	readTool(s, "get_batch", "Read a batch", "The rows of a run_all or run_playbook batch: each tool's status, entity count, first entities and run_id.",
		func(ctx context.Context, in batchIDIn) (*batchOut, error) {
			lr := s.liveRun(in.BatchID)
			if lr == nil || lr.kind != "batch" {
				return nil, &toolError{Code: "batch_not_found", Message: "no batch " + in.BatchID + " in this session", Hint: "list_runs with the batch's case lists its saved runs"}
			}
			return s.batchResult(lr), nil
		})
	mcp.AddTool(s.srv, &mcp.Tool{Name: "cancel_run", Title: "Stop a run", Annotations: effectful(false, true),
		Description: "Stop a run or batch this session started. Partial output is kept."},
		func(ctx context.Context, _ *mcp.CallToolRequest, in idIn) (*mcp.CallToolResult, *idOut, error) {
			lr := s.liveRun(in.ID)
			if lr == nil {
				return nil, nil, &toolError{Code: "run_not_found", Message: "no run or batch " + in.ID + " in this session"}
			}
			if !lr.isDone() {
				lr.cancel()
				select {
				case <-lr.done:
				case <-time.After(10 * time.Second):
				}
			}
			status := "interrupted"
			if !lr.isDone() {
				status = "stopping"
			}
			return nil, &idOut{ID: lr.id, Status: status}, nil
		})
}

// ---------- single runs ----------

// runPlan is a resolved run: the installed package, its inputs and keys.
type runPlan struct {
	inst    *state.Installed
	values  map[string]string
	secrets map[string]string
	target  string
}

// planRun resolves a run_tool call against what is installed.
func (s *mcpServer) planRun(ctx context.Context, in runIn) (*runPlan, error) {
	ref, err := parseRef(in.Tool)
	if err != nil || ref.LocalPath != "" {
		return nil, &toolError{Code: "usage", Message: fmt.Sprintf("give an installed package as namespace/name, not %q", in.Tool)}
	}
	st, err := state.Load()
	if err != nil {
		return nil, err
	}
	inst := st.Installed[ref.Ref()]
	if inst == nil || (ref.Version != "" && ref.Version != inst.Version) {
		return nil, &toolError{Code: "not_installed", Message: ref.Ref() + " is not installed", Hint: "install it with install_tool (get_tool shows what it does first)"}
	}
	m := inst.Manifest
	if m == nil || m.IsGuide() || m.Runtime == nil {
		return nil, &toolError{Code: "usage", Message: ref.Ref() + " is not a tool"}
	}
	if inst.Native {
		return nil, &toolError{Code: "trust_refused", Message: ref.Ref() + " was installed with --native, so it would run outside the sandbox; agents can only run sandboxed tools",
			Hint: "ask the person to reinstall it with `ot install " + ref.Ref() + "` (without --native)"}
	}
	if s.a.CheckRemovals {
		if r := removal(s.a.removedList(ctx, time.Hour), inst.Ref, inst.Version); r != nil {
			return nil, &toolError{Code: "trust_refused", Message: fmt.Sprintf("%s@%s was removed from the registry (%s)", inst.Ref, inst.Version, r.Category)}
		}
	}
	given := map[string]string{}
	for k, v := range in.Inputs {
		given[k] = v
	}
	target := in.Target
	if in.Target != "" {
		typ := in.InputType
		if typ == "" {
			typ = runner.TypedPrefixes[runner.DetectType(in.Target)]
		}
		name, err := runner.InputForType(m, typ)
		if err != nil {
			return nil, &toolError{Code: "usage", Message: err.Error(), Extra: map[string]any{"inputs": m.Inputs}}
		}
		given[name] = in.Target
	}
	values, err := runner.ResolveInputs(m, given)
	if err != nil {
		return nil, &toolError{Code: "usage", Message: err.Error(), Extra: map[string]any{"inputs": m.Inputs}}
	}
	if target == "" {
		target = firstGiven(m, given)
	}
	if s.sess.Policy.Mode == "sandbox" {
		if values, err = sandboxValues(m); err != nil {
			return nil, err
		}
	}
	secrets, err := loadSecrets(m)
	if err != nil {
		return nil, &toolError{Code: "secret_missing", Message: err.Error(),
			Hint: "ask the person to set the key themselves with `ot keys set NAME`, or as an environment variable; never ask for the key's value"}
	}
	return &runPlan{inst: inst, values: values, secrets: secrets, target: target}, nil
}

// sandboxValues are a tool's own test inputs, which sandbox mode runs instead of the agent's.
func sandboxValues(m *manifest.Manifest) (map[string]string, error) {
	if m.Test == nil {
		return nil, &toolError{Code: "sandbox_unavailable", Message: m.Ref() + " has no test input, so it can't run in sandbox mode",
			Hint: "only the person can switch to live mode (mode in " + agent.PolicyPath() + ")"}
	}
	given := map[string]string{}
	for k, v := range m.Test.Input {
		given[k] = fmt.Sprint(v)
	}
	return runner.ResolveInputs(m, given)
}

func (s *mcpServer) runTool(ctx context.Context, req *mcp.CallToolRequest, in runIn) (*mcp.CallToolResult, *runOut, error) {
	plan, err := s.planRun(ctx, in)
	if err != nil {
		return nil, nil, asToolError(err)
	}
	m := plan.inst.Manifest
	d := s.sess.DecideRun(m, plan.values)
	consent := "policy"
	if s.sess.Policy.Mode == "sandbox" {
		consent = "sandbox"
	}
	switch d.Verdict {
	case agent.Refuse:
		s.audit(req, "run", plan.inst, plan.values, d.Class, "refused", "refused", nil, "", d.Reason)
		return nil, nil, refusal(d)
	case agent.Ask:
		ans, err := s.ask(consentRequest{
			req: req, artifact: plan.inst.Artifact, keys: []string{d.Key}, token: in.ConsentToken,
			question: fmt.Sprintf("Run %s %s on %s?", m.Ref(), m.Version, describeInputs(plan.values)),
			details:  s.runDetails(plan.inst),
		})
		if err != nil {
			if te, ok := err.(*toolError); ok && te.Code == "consent_declined" {
				s.audit(req, "run", plan.inst, plan.values, d.Class, "declined", "declined", nil, "", "")
			}
			return nil, nil, err
		}
		if ans.pending != nil {
			return ans.pending, nil, nil
		}
		consent = ans.method
	default:
		if d.Key != "" {
			consent = "session"
		}
	}
	s.sess.Started(plan.values)
	lr, err := s.startRun(req, plan, in.Case, consent, d.Class)
	if err != nil {
		return nil, nil, asToolError(err)
	}
	waitFor(ctx, lr, in.WaitSeconds)
	return s.runResult(lr)
}

// startRun starts one run in the background and returns once it has a run id.
func (s *mcpServer) startRun(req *mcp.CallToolRequest, plan *runPlan, caseName, consent string, class agent.Class) (*liveRun, error) {
	runCtx, cancel := context.WithCancel(s.ctx)
	lr := &liveRun{kind: "run", tool: plan.inst.Ref, started: time.Now(), cancel: cancel, done: make(chan struct{}), consent: consent, caseName: caseName}
	ids := make(chan string, 1)
	ra := &runArgs{Case: caseName, Parallel: 1, onStart: func(id, _ string) { ids <- id }}
	go func() {
		defer close(lr.done)
		defer cancel()
		// Tool stderr goes only to the saved .stderr.txt file: the server's stderr is the client's log.
		lr.env, lr.meta, lr.err = s.a.execute(runCtx, plan.inst, plan.values, plan.secrets, plan.target, ra, io.Discard)
		outcome, code, id := "error", (*int)(nil), ""
		switch {
		case lr.meta != nil:
			outcome, id = lr.meta.Status, lr.meta.RunID
			if lr.meta.ExitCode >= 0 {
				c := lr.meta.ExitCode
				code = &c
			}
		case lr.env != nil:
			outcome, id = results.StatusComplete, lr.env.RunID
			c := lr.env.ExitCode
			code = &c
		}
		errText := ""
		if lr.err != nil && outcome == "error" {
			errText = lr.err.Error()
		}
		s.audit(req, "run", plan.inst, plan.values, class, consent, outcome, code, id, errText)
	}()
	select {
	case id := <-ids:
		lr.id = id
	case <-lr.done:
		// It failed before it started (no Docker, results folder not writable).
		return nil, lr.err
	}
	s.track(lr)
	return lr, nil
}

// runResult turns a run into what run_tool returns, sized to fit max_output_chars.
func (s *mcpServer) runResult(lr *liveRun) (*mcp.CallToolResult, *runOut, error) {
	out := &runOut{RunID: lr.id, Tool: lr.tool, Consent: lr.consent, Entities: []envelope.Entity{}, Note: untrustedNote}
	if !lr.isDone() {
		out.Status, out.Note = "running", "still running: poll get_run with run_id, or stop it with cancel_run"
		return s.withLink(out, lr.id), out, nil
	}
	if lr.err != nil && lr.meta == nil && lr.env == nil {
		return nil, nil, asToolError(lr.err)
	}
	var ents []envelope.Entity
	if lr.meta != nil {
		out.Status, out.Warnings, ents, out.Artifact = lr.meta.Status, lr.meta.Warnings, lr.meta.Entities, lr.meta.Artifact
		out.DurationMS = int64(lr.meta.DurationSeconds * 1000)
		if lr.meta.ExitCode >= 0 {
			c := lr.meta.ExitCode
			out.ExitCode = &c
		}
	}
	if lr.env != nil {
		out.Output, out.Artifact, ents, out.DurationMS = lr.env.Output, lr.env.Artifact, lr.env.Entities, lr.env.DurationMS
		if out.Status == "" {
			out.Status = results.StatusComplete
			if lr.env.ExitCode != 0 {
				out.Status = results.StatusFailed
			}
		}
	}
	if lr.err != nil {
		out.Error = clean(lr.err.Error())
	}
	out.EntitiesTotal = len(ents)
	budget := s.sess.Policy.MaxOutputChars
	for _, e := range cleanEntities(ents) {
		out.Entities = append(out.Entities, e)
		if b, _ := json.Marshal(out); len(b) > budget {
			out.Entities, out.Truncated = out.Entities[:len(out.Entities)-1], true
			break
		}
	}
	return s.withLink(out, lr.id), out, nil
}

// withLink is the result's text: the untrusted-data note, the JSON, and a link to the saved run.
func (s *mcpServer) withLink(out any, runID string) *mcp.CallToolResult {
	b, _ := json.Marshal(out)
	return &mcp.CallToolResult{Content: []mcp.Content{
		&mcp.TextContent{Text: string(b)},
		&mcp.ResourceLink{URI: "ot://runs/" + runID, Name: "run " + runID, MIMEType: "application/json", Description: "the saved run's envelope and sidecar"},
	}}
}

// runDetails are the consent question's lines for a run.
func (s *mcpServer) runDetails(inst *state.Installed) []string {
	m := inst.Manifest
	d := []string{"This tool " + strings.Join(agent.Describe(m), ", and ") + "."}
	var needs, ifSet []string
	for _, sec := range m.Secrets {
		switch {
		case sec.Required:
			needs = append(needs, sec.Name)
		case keySet(sec.Name):
			ifSet = append(ifSet, sec.Name)
		}
	}
	if len(needs)+len(ifSet) > 0 {
		d = append(d, "It uses your API keys: "+strings.Join(append(needs, ifSet...), ", ")+".")
	}
	d = append(d, "Image: "+inst.Artifact)
	if inst.Signer != "" {
		d = append(d, "Signature verified against "+inst.Signer+".")
	}
	if m.Summary != "" {
		d = append(d, "What it does: "+m.Summary)
	}
	return d
}

func describeInputs(values map[string]string) string {
	var parts []string
	for _, k := range sortedKeys(values) {
		parts = append(parts, k+"="+values[k])
	}
	return strings.Join(parts, ", ")
}

func refusal(d agent.Decision) error {
	te := &toolError{Code: d.Code, Message: d.Reason}
	switch d.Code {
	case "rate_limited":
		te.Extra = map[string]any{"retry_after_s": int(d.RetryAfter.Seconds())}
		te.Hint = "wait and try again, or ask the person to raise the limit in " + agent.PolicyPath()
	case "tool_not_allowed", "agent_disabled":
		te.Hint = "only the person can change " + agent.PolicyPath()
	}
	return te
}

// audit writes one side effect to the local audit log.
func (s *mcpServer) audit(req *mcp.CallToolRequest, action string, inst *state.Installed, values map[string]string, class agent.Class, consent, outcome string, code *int, runID, errText string) {
	e := agent.Entry{Client: clientName(req.Session), Action: action, Inputs: values, Class: class, Consent: consent, Outcome: outcome, ExitCode: code, RunID: runID, Error: errText}
	if inst != nil {
		e.Tool, e.Digest = inst.Ref+"@"+inst.Version, inst.Artifact
	}
	if err := agent.Record(s.sess.Policy, e); err != nil {
		fmt.Fprintf(s.a.Err, "warning: could not write the audit log: %v\n", err)
	}
}

// ---------- installs ----------

func (s *mcpServer) installTool(ctx context.Context, req *mcp.CallToolRequest, in installIn) (*mcp.CallToolResult, *installRecord, error) {
	ref, err := parseRef(in.Tool)
	if err != nil || ref.LocalPath != "" {
		return nil, nil, &toolError{Code: "usage", Message: fmt.Sprintf("give a published package as namespace/name, not %q", in.Tool)}
	}
	d := s.sess.DecideInstall(ref.Ref())
	if d.Verdict == agent.Refuse {
		return nil, nil, refusal(d)
	}
	consent := "policy"
	if d.Verdict == agent.Ask {
		info, err := s.toolInfo(ctx, ref.Ref())
		if err != nil {
			return nil, nil, asToolError(err)
		}
		details := []string{"Pulls and trusts its image (or Python package); every run still happens in the sandbox."}
		if info.Trust != nil {
			details = append(details, fmt.Sprintf("Signed: %v. Verified publisher: %v. Health: %s. Installs in 30 days: %d.", info.Trust.Signed, info.Trust.Verified, orDefault(info.Trust.Health, "unknown"), info.Trust.Installs30d))
		}
		details = append(details, "Runs of it "+strings.Join(info.Effects, ", and ")+".")
		ans, err := s.ask(consentRequest{req: req, artifact: ref.Ref() + "@" + orDefault(ref.Version, info.Version), keys: []string{d.Key}, token: in.ConsentToken,
			question: fmt.Sprintf("Install %s %s? %s", info.Ref, orDefault(ref.Version, info.Version), info.Summary), details: details})
		if err != nil {
			return nil, nil, err
		}
		if ans.pending != nil {
			return ans.pending, nil, nil
		}
		consent = ans.method
	}
	inst, err := s.a.install(ctx, ref, false)
	if err != nil {
		s.audit(req, "install", &state.Installed{Ref: ref.Ref(), Version: ref.Version}, nil, "", consent, "error", nil, "", err.Error())
		return nil, nil, asToolError(err)
	}
	s.audit(req, "install", inst, nil, "", consent, "installed", nil, "", "")
	r := recordOf(inst)
	return nil, &r, nil
}

func (s *mcpServer) uninstallTool(ctx context.Context, req *mcp.CallToolRequest, in uninstallIn) (*mcp.CallToolResult, *idOut, error) {
	st, err := state.Load()
	if err != nil {
		return nil, nil, asToolError(err)
	}
	inst := st.Installed[in.Tool]
	if inst == nil {
		return nil, nil, &toolError{Code: "not_installed", Message: in.Tool + " is not installed"}
	}
	d := s.sess.DecideUninstall(inst.Ref)
	if d.Verdict == agent.Refuse {
		return nil, nil, refusal(d)
	}
	ans, err := s.ask(consentRequest{req: req, artifact: inst.Artifact, token: in.ConsentToken, question: fmt.Sprintf("Uninstall %s %s?", inst.Ref, inst.Version),
		details: []string{"Removes it from this machine. Saved runs are kept."}})
	if err != nil {
		return nil, nil, err
	}
	if ans.pending != nil {
		return ans.pending, nil, nil
	}
	_ = s.a.Runner.Uninstall(ctx, inst)
	delete(st.Installed, inst.Ref)
	if err := st.Save(); err != nil {
		return nil, nil, asToolError(err)
	}
	s.audit(req, "uninstall", inst, nil, "", ans.method, "uninstalled", nil, "", "")
	return nil, &idOut{ID: inst.Ref, Status: "uninstalled"}, nil
}

// ---------- batches ----------

func (s *mcpServer) runAll(ctx context.Context, req *mcp.CallToolRequest, in batchIn) (*mcp.CallToolResult, *batchOut, error) {
	var selection []*state.Installed
	if len(in.Tools) > 0 {
		st, err := state.Load()
		if err != nil {
			return nil, nil, asToolError(err)
		}
		for _, t := range in.Tools {
			inst := st.Installed[t]
			if inst == nil {
				return nil, nil, &toolError{Code: "not_installed", Message: t + " is not installed", Hint: "install it with install_tool, or leave it out"}
			}
			selection = append(selection, inst)
		}
	}
	return s.batch(ctx, req, batchSpec{target: in.Target, inputType: in.InputType, parallel: in.Parallel, caseName: in.Case, dryRun: in.DryRun,
		wait: in.WaitSeconds, token: in.ConsentToken, selection: selection, what: "run_all"})
}

func (s *mcpServer) runPlaybook(ctx context.Context, req *mcp.CallToolRequest, in playbookIn) (*mcp.CallToolResult, *batchOut, error) {
	p, err := playbook.Find(playbook.Dirs(state.Home()), in.Name)
	if err != nil {
		return nil, nil, &toolError{Code: "playbook_not_found", Message: err.Error(), Hint: "list_playbooks lists them"}
	}
	st, err := state.Load()
	if err != nil {
		return nil, nil, asToolError(err)
	}
	var selection []*state.Installed
	var missing []string
	for _, ref := range p.Tools {
		if inst := st.Installed[ref]; inst != nil {
			selection = append(selection, inst)
		} else {
			missing = append(missing, ref)
		}
	}
	if len(missing) > 0 {
		return nil, nil, &toolError{Code: "not_installed", Message: fmt.Sprintf("playbook %s needs tools that are not installed: %s", p.Name, strings.Join(missing, ", ")),
			Hint: "install them with install_tool first", Extra: map[string]any{"missing": missing}}
	}
	return s.batch(ctx, req, batchSpec{target: in.Target, inputType: in.InputType, parallel: in.Parallel, caseName: orDefault(in.Case, p.Case), dryRun: in.DryRun,
		wait: in.WaitSeconds, token: in.ConsentToken, selection: selection, what: "playbook " + p.Name})
}

type batchSpec struct {
	target, inputType, caseName, token, what string
	parallel, wait                           int
	dryRun                                   bool
	selection                                []*state.Installed
}

func prefixFor(inputType string) string {
	for p, t := range runner.TypedPrefixes {
		if t == inputType {
			return p
		}
	}
	return ""
}

func (s *mcpServer) batch(ctx context.Context, req *mcp.CallToolRequest, b batchSpec) (*mcp.CallToolResult, *batchOut, error) {
	typ := b.inputType
	if typ == "" {
		typ = runner.TypedPrefixes[runner.DetectType(b.target)]
	}
	prefix := prefixFor(typ)
	if prefix == "" {
		return nil, nil, &toolError{Code: "usage", Message: fmt.Sprintf("batches take a username, domain, email, phone, ip or url target, not %s; run_tool runs one tool with any input", typ)}
	}
	p := s.sess.Policy
	ra := &runArgs{Typed: []runner.TypedInput{{Prefix: prefix, Value: strings.TrimSpace(b.target)}}, Parallel: min(orInt(b.parallel, p.MaxParallel), p.MaxParallel), Case: b.caseName}
	rows, jobs, err := s.a.planAll(ra, b.what, b.selection)
	if err != nil {
		return nil, nil, asToolError(err)
	}
	// What the policy says about each job: refused ones are skipped, the rest may need one question.
	var run []allJob
	var keys, asks []string
	for _, j := range jobs {
		if j.inst.Native {
			j.row.Status, j.row.Reason = "skipped", "installed with --native, so it would run outside the sandbox"
			continue
		}
		if p.Mode == "sandbox" {
			if v, err := sandboxValues(j.inst.Manifest); err == nil {
				j.values = v
			}
		}
		d := s.sess.DecideRun(j.inst.Manifest, j.values)
		switch d.Verdict {
		case agent.Refuse:
			j.row.Status, j.row.Reason = "skipped", d.Code+": "+d.Reason
			continue
		case agent.Ask:
			keys = append(keys, d.Key)
			asks = append(asks, fmt.Sprintf("%s: %s", j.inst.Ref, strings.Join(agent.Describe(j.inst.Manifest), ", ")))
		}
		run = append(run, j)
	}
	id := "b" + results.NewRunID()[:7]
	out := func(lr *liveRun) *batchOut { return s.batchResult(lr) }
	if b.dryRun {
		for _, j := range run {
			j.row.Status = "would run"
		}
		lr := &liveRun{id: id, kind: "batch", rows: rows, done: closed(), caseName: b.caseName}
		res := out(lr)
		res.Status = "planned"
		res.Note = fmt.Sprintf("Nothing was run. %d of these would need the person's consent first.", len(asks))
		return nil, res, nil
	}
	if len(run) == 0 {
		return nil, nil, &toolError{Code: "usage", Message: "nothing can run", Extra: map[string]any{"rows": rows}}
	}
	consent := "policy"
	if len(asks) > 0 {
		artifacts := []string{}
		for _, j := range run {
			artifacts = append(artifacts, j.inst.Artifact)
		}
		sort.Strings(artifacts)
		ans, err := s.ask(consentRequest{req: req, artifact: strings.Join(artifacts, ","), keys: keys, token: b.token,
			question: fmt.Sprintf("Run %d tools on %s %s?", len(run), typ, b.target),
			details:  asks})
		if err != nil {
			return nil, nil, err
		}
		if ans.pending != nil {
			return ans.pending, nil, nil
		}
		consent = ans.method
	}
	runCtx, cancel := context.WithCancel(s.ctx)
	lr := &liveRun{id: id, kind: "batch", tool: b.what, started: time.Now(), cancel: cancel, done: make(chan struct{}), consent: consent, caseName: b.caseName, rows: rows}
	s.track(lr)
	for _, j := range run {
		s.sess.Started(j.values)
		j.row.Status = "running"
	}
	go func() {
		defer close(lr.done)
		defer cancel()
		s.a.runJobs(runCtx, ra, run, func(row *allResult) {
			lr.mu.Lock()
			lr.finished++
			lr.mu.Unlock()
		})
		lr.mu.Lock()
		lr.outcome = allOutcome(runCtx, rows)
		lr.mu.Unlock()
		for _, j := range run {
			var code *int
			if j.row.ExitCode != nil {
				c := *j.row.ExitCode
				code = &c
			}
			s.audit(req, "run", j.inst, j.values, agent.Classify(j.inst.Manifest, j.values), consent, j.row.Status, code, j.row.RunID, j.row.Reason)
		}
	}()
	waitFor(ctx, lr, b.wait)
	res := out(lr)
	return nil, res, nil
}

func closed() chan struct{} {
	c := make(chan struct{})
	close(c)
	return c
}

// batchResult reads a batch's rows. While it runs, only finished rows are complete.
func (s *mcpServer) batchResult(lr *liveRun) *batchOut {
	out := &batchOut{BatchID: lr.id, Case: lr.caseName, Rows: []*allResult{}, Summary: map[string]int{}, Note: untrustedNote}
	if !lr.isDone() {
		lr.mu.Lock()
		out.Status = "running"
		out.Summary["finished"] = lr.finished
		lr.mu.Unlock()
		out.Summary["total"] = len(lr.rows)
		out.Note = "still running: call get_batch again in a little while, or cancel_run"
		for _, r := range lr.rows {
			out.Rows = append(out.Rows, &allResult{Tool: r.Tool, Version: r.Version, Status: "pending"})
		}
		return out
	}
	lr.mu.Lock()
	outcome := lr.outcome
	lr.mu.Unlock()
	out.Status = "complete"
	if outcome != nil {
		out.Status = map[bool]string{true: "interrupted", false: "failed"}[ExitCodeFor(outcome) == ExitInterrupted]
	}
	for _, r := range lr.rows {
		c := *r
		c.TopEntities = cleanEntities(r.TopEntities)
		c.Reason = clean(r.Reason)
		out.Rows = append(out.Rows, &c)
		out.Summary[r.Status]++
	}
	out.Summary["total"] = len(lr.rows)
	return out
}
