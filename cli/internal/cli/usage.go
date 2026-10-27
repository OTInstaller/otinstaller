package cli

// Usage counts. ot counts installs and runs so the registry can show which tools are used, and which versions fail
// for most people before anyone reports them. Everything that can be sent is in the api package's Install, RunCount,
// InstallFailure and RunsBody: the package and version, how a run ended and how long it took, its container engine and
// what started it, the client, OS, architecture and ot version, why an install failed, and first-time milestones;
// never inputs, targets, results, paths, run ids, case names, command lines, keys or tokens. The registry keeps daily
// totals. `ot telemetry off`, OT_NO_TELEMETRY, DO_NOT_TRACK and "telemetry": false in config.json turn it all off, and
// OT_TELEMETRY_DEBUG=1 prints what would be sent instead of sending it. Local manifests, and dev builds talking to the
// public registry, are never counted. Counts go in the background, so no command waits on the registry for long.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// How long a command waits, when it ends, for its counts to be sent (less after Ctrl-C), how long ot mcp gathers runs
// before sending them, and how long a POST may take. Tests shorten them.
var (
	usageWait            = 1500 * time.Millisecond
	usageWaitInterrupted = 500 * time.Millisecond
	usageDebounce        = 2 * time.Second
	usageTimeout         = 10 * time.Second
)

const (
	// usageBatch is the most rows one POST /runs carries, usageFailures the most install failures among them.
	usageBatch    = 100
	usageFailures = 50
	// usagePending is the most rows held while the registry is slow; more are dropped.
	usagePending = 1000
	// unreachableFor is how long after the registry was last out of reach a command ends without waiting for counts.
	unreachableFor = time.Hour
)

// noticeText is the one-time notice, printed at a terminal before the first command that may count something.
const noticeText = "note: ot counts installs and runs (the tool, its version and how each run ended; never your inputs, targets or results) so we can see which tools work. `ot telemetry off` turns it off: %s\n"

// startedOutcomes are the outcomes of runs that ran the tool.
var startedOutcomes = []string{"ok", "empty", "error", "timeout", "interrupted"}

// otVersion is ot's version as the counts carry it: without the v that release builds have.
func otVersion() string { return strings.TrimPrefix(Version, "v") }

// counting says whether this ot counts anything: telemetry is on, and it isn't a dev build talking to the public
// registry, which would count a developer's test runs.
func (a *App) counting() bool {
	if a.Config == nil || !a.Config.TelemetryEnabled() || a.API == nil {
		return false
	}
	return Version != "dev" || strings.TrimRight(a.API.Base, "/") != state.DefaultAPIURL
}

// mayCount says whether an install or run of inst is counted: counting is on, and it is a registry package (never one
// installed from a local manifest, even when it runs under its registry name).
func (a *App) mayCount(inst *state.Installed) bool {
	if inst == nil || inst.Local || !a.counting() {
		return false
	}
	ns, name, ok := strings.Cut(inst.Ref, "/")
	return ok && ns != "" && name != "" && !strings.Contains(name, "/") && inst.Version != ""
}

// runOutcome says how a run ended, the first of these that applies: timeout; interrupted (Ctrl-C, cancel_run, or the
// MCP client going away); no_engine; not_started (it never ran: no results folder, no pipx binary...); engine_error
// (exit 125 from Docker or Podman, whose daemon failed); error (a non-zero exit); empty (exit 0 without entities); ok.
func runOutcome(ctx context.Context, inst *state.Installed, env *envelope.Envelope, meta *results.Meta, err error) string {
	var timeout *runner.TimeoutError
	var missing *runner.RuntimeMissingError
	switch {
	case errors.As(err, &timeout):
		return "timeout"
	case ctx.Err() != nil:
		return "interrupted"
	case errors.As(err, &missing):
		return "no_engine"
	case env == nil && meta == nil:
		return "not_started"
	}
	code, entities := 0, 0
	if meta != nil {
		code, entities = meta.ExitCode, len(meta.Entities)
	} else {
		code, entities = env.ExitCode, len(env.Entities)
	}
	inContainer := inst.Runtime == "docker" || (inst.Runtime == "pipx" && !inst.Native)
	switch {
	case code == 125 && inContainer:
		return "engine_error"
	case code != 0:
		return "error"
	case entities == 0:
		return "empty"
	}
	return "ok"
}

// countRun counts one run of inst. via says what started it: run, all, playbook, auto or mcp.
func (a *App) countRun(ctx context.Context, inst *state.Installed, outcome string, took time.Duration, via string) {
	if !a.mayCount(inst) {
		return
	}
	var reached []string
	if slices.Contains(startedOutcomes, outcome) {
		reached = append(reached, "first_run")
	}
	if outcome == "ok" {
		reached = append(reached, "first_ok_run")
	}
	r := &api.RunCount{Tool: inst.Ref, Version: inst.Version, Outcome: outcome, DurationMS: took.Milliseconds(),
		Engine: orDefault(a.engineName(inst.Native), "none"), Via: orDefault(via, "run")}
	a.sink().add(ctx, a, usageRow{run: r}, reached...)
}

// countInstall counts an install that worked; the machine's first one says so.
func (a *App) countInstall(ctx context.Context, inst *state.Installed) {
	if !a.mayCount(inst) {
		return
	}
	in := &api.Install{Tool: inst.Ref, Version: inst.Version, Client: a.clientKind(), FromBackup: inst.FromBackup,
		OS: runtime.GOOS, Arch: runtime.GOARCH, Engine: orDefault(a.engineName(inst.Native), "none"), OTVersion: otVersion()}
	a.sink().add(ctx, a, usageRow{install: in}, "first_install")
}

// countInstallFailure counts an install of a known version that failed, and why (runner.FailureReason, or refused);
// one stopped by Ctrl-C is interrupted.
func (a *App) countInstallFailure(ctx context.Context, inst *state.Installed, reason string) {
	if !a.mayCount(inst) {
		return
	}
	if ctx.Err() != nil {
		reason = "interrupted"
	}
	a.sink().add(ctx, a, usageRow{failure: &api.InstallFailure{Tool: inst.Ref, Version: inst.Version, Reason: reason}})
}

// mcpClientName is what the client of an ot mcp session calls itself (ClientInfo.Name, which the audit log records).
func mcpClientName(ss *mcp.ServerSession) string {
	if ss != nil {
		if p := ss.InitializeParams(); p != nil && p.ClientInfo != nil {
			return p.ClientInfo.Name
		}
	}
	return ""
}

// mcpClientSlug is an MCP client's name in the words usage counts use. Words are matched, the more specific first:
// Cursor calls itself cursor-vscode. Anything else is other.
func mcpClientSlug(name string) string {
	words := strings.FieldsFunc(strings.ToLower(name), func(r rune) bool { return (r < 'a' || r > 'z') && (r < '0' || r > '9') })
	has := func(w string) bool { return slices.Contains(words, w) }
	switch {
	case has("claude") && has("code"):
		return "claude_code"
	case has("claude"):
		return "claude_desktop"
	case has("cursor"):
		return "cursor"
	case has("windsurf"):
		return "windsurf"
	case has("vscode"), has("visual") && has("studio"), has("copilot"):
		return "vscode"
	}
	for _, w := range []string{"codex", "gemini", "zed", "cline", "continue", "goose"} {
		if has(w) {
			return w
		}
	}
	return "other"
}

// prepareCounts runs before every command but help and completion: it reads telemetry.json (creating it, so a machine
// that already has packages starts with its milestones reached) and prints the one-time notice where a person sees it.
func (a *App) prepareCounts(cmd *cobra.Command, args []string) {
	top := topLevel(cmd)
	switch top {
	case "", "help", "completion", cobra.ShellCompRequestCmd, cobra.ShellCompNoDescRequestCmd:
		return
	}
	if !a.counting() {
		return
	}
	s := a.sink()
	s.mu.Lock()
	defer s.mu.Unlock()
	t := s.telemetry()
	if !t.NoticeShownAt.IsZero() || top == "telemetry" || top == "start" || top == "mcp" || a.AgentMode ||
		os.Getenv("CI") != "" || !a.interactive() || a.jsonMode() || jsonRequested(args) {
		return
	}
	fmt.Fprintf(a.Err, noticeText, privacyURL(a))
	t.NoticeShownAt = time.Now().UTC()
	_ = t.Save()
}

// privacyURL is the privacy policy, which says what is counted.
func privacyURL(a *App) string {
	return strings.TrimRight(a.Config.SiteURL, "/") + "/policy/privacy"
}

// noticeShown records that the person has seen what is counted another way (`ot start`'s telemetry step, `ot telemetry`).
func (a *App) noticeShown() {
	s := a.sink()
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.reload(); t.NoticeShownAt.IsZero() {
		t.NoticeShownAt = time.Now().UTC()
		_ = t.Save()
	}
}

// waitForCounts gives the counts a command made a moment to be sent before ot exits: up to usageWait, less after
// Ctrl-C, and not at all when the registry was out of reach in the last hour. It is called from Execute because cobra
// skips PersistentPostRun when a command fails.
func (a *App) waitForCounts(ctx context.Context) {
	max := usageWait
	if ctx.Err() != nil {
		max = usageWaitInterrupted
	}
	a.sink().wait(max)
}

// ---------- the sink ----------

// usageSink holds counts until a background goroutine sends them, one POST at a time, so rows from parallel runs
// (--all, playbooks, MCP batches) share POSTs. It is safe for concurrent use.
type usageSink struct {
	mu      sync.Mutex
	pending []usageRow
	// milestones were reached and wait for the next POST /runs.
	milestones []string
	// tel is telemetry.json as this process knows it; nil until it is first needed.
	tel *state.Telemetry
	// mcpClient is the AI client of this ot mcp session (mcpClientSlug).
	mcpClient string
	// sending is true while the sender goroutine runs; idle is closed when it stops, and closing flush ends its wait for
	// more rows under ot mcp.
	sending bool
	idle    chan struct{}
	flush   chan struct{}
	flushed bool
	// lastPost is how the last POST went: "", ok or unreachable. The sender never writes files (it may outlive the
	// command), so wait records it in telemetry.json.
	lastPost string
}

// usageRow is one install, run or install failure waiting to be sent, and where to.
type usageRow struct {
	install *api.Install
	run     *api.RunCount
	failure *api.InstallFailure
	to      usageTarget
}

// usageTarget is what a POST needs besides its rows. Rows are batched only with rows of the same target.
type usageTarget struct {
	ctx    context.Context
	api    *api.Client
	client string
	mcp    string
	// agent is ot mcp: rows wait usageDebounce for others, and config.json is read again before sending.
	agent bool
}

func (t usageTarget) same(o usageTarget) bool {
	return t.api == o.api && t.client == o.client && t.mcp == o.mcp
}

// sinkMu guards making an App's sink. It isn't in App, which describeMCP copies.
var sinkMu sync.Mutex

func (a *App) sink() *usageSink {
	sinkMu.Lock()
	defer sinkMu.Unlock()
	if a.usage == nil {
		a.usage = &usageSink{}
	}
	return a.usage
}

// setMCPClient says which AI client the runs and installs of this ot mcp session come from.
func (s *usageSink) setMCPClient(slug string) {
	s.mu.Lock()
	s.mcpClient = slug
	s.mu.Unlock()
}

// telemetry is telemetry.json, read once; the caller holds mu.
func (s *usageSink) telemetry() *state.Telemetry {
	if s.tel == nil {
		s.tel = state.LoadTelemetry()
	}
	return s.tel
}

// reload reads telemetry.json again before a change, so what another ot process wrote meanwhile is kept; the caller
// holds mu.
func (s *usageSink) reload() *state.Telemetry {
	s.tel = state.LoadTelemetry()
	return s.tel
}

// reach marks a milestone reached and reports whether it wasn't already, on this machine; the caller holds mu. With
// debug, which sends nothing, it isn't marked, so it is still sent once debugging ends.
func (s *usageSink) reach(m string, debug bool) bool {
	if s.telemetry().Reached(m) {
		return false
	}
	t := s.reload()
	if t.Reached(m) || debug {
		return !t.Reached(m)
	}
	t.Milestones = append(t.Milestones, m)
	_ = t.Save()
	return true
}

// add queues a row with the milestones it reaches, and starts the sender if it isn't running. A full queue drops it.
// With OT_TELEMETRY_DEBUG=1 it prints the POST the row would go in, there and then, and queues nothing.
func (s *usageSink) add(ctx context.Context, a *App, row usageRow, milestones ...string) {
	row.to = usageTarget{ctx: context.WithoutCancel(ctx), api: a.API, client: a.clientKind(), agent: a.AgentMode}
	debug := os.Getenv("OT_TELEMETRY_DEBUG") == "1"
	s.mu.Lock()
	defer s.mu.Unlock()
	if row.to.client == "mcp" {
		row.to.mcp = orDefault(s.mcpClient, "other")
	}
	if !debug && len(s.pending) >= usagePending {
		return
	}
	var reached []string
	for _, m := range milestones {
		if !s.reach(m, debug) {
			continue
		}
		if row.install != nil && m == "first_install" {
			// The first install travels with the install itself.
			row.install.First = true
		} else {
			reached = append(reached, m)
		}
	}
	if debug {
		path, body := "/installs", any(row.install)
		if row.install == nil {
			b := runsBody(row.to, reached)
			b.add(row)
			path, body = "/runs", b.RunsBody
		}
		raw, _ := json.Marshal(body)
		fmt.Fprintf(a.Err, "telemetry: POST %s %s\n", path, raw)
		return
	}
	s.milestones = append(s.milestones, reached...)
	s.pending = append(s.pending, row)
	if !s.sending {
		s.sending, s.flushed = true, false
		s.idle, s.flush = make(chan struct{}), make(chan struct{})
		go s.send(s.idle, s.flush)
	}
}

// drop forgets every count not sent yet.
func (s *usageSink) drop() {
	s.mu.Lock()
	s.pending, s.milestones = nil, nil
	s.mu.Unlock()
}

// usagePost is one POST: an install, or a batch of runs and install failures.
type usagePost struct {
	to      usageTarget
	install *api.Install
	runs    *api.RunsBody
}

// next takes the next POST off the queue, or stops the sender (closing idle) when nothing is left.
func (s *usageSink) next(idle chan struct{}) (*usagePost, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.pending) == 0 {
		s.sending = false
		close(idle)
		return nil, false
	}
	first := s.pending[0]
	if first.install != nil {
		s.pending = s.pending[1:]
		return &usagePost{to: first.to, install: first.install}, true
	}
	body := runsBody(first.to, s.milestones)
	s.milestones = nil
	n := 0
	for _, r := range s.pending {
		if r.install != nil || !r.to.same(first.to) || len(body.Runs)+len(body.InstallFailures) == usageBatch ||
			(r.failure != nil && len(body.InstallFailures) == usageFailures) {
			break
		}
		body.add(r)
		n++
	}
	s.pending = s.pending[n:]
	return &usagePost{to: first.to, runs: body.RunsBody}, true
}

// usageBody is a POST /runs being filled.
type usageBody struct{ *api.RunsBody }

func runsBody(to usageTarget, milestones []string) usageBody {
	return usageBody{&api.RunsBody{OTVersion: otVersion(), Client: to.client, OS: runtime.GOOS, Arch: runtime.GOARCH, MCPClient: to.mcp,
		Runs: []api.RunCount{}, Milestones: milestones}}
}

func (b usageBody) add(r usageRow) {
	if r.run != nil {
		b.Runs = append(b.Runs, *r.run)
	} else if r.failure != nil {
		b.InstallFailures = append(b.InstallFailures, *r.failure)
	}
}

// send is the sender goroutine: it posts until the queue is empty. Under ot mcp it first waits for more rows, unless
// the command is ending.
func (s *usageSink) send(idle, flush chan struct{}) {
	for {
		s.mu.Lock()
		agent := len(s.pending) > 0 && s.pending[0].to.agent
		s.mu.Unlock()
		if agent {
			select {
			case <-time.After(usageDebounce):
			case <-flush:
			}
		}
		p, ok := s.next(idle)
		if !ok {
			return
		}
		s.post(p)
	}
}

// post sends one POST. Nothing about it reaches the person: a failure drops the rows, a registry out of reach drops
// everything waiting (and wait remembers it for an hour), and any other answer (a 404 from a registry before run
// counts) is ignored.
func (s *usageSink) post(p *usagePost) {
	if p.to.agent && !state.LoadConfig().TelemetryEnabled() {
		// `ot telemetry off` while ot mcp runs.
		s.drop()
		return
	}
	ctx, cancel := context.WithTimeout(p.to.ctx, usageTimeout)
	defer cancel()
	var err error
	if p.install != nil {
		err = p.to.api.InstallPing(ctx, *p.install)
	} else {
		err = p.to.api.Runs(ctx, *p.runs)
	}
	var unreachable *api.UnreachableError
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case errors.As(err, &unreachable):
		s.pending, s.milestones, s.lastPost = nil, nil, "unreachable"
	case err == nil:
		s.lastPost = "ok"
	}
}

// wait waits up to max for what is queued to be sent, ending any wait for more rows, then records in telemetry.json
// whether the registry answered. When the counts don't all go in time, the registry counts as out of reach, so the
// next commands don't wait either; when it was out of reach in the last hour, wait doesn't wait.
func (s *usageSink) wait(max time.Duration) {
	s.mu.Lock()
	sending, idle := s.sending, s.idle
	if !sending && s.lastPost == "" {
		s.mu.Unlock()
		return
	}
	if sending && !s.flushed {
		close(s.flush)
		s.flushed = true
	}
	if since := time.Since(s.telemetry().UnreachableAt); since >= 0 && since < unreachableFor {
		max = 0
	}
	s.mu.Unlock()
	late := false
	if sending && max > 0 {
		t := time.NewTimer(max)
		defer t.Stop()
		select {
		case <-idle:
		case <-t.C:
			late = true
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch {
	case late || s.lastPost == "unreachable":
		t := s.reload()
		t.UnreachableAt = time.Now().UTC()
		_ = t.Save()
	case s.lastPost == "ok" && !s.telemetry().UnreachableAt.IsZero():
		t := s.reload()
		t.UnreachableAt = time.Time{}
		_ = t.Save()
	}
	s.lastPost = ""
}
