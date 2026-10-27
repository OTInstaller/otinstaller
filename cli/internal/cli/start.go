package cli

// `ot start`: set ot up in one go, the way `shadcn create` sets up a project. At a terminal it is a wizard (huh
// forms) pre-filled from the flags; with --yes it applies the flags as they are, and --dry-run shows what they would
// do. Either way it writes only the config.json keys the person changed, adds ot's MCP server to the chosen AI clients,
// installs the chosen tools and, at a terminal, walks through their API keys. otinstaller.com/start builds the same
// flags, so keep the two in step (the site's lib/start.ts and docs/cli.md).

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/charmbracelet/huh"
	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/playbook"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// startChoices is everything `ot start` sets up. An empty setting is left as it is.
type startChoices struct {
	// Playbooks are bundled playbooks whose tools to install; Tools are more tools (ns/name).
	Playbooks []string
	Tools     []string
	// Agents are AI clients to add ot's MCP server to (mcpClients).
	Agents []string
	// Format is `ot run`'s default output format; ResultsDir where runs are saved (resultsHere: ./results).
	Format     string
	ResultsDir string
	// Telemetry is on or off; Registry the registry API's base URL.
	Telemetry string
	Registry  string
	// Keys walks through the tools' API keys after installing, at a terminal.
	Keys   bool
	Native bool
}

// startFormats are the formats a single `ot run` can print (envelope.Write), json being the default.
var startFormats = []string{"json", "table", "csv", "raw"}

// resultsHere is results_dir's default: ./results in whatever folder ot runs in.
const resultsHere = "results"

// errStartDeclined is the wizard's answer when the person reviewed the plan and chose not to apply it.
var errStartDeclined = errors.New("not applied")

func (a *App) startCmd() *cobra.Command {
	c := &startChoices{}
	var yes, dryRun bool
	var packs []string
	if bundled, err := playbook.Bundled(); err == nil {
		for _, p := range bundled {
			packs = append(packs, p.Name)
		}
	}
	cmd := &cobra.Command{
		Use:   "start",
		Short: "Set ot up: pick tools, AI agents and settings, then install them",
		Long: "Sets ot up in one go. At a terminal it asks, with the flags as its starting point: starter packs (the bundled\n" +
			"playbooks) and tools from the registry, AI clients to add ot's MCP server to, the output format, where results\n" +
			"are saved, API keys, telemetry, and optionally the registry. Nothing changes until you confirm.\n\n" +
			"With --yes it does what the flags say without asking; --dry-run shows what that would be. Settings go to\n" +
			"config.json in ot's data folder, and only the ones you change. https://otinstaller.com/start builds these flags.",
		Example: "  ot start\n" +
			"  ot start --playbooks domain-recon,username-investigation --agents claude --format table\n" +
			"  ot start --tools osintverse-community/holehe --yes",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			bundled, err := playbook.Bundled()
			if err != nil {
				return err
			}
			if err := c.check(bundled); err != nil {
				return err
			}
			wizard := !yes && !dryRun
			if wizard && a.jsonMode() {
				return &ExitError{Code: ExitUsage, Reason: "input_required", Err: errors.New("--json needs --yes or --dry-run, since the wizard is for a person at a terminal")}
			}
			if wizard && !a.interactive() {
				return needsInput("`ot start` asks what to install and how to set ot up", "--yes to use the flags as they are", "--dry-run to see what they would do")
			}
			a.useRegistry(c.Registry)
			if wizard {
				cat, err := a.startCatalog(ctx, bundled)
				if err != nil {
					return err
				}
				wiz := a.StartWizard
				if wiz == nil {
					wiz = a.runStartWizard
				}
				switch err := wiz(ctx, cat, c); {
				case errors.Is(err, errStartDeclined):
					fmt.Fprintln(a.Out, "Nothing was changed.")
					return nil
				case errors.Is(err, huh.ErrUserAborted):
					return &ExitError{Code: ExitInterrupted, Reason: "interrupted", Err: errors.New("cancelled; nothing was changed")}
				case err != nil:
					return err
				}
				a.useRegistry(c.Registry)
			}
			plan, err := a.planStart(c, bundled)
			if err != nil {
				return err
			}
			if dryRun {
				rep := a.startReport(c, plan)
				rep.DryRun = true
				if a.jsonMode() {
					return writeJSON(a.Out, rep)
				}
				fmt.Fprintln(a.Out, "ot start would:")
				for _, l := range a.startLines(c, plan) {
					fmt.Fprintln(a.Out, "  "+l)
				}
				return nil
			}
			return a.applyStart(ctx, c, plan)
		},
	}
	f := cmd.Flags()
	f.StringSliceVar(&c.Playbooks, "playbooks", nil, "starter packs: bundled playbooks whose tools to install ("+strings.Join(packs, ", ")+")")
	f.StringSliceVar(&c.Tools, "tools", nil, "tools to install, as namespace/name")
	f.StringSliceVar(&c.Agents, "agents", nil, "AI clients to add ot's MCP server to ("+strings.Join(mcpClients, ", ")+")")
	f.StringVar(&c.Format, "format", "", "default output format of ot run ("+strings.Join(startFormats, ", ")+")")
	f.StringVar(&c.ResultsDir, "results-dir", "", "where runs are saved from now on (default ./results in the folder ot runs in)")
	f.StringVar(&c.Telemetry, "telemetry", "", "on or off: install and run counts, and the offer to report a failed run")
	f.StringVar(&c.Registry, "registry", "", "registry API URL, for a self-hosted or local registry (default "+state.DefaultAPIURL+")")
	f.BoolVar(&c.Keys, "keys", false, "walk through the tools' API keys after installing (needs a terminal)")
	f.BoolVar(&c.Native, "native", false, "install pipx tools on the host instead of in a container")
	f.BoolVarP(&yes, "yes", "y", false, "apply the flags without the wizard")
	f.BoolVar(&dryRun, "dry-run", false, "show what the flags would do, and change nothing")
	return cmd
}

// check checks the choices before anything changes, and puts them in their usual form: refs without versions, the
// registry URL with its /v1, ~ expanded in the results folder, no duplicates.
func (c *startChoices) check(bundled []*playbook.Playbook) error {
	var names []string
	for _, p := range bundled {
		names = append(names, p.Name)
	}
	for _, name := range c.Playbooks {
		if findPlaybook(bundled, name) == nil {
			return exitErr(ExitUsage, "there is no bundled playbook %q; the starter packs are %s", name, strings.Join(names, ", "))
		}
	}
	for i, t := range c.Tools {
		r, err := parseRef(t)
		if err != nil {
			return err
		}
		switch {
		case r.LocalPath != "":
			return exitErr(ExitUsage, "%s is a local manifest; `ot start` installs registry packages, so use `ot install %s`", t, t)
		case r.Version != "":
			return exitErr(ExitUsage, "`ot start` installs latest versions; leave out @%s, and pin one afterwards with `ot install %s`", r.Version, t)
		}
		c.Tools[i] = r.Ref()
	}
	for _, ag := range c.Agents {
		if !slices.Contains(mcpClients, ag) {
			return exitErr(ExitUsage, "unknown AI client %q; use %s", ag, strings.Join(mcpClients, ", "))
		}
	}
	if c.Format != "" && !slices.Contains(startFormats, c.Format) {
		return exitErr(ExitUsage, "unknown format %q; use %s", c.Format, strings.Join(startFormats, ", "))
	}
	if c.Telemetry != "" && c.Telemetry != "on" && c.Telemetry != "off" {
		return exitErr(ExitUsage, "--telemetry is on or off, not %q", c.Telemetry)
	}
	if c.Registry != "" {
		u, err := registryURL(c.Registry)
		if err != nil {
			return &ExitError{Code: ExitUsage, Err: err}
		}
		c.Registry = u
	}
	if c.ResultsDir != "" {
		c.ResultsDir = resultsFolder(c.ResultsDir)
	}
	c.Playbooks, c.Tools, c.Agents = dedupe(c.Playbooks), dedupe(c.Tools), dedupe(c.Agents)
	return nil
}

// registryURL checks a registry API URL and adds /v1 when it names only the host.
func registryURL(s string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(s))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", fmt.Errorf("the registry is a URL such as %s or http://127.0.0.1:8787/v1, not %q", state.DefaultAPIURL, s)
	}
	if strings.Trim(u.Path, "/") == "" {
		u.Path = "/v1"
	}
	return strings.TrimRight(u.String(), "/"), nil
}

// resultsFolder expands ~ in a results folder; ./results, the default, becomes resultsHere.
func resultsFolder(p string) string {
	p = strings.TrimSpace(p)
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			p = filepath.Join(home, p[1:])
		}
	}
	if filepath.Clean(p) == resultsHere {
		return resultsHere
	}
	return p
}

func dedupe(xs []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, x := range xs {
		if x != "" && !seen[x] {
			seen[x] = true
			out = append(out, x)
		}
	}
	return out
}

func findPlaybook(ps []*playbook.Playbook, name string) *playbook.Playbook {
	for _, p := range ps {
		if p.Name == name {
			return p
		}
	}
	return nil
}

// useRegistry points this run at another registry. The sign-in token belongs to the old one, so it stays behind.
func (a *App) useRegistry(u string) {
	if u == "" || u == strings.TrimRight(a.Config.APIURL, "/") {
		return
	}
	a.Config.APIURL = u
	a.API = api.New(u, Version)
}

// configChanges are the config.json keys the choices change, compared with the file as written: a value to set, or
// nil to remove a key and go back to the default.
func (c *startChoices) configChanges(file *state.Config) map[string]any {
	changes := map[string]any{}
	set := func(key, now, want, def string) {
		if want == "" || want == orDefault(now, def) {
			return
		}
		if want == def {
			changes[key] = nil
		} else {
			changes[key] = want
		}
	}
	set("format", file.Format, c.Format, "json")
	set("results_dir", file.ResultsDir, c.ResultsDir, resultsHere)
	set("api_url", strings.TrimRight(file.APIURL, "/"), c.Registry, state.DefaultAPIURL)
	on := file.Telemetry == nil || *file.Telemetry
	switch {
	case c.Telemetry == "off" && on:
		changes["telemetry"] = false
	case c.Telemetry == "on" && !on:
		changes["telemetry"] = nil
	}
	return changes
}

// startPlan is what applying the choices does.
type startPlan struct {
	Install          []string
	AlreadyInstalled []string
	Changes          map[string]any
	Packs            []*playbook.Playbook
}

func (a *App) planStart(c *startChoices, bundled []*playbook.Playbook) (*startPlan, error) {
	st, err := state.Load()
	if err != nil {
		return nil, err
	}
	p := &startPlan{Changes: c.configChanges(state.FileConfig())}
	seen := map[string]bool{}
	add := func(ref string) {
		if seen[ref] {
			return
		}
		seen[ref] = true
		if st.Installed[ref] != nil {
			p.AlreadyInstalled = append(p.AlreadyInstalled, ref)
		} else {
			p.Install = append(p.Install, ref)
		}
	}
	for _, name := range c.Playbooks {
		pb := findPlaybook(bundled, name)
		p.Packs = append(p.Packs, pb)
		for _, t := range pb.Tools {
			add(t)
		}
	}
	for _, t := range c.Tools {
		add(t)
	}
	return p, nil
}

// startCommandLine is the command that makes the same choices; with yes, without the wizard. Settings at their
// defaults are left out, as otinstaller.com/start leaves them out.
func startCommandLine(c *startChoices, yes bool) string {
	args := []string{"ot", "start"}
	list := func(flag string, v []string) {
		if len(v) > 0 {
			args = append(args, flag, strings.Join(v, ","))
		}
	}
	list("--playbooks", c.Playbooks)
	list("--tools", c.Tools)
	list("--agents", c.Agents)
	if c.Format != "" && c.Format != "json" {
		args = append(args, "--format", c.Format)
	}
	if c.ResultsDir != "" && c.ResultsDir != resultsHere {
		args = append(args, "--results-dir", c.ResultsDir)
	}
	if c.Telemetry == "off" {
		args = append(args, "--telemetry", "off")
	}
	if c.Registry != "" && c.Registry != state.DefaultAPIURL {
		args = append(args, "--registry", c.Registry)
	}
	if c.Keys {
		args = append(args, "--keys")
	}
	if c.Native {
		args = append(args, "--native")
	}
	if yes {
		args = append(args, "--yes")
	}
	return strings.Join(quoteArgs(args), " ")
}

// startLines describe a plan for people: the wizard's review and `--dry-run`.
func (a *App) startLines(c *startChoices, p *startPlan) []string {
	var lines []string
	switch len(p.Install) {
	case 0:
		lines = append(lines, "Install no new tools")
	default:
		lines = append(lines, fmt.Sprintf("Install %s: %s", plural(len(p.Install), "tool", "tools"), strings.Join(p.Install, ", ")))
	}
	if len(p.AlreadyInstalled) > 0 {
		lines = append(lines, "Already installed: "+strings.Join(p.AlreadyInstalled, ", "))
	}
	if len(c.Agents) > 0 {
		var names []string
		for _, ag := range c.Agents {
			names = append(names, clientNames[ag])
		}
		lines = append(lines, "Add ot's MCP server to "+strings.Join(names, ", "))
	}
	if len(p.Changes) == 0 {
		lines = append(lines, "Keep the settings as they are")
	} else {
		lines = append(lines, fmt.Sprintf("Save %s to %s", describeChanges(p.Changes), state.Path("config.json")))
	}
	if c.Keys {
		lines = append(lines, "Then walk through the API keys these tools need")
	}
	lines = append(lines, "", "To do this again without the questions:", startCommandLine(c, true))
	return lines
}

// describeChanges lists config changes as "format table, telemetry off, api_url back to the default".
func describeChanges(changes map[string]any) string {
	keys := make([]string, 0, len(changes))
	for k := range changes {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		switch v := changes[k].(type) {
		case nil:
			parts = append(parts, k+" back to the default")
		case bool:
			parts = append(parts, k+" "+map[bool]string{true: "on", false: "off"}[v])
		default:
			parts = append(parts, fmt.Sprintf("%s %v", k, v))
		}
	}
	return strings.Join(parts, ", ")
}

// startReport is `ot start --json` (and `--dry-run --json`).
type startReport struct {
	DryRun           bool             `json:"dry_run,omitempty"`
	Command          string           `json:"command"`
	ConfigPath       string           `json:"config_path"`
	ConfigChanges    map[string]any   `json:"config_changes"`
	Install          []string         `json:"install"`
	AlreadyInstalled []string         `json:"already_installed,omitempty"`
	Installed        []*installResult `json:"installed,omitempty"`
	Agents           []startAgent     `json:"agents"`
	MissingKeys      []string         `json:"missing_keys,omitempty"`
}

// startAgent is one AI client: planned (a dry run), added, already_set_up or failed.
type startAgent struct {
	Client string `json:"client"`
	Status string `json:"status"`
	Path   string `json:"path,omitempty"`
	Error  string `json:"error,omitempty"`
}

func (a *App) startReport(c *startChoices, p *startPlan) *startReport {
	rep := &startReport{Command: startCommandLine(c, true), ConfigPath: state.Path("config.json"), ConfigChanges: p.Changes,
		Install: append([]string{}, p.Install...), AlreadyInstalled: p.AlreadyInstalled, Agents: []startAgent{}}
	for _, ag := range c.Agents {
		path, _ := clientConfigPath(ag)
		status := "planned"
		if mcpConfigured(ag) {
			status = "already_set_up"
		}
		rep.Agents = append(rep.Agents, startAgent{Client: ag, Status: status, Path: path})
	}
	return rep
}

// applyStart does the plan: settings first and AI clients next, so a missing container engine, which stops the
// installs, leaves the rest done; then the tools, and their keys at a terminal.
func (a *App) applyStart(ctx context.Context, c *startChoices, p *startPlan) error {
	rep := a.startReport(c, p)
	text := !a.jsonMode()
	if c.Telemetry != "" {
		// The wizard's telemetry step, or --telemetry, said what is counted: no need for the one-time notice.
		a.noticeShown()
	}
	if len(p.Changes) > 0 {
		if err := state.SetConfig(p.Changes); err != nil {
			return err
		}
		if text {
			fmt.Fprintf(a.Out, "Saved %s to %s.\n", describeChanges(p.Changes), state.Path("config.json"))
		}
		for key, env := range map[string]string{"api_url": "OT_API_URL", "results_dir": "OT_RESULTS_DIR"} {
			if _, changed := p.Changes[key]; changed && os.Getenv(env) != "" {
				fmt.Fprintf(a.Err, "note: %s is set in your environment and wins over config.json's %s\n", env, key)
			}
		}
		if off, env := state.TelemetryOffByEnv(); off {
			if _, changed := p.Changes["telemetry"]; changed {
				fmt.Fprintf(a.Err, "note: %s is set in your environment and wins over config.json's telemetry\n", env)
			}
		}
	}
	// The installs below are counted, or not, as just chosen.
	a.Config.Telemetry = state.LoadConfig().Telemetry

	var agentErr error
	if len(c.Agents) > 0 {
		exe, err := otExecutable()
		if err != nil {
			return err
		}
		for i := range rep.Agents {
			ag := &rep.Agents[i]
			name := clientNames[ag.Client]
			if ag.Status == "already_set_up" {
				if text {
					fmt.Fprintf(a.Out, "%s already has the otinstaller MCP server.\n", name)
				}
				continue
			}
			where, err := a.addMCPServer(ag.Client, exe)
			if err != nil {
				ag.Status, ag.Error = "failed", err.Error()
				fmt.Fprintf(a.Err, "warning: %s: %v\n", name, err)
				// Claude Code missing from PATH isn't a failure of ot's: the command to run was printed.
				if ExitCodeFor(err) != ExitRuntimeMissing && agentErr == nil {
					agentErr = err
				}
				continue
			}
			ag.Status, ag.Path = "added", where
			if text {
				fmt.Fprintf(a.Out, "Added the otinstaller MCP server to %s; restart %s to load it.\n", where, name)
			}
		}
	}

	var installErr error
	ready := append([]string{}, p.AlreadyInstalled...)
	if len(p.Install) > 0 {
		var refs []pkgRef
		for _, ref := range p.Install {
			r, err := parseRef(ref)
			if err != nil {
				return err
			}
			refs = append(refs, r)
		}
		if text {
			fmt.Fprintf(a.Out, "Installing %s...\n", plural(len(refs), "tool", "tools"))
		}
		rep.Installed, installErr = a.installMany(ctx, refs, c.Native)
		for _, r := range rep.Installed {
			if r.Status == "installed" {
				ready = append(ready, r.Ref)
			}
			rep.MissingKeys = append(rep.MissingKeys, r.MissingKeys...)
		}
		rep.MissingKeys = dedupe(rep.MissingKeys)
		if text {
			a.printInstallHints(rep.Installed)
		}
	}

	switch {
	case !c.Keys || len(ready) == 0:
	case !text || !a.interactive():
		fmt.Fprintf(a.Err, "note: skipped API key setup, which needs a terminal; run `ot keys setup %s` in yours\n", strings.Join(ready, " "))
	default:
		if err := a.setupKeys(ctx, ready, false); err != nil {
			return err
		}
	}

	if !text {
		if err := writeJSON(a.Out, rep); err != nil {
			return err
		}
	} else {
		a.printStartNext(p, rep)
	}
	if installErr != nil {
		return installErr
	}
	return agentErr
}

// startExamples are inputs for the "Next" lines, by a playbook's main input type.
var startExamples = map[string]string{
	"username": "u:johndoe", "domain": "d:example.com", "email": "e:jane@example.com",
	"phone": "p:+14155550100", "ip": "ip:192.0.2.1", "url": "url:https://example.com",
}

// printStartNext ends `ot start` with what to try: each starter pack whose tools are all installed as a playbook run,
// and how to see the agent rules.
func (a *App) printStartNext(p *startPlan, rep *startReport) {
	ready := map[string]bool{}
	for _, ref := range p.AlreadyInstalled {
		ready[ref] = true
	}
	for _, r := range rep.Installed {
		ready[r.Ref] = r.Status == "installed"
	}
	var next []string
	for _, pb := range p.Packs {
		all := len(pb.Inputs) > 0
		for _, t := range pb.Tools {
			all = all && ready[t]
		}
		if all {
			next = append(next, fmt.Sprintf("ot playbook %s %s", pb.Name, startExamples[pb.Inputs[0]]))
		}
	}
	for _, ag := range rep.Agents {
		if ag.Status == "added" {
			next = append(next, "ot mcp policy")
			break
		}
	}
	if len(next) == 0 {
		return
	}
	fmt.Fprintln(a.Out, "\nNext:")
	for _, n := range next {
		fmt.Fprintln(a.Out, "  "+n)
	}
}

// otExecutable is this ot's own path, symlinks resolved, for the MCP configurations it writes.
func otExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if p, err := filepath.EvalSymlinks(exe); err == nil {
		exe = p
	}
	return exe, nil
}

// ---------- the wizard ----------

// startCatalog is what the wizard offers: the starter packs, every tool in the registry, what is installed, whether
// tools can install at all, and config.json as written.
type startCatalog struct {
	Playbooks []*playbook.Playbook
	Tools     []api.ToolSummary
	Installed map[string]bool
	// Engine says why tools can't install now (no Docker or Podman, or it isn't running); empty when they can.
	Engine string
	File   *state.Config
}

func (a *App) startCatalog(ctx context.Context, bundled []*playbook.Playbook) (*startCatalog, error) {
	cat := &startCatalog{Playbooks: bundled, Installed: map[string]bool{}, File: state.FileConfig()}
	st, err := state.Load()
	if err != nil {
		return nil, err
	}
	for ref := range st.Installed {
		cat.Installed[ref] = true
	}
	if ok, _ := a.engineStatus(ctx); !ok {
		cat.Engine = "Docker or Podman isn't installed, so tools can't install yet (ot doctor says how to get it)"
		if a.Runner.Engine != "" {
			cat.Engine = a.Runner.Engine + " isn't running, so tools can't install until you start it"
		}
	}
	// The registry answers at most 100 a page; there are a few hundred tools at most.
	cursor := ""
	for range 50 {
		res, err := a.API.Search(ctx, api.SearchParams{Kind: "tool", Limit: 100, Cursor: cursor})
		if err != nil {
			return nil, a.requestError(err)
		}
		cat.Tools = append(cat.Tools, res.Results...)
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	return cat, nil
}

// pick sets the playbooks and tools to the wizard's selection: a pack stays when every one of its tools is picked (or
// installed already), and the other picked tools are listed on their own, so the flags install exactly the selection.
func (c *startChoices) pick(selected, packs []string, cat *startCatalog) {
	have := map[string]bool{}
	for _, s := range selected {
		have[s] = true
	}
	for ref := range cat.Installed {
		have[ref] = true
	}
	covered := map[string]bool{}
	c.Playbooks = nil
	for _, name := range packs {
		pb := findPlaybook(cat.Playbooks, name)
		if pb == nil {
			continue
		}
		all := true
		for _, t := range pb.Tools {
			all = all && have[t]
		}
		if all {
			c.Playbooks = append(c.Playbooks, name)
			for _, t := range pb.Tools {
				covered[t] = true
			}
		}
	}
	c.Tools = nil
	for _, s := range selected {
		if !covered[s] {
			c.Tools = append(c.Tools, s)
		}
	}
}

const (
	otherFolder   = "\x00other-folder"
	otherRegistry = "\x00other-registry"
)

// runStartWizard is the wizard: starter packs; then tools, AI clients and settings; then a review. Esc or Ctrl-C at
// any point changes nothing.
func (a *App) runStartWizard(ctx context.Context, cat *startCatalog, c *startChoices) error {
	run := func(groups ...*huh.Group) error {
		return huh.NewForm(groups...).
			WithTheme(huh.ThemeBase16()).
			WithAccessible(os.Getenv("ACCESSIBLE") != "").
			WithInput(a.In).
			WithOutput(a.Err).
			RunWithContext(ctx)
	}

	// 1. Starter packs.
	packs := append([]string{}, c.Playbooks...)
	var packOpts []huh.Option[string]
	for _, p := range cat.Playbooks {
		packOpts = append(packOpts, huh.NewOption(fmt.Sprintf("%-23s %s", p.Name, p.Description), p.Name))
	}
	intro := "Pick starter packs and tools, AI agents and settings. Nothing changes until you confirm at the end.\n" +
		"Space picks, Enter goes on, Shift-Tab goes back, Ctrl-C cancels."
	if cat.Engine != "" {
		intro += "\n\nNote: " + cat.Engine + ". You can still choose; everything else is set up now."
	}
	if err := run(huh.NewGroup(
		huh.NewNote().Title("Set up ot").Description(noteText(intro)),
		huh.NewMultiSelect[string]().Title("Starter packs").
			Description("Bundled playbooks: a few tools for one kind of target. Pick none to choose tools yourself.").
			Options(packOpts...).Value(&packs),
	)); err != nil {
		return err
	}

	// 2. Tools (the packs' tools picked), AI clients and settings.
	want := map[string]bool{}
	for _, t := range c.Tools {
		want[t] = true
	}
	for _, name := range packs {
		for _, t := range findPlaybook(cat.Playbooks, name).Tools {
			want[t] = true
		}
	}
	var first, rest []huh.Option[string]
	var selected, already []string
	needsKeys, listed := map[string]bool{}, map[string]bool{}
	for _, t := range cat.Tools {
		ref := t.Namespace + "/" + t.Name
		listed[ref], needsKeys[ref] = true, t.NeedsKeys
		if cat.Installed[ref] {
			if want[ref] {
				already = append(already, ref)
			}
			continue
		}
		opt := huh.NewOption(startToolLabel(t), ref)
		// A pack never picks a tool people mark broken or its publisher deprecated; it stays on the list to pick.
		if want[ref] && t.Status != "deprecated" && t.Health != "broken" {
			selected = append(selected, ref)
			first = append(first, opt)
		} else {
			rest = append(rest, opt)
		}
	}
	var missing []string
	for ref := range want {
		if !listed[ref] {
			missing = append(missing, ref)
		}
	}
	sort.Strings(missing)
	for _, ref := range missing {
		fmt.Fprintf(a.Err, "note: leaving out %s: the registry doesn't list it\n", ref)
	}
	toolsDesc := fmt.Sprintf("%d tools. / filters the list; ctrl+a picks every tool shown.", len(first)+len(rest))
	if len(already) > 0 {
		toolsDesc += "\nAlready installed: " + strings.Join(already, ", ")
	}

	agents := append([]string{}, c.Agents...)
	var agentOpts []huh.Option[string]
	for _, client := range mcpClients {
		agentOpts = append(agentOpts, huh.NewOption(startAgentLabel(client), client))
	}

	format := orDefault(c.Format, orDefault(cat.File.Format, "json"))
	folder := orDefault(c.ResultsDir, orDefault(cat.File.ResultsDir, resultsHere))
	folderChoice, folderOther := folder, ""
	if folder != resultsHere && folder != state.Path("results") {
		folderChoice, folderOther = otherFolder, folder
	}
	keys := c.Keys
	anyNeedsKeys := func() bool {
		for _, s := range selected {
			if needsKeys[s] {
				return true
			}
		}
		return false
	}
	advanced := c.Registry != ""
	registry := orDefault(c.Registry, orDefault(strings.TrimRight(cat.File.APIURL, "/"), state.DefaultAPIURL))
	registryChoice, registryOther := state.DefaultAPIURL, ""
	if registry != state.DefaultAPIURL {
		registryChoice, registryOther = otherRegistry, registry
	}
	telemetry := c.Telemetry == "on" || (c.Telemetry == "" && (cat.File.Telemetry == nil || *cat.File.Telemetry))

	if err := run(
		huh.NewGroup(huh.NewMultiSelect[string]().Title("Tools").Description(toolsDesc).
			Options(append(first, rest...)...).Value(&selected).Filterable(true).Height(18)),
		huh.NewGroup(huh.NewMultiSelect[string]().Title("AI agents").
			Description("Add ot's MCP server to these clients, so they can search, install and run tools. Runs that touch\n"+
				"a target ask you first.").
			Options(agentOpts...).Value(&agents)),
		huh.NewGroup(
			huh.NewSelect[string]().Title("Output format of ot run").Options(
				huh.NewOption("json   the full result, for scripts and jq", "json"),
				huh.NewOption("table  readable rows", "table"),
				huh.NewOption("csv    for spreadsheets", "csv"),
				huh.NewOption("raw    the tool's own output", "raw"),
			).Value(&format),
			huh.NewSelect[string]().Title("Where to save results").Options(
				huh.NewOption("./results in the folder you run ot from", resultsHere),
				huh.NewOption(state.Path("results")+" (one folder for every run)", state.Path("results")),
				huh.NewOption("Another folder...", otherFolder),
			).Value(&folderChoice),
		),
		huh.NewGroup(huh.NewInput().Title("Folder for results").Placeholder("~/osint/results").Value(&folderOther).
			Validate(func(s string) error {
				if strings.TrimSpace(s) == "" {
					return errors.New("type a folder")
				}
				return nil
			})).
			WithHideFunc(func() bool { return folderChoice != otherFolder }),
		huh.NewGroup(huh.NewConfirm().Title("Set up API keys after installing?").
			Description("Some tools you picked need one. You'll see what each key is for, where to get it and what it costs.").
			Value(&keys)).
			WithHideFunc(func() bool { return !anyNeedsKeys() }),
		huh.NewGroup(huh.NewConfirm().Title("Telemetry").
			Description("ot counts installs and runs: the tool, its version and how each run ended, never your inputs, targets or\n"+
				"results, so the registry can show which tools work. It also offers to report a run that failed as broken.\n"+
				"`ot telemetry` shows exactly what is sent and turns it on or off later: "+privacyURL(a)+telemetryOffNote()).
			Affirmative("On").Negative("Off").Value(&telemetry)),
		huh.NewGroup(huh.NewConfirm().Title("Use another registry?").Description("A self-hosted or local one. Most people don't need to.").
			Affirmative("Yes").Negative("No").Value(&advanced)),
		huh.NewGroup(
			huh.NewSelect[string]().Title("Registry").Options(
				huh.NewOption("OTInstaller ("+state.DefaultAPIURL+")", state.DefaultAPIURL),
				huh.NewOption("Another registry (self-hosted or local)...", otherRegistry),
			).Value(&registryChoice),
		).WithHideFunc(func() bool { return !advanced }),
		huh.NewGroup(huh.NewInput().Title("Registry API URL").Placeholder("http://127.0.0.1:8787/v1").Value(&registryOther).
			Validate(func(s string) error { _, err := registryURL(s); return err })).
			WithHideFunc(func() bool { return !advanced || registryChoice != otherRegistry }),
	); err != nil {
		return err
	}

	c.pick(selected, packs, cat)
	c.Agents, c.Format, c.Keys = agents, format, keys && anyNeedsKeys()
	c.ResultsDir = folderChoice
	if folderChoice == otherFolder {
		c.ResultsDir = folderOther
	}
	c.Registry, c.Telemetry = "", onOff(telemetry)
	if advanced {
		c.Registry = registryChoice
		if registryChoice == otherRegistry {
			c.Registry = registryOther
		}
	}
	if err := c.check(cat.Playbooks); err != nil {
		return err
	}

	// 3. Review.
	plan, err := a.planStart(c, cat.Playbooks)
	if err != nil {
		return err
	}
	apply := true
	if err := run(huh.NewGroup(
		huh.NewNote().Title("Review").Description(noteText(strings.Join(a.startLines(c, plan), "\n"))),
		huh.NewConfirm().Title("Apply?").Affirmative("Apply").Negative("Cancel").Value(&apply),
	)); err != nil {
		return err
	}
	if !apply {
		return errStartDeclined
	}
	return nil
}

// noteText escapes what a huh note would read as markup: _ and * (italic, bold), ` (code) and \ (paths).
func noteText(s string) string {
	return strings.NewReplacer(`\`, `\\`, `_`, `\_`, `*`, `\*`, "`", "\\`").Replace(s)
}

// startToolLabel is a tool's line in the wizard: ref, summary and what to know before picking it.
func startToolLabel(t api.ToolSummary) string {
	var notes []string
	if t.NeedsKeys {
		notes = append(notes, "needs a key")
	}
	if t.Health == "broken" {
		notes = append(notes, "possibly broken")
	}
	if t.Status == "deprecated" {
		notes = append(notes, "deprecated")
	}
	label := fmt.Sprintf("%-42s %s", t.Namespace+"/"+t.Name, truncate(t.Summary, 64))
	if len(notes) > 0 {
		label += " [" + strings.Join(notes, ", ") + "]"
	}
	return label
}

// startAgentLabel is an AI client's line in the wizard: what ot changes for it, and whether it is here or set up.
func startAgentLabel(client string) string {
	where := ""
	switch client {
	case "claude":
		where = "runs `claude mcp add`"
	case "vscode":
		where = ".vscode/mcp.json in this folder"
	default:
		where, _ = clientConfigPath(client)
	}
	label := fmt.Sprintf("%-15s %s", clientNames[client], where)
	switch {
	case mcpConfigured(client):
		label += "  (already set up)"
	case agentFound(client):
		label += "  (found on this machine)"
	}
	return label
}

// agentFound reports whether an AI client seems to be on this machine: its command on PATH, or its settings folder.
func agentFound(client string) bool {
	switch client {
	case "claude":
		_, err := exec.LookPath("claude")
		return err == nil
	case "vscode":
		_, err := exec.LookPath("code")
		return err == nil
	}
	path, err := clientConfigPath(client)
	if err != nil {
		return false
	}
	_, err = os.Stat(filepath.Dir(path))
	return err == nil
}
