package cli

// The MCP server's read-only tools: finding tools and guides, planning runs and pivots, and reading saved runs.
// None of them changes anything, so clients may allow them without asking.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/otinstaller/otinstaller/cli/internal/agent"
	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/keys"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/playbook"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/specfiles"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

type searchIn struct {
	Query      string `json:"query,omitempty" jsonschema:"words to search for in names, summaries and tags"`
	InputType  string `json:"input_type,omitempty" jsonschema:"only tools that take this input type (email, username, domain, ip, url, phone, ...); list_types lists them"`
	OutputType string `json:"output_type,omitempty" jsonschema:"only tools that find this entity type"`
	Category   string `json:"category,omitempty" jsonschema:"only this category, such as domain-dns or social-media"`
	Runtime    string `json:"runtime,omitempty" jsonschema:"docker or pipx"`
	NoKeys     bool   `json:"no_keys,omitempty" jsonschema:"only tools that need no API key"`
	Limit      int    `json:"limit,omitempty" jsonschema:"results per page, 1 to 100 (default 20)"`
	Cursor     string `json:"cursor,omitempty" jsonschema:"next_cursor from the previous page"`
}

type toolIn struct {
	Tool string `json:"tool" jsonschema:"the package as namespace/name"`
}

type secretInfo struct {
	Name        string `json:"name"`
	Required    bool   `json:"required"`
	Description string `json:"description,omitempty"`
	URL         string `json:"url,omitempty"`
	// Set says whether the key is available here (environment or keychain). The value is never shown.
	Set bool `json:"set"`
}

type toolInfo struct {
	Ref         string             `json:"ref"`
	Version     string             `json:"version"`
	Summary     string             `json:"summary"`
	License     string             `json:"license,omitempty"`
	Homepage    string             `json:"homepage,omitempty"`
	Inputs      []manifest.Input   `json:"inputs"`
	Outputs     []string           `json:"outputs"`
	Ethics      *manifest.Ethics   `json:"ethics,omitempty"`
	Network     *manifest.Network  `json:"network,omitempty"`
	Secrets     []secretInfo       `json:"secrets"`
	Timeout     int                `json:"timeout_seconds"`
	Consent     agent.Class        `json:"consent_class" jsonschema:"passive runs need no consent; networked, target and personal runs ask the person"`
	Effects     []string           `json:"effects" jsonschema:"what a run does, in plain words"`
	Trust       *api.ToolSummary   `json:"registry,omitempty" jsonschema:"the registry's listing: signed, verified publisher, health, installs"`
	Installed   *installRecord     `json:"installed,omitempty"`
	Example     map[string]any     `json:"run_tool_example,omitempty"`
	TestInput   map[string]any     `json:"test_input,omitempty"`
	Deprecated  string             `json:"deprecated,omitempty"`
	Unavailable string             `json:"unavailable,omitempty"`
	Raw         *manifest.Manifest `json:"-"`
}

type installedOut struct {
	Installed []installRecord `json:"installed"`
}

type typesOut struct {
	InputTypes  []string                           `json:"input_types"`
	EntityTypes []string                           `json:"entity_types"`
	Pivots      map[string][]specfiles.PivotTarget `json:"pivots" jsonschema:"which input types each entity type can feed (spec/pivots.json)"`
}

type pivotsIn struct {
	RunID    string            `json:"run_id,omitempty" jsonschema:"take the entities from this saved run"`
	Entities []envelope.Entity `json:"entities,omitempty" jsonschema:"or give entities directly, as {type, value, attrs}"`
	Registry bool              `json:"registry,omitempty" jsonschema:"also suggest tools that are not installed, from the registry (slower)"`
	Limit    int               `json:"limit,omitempty" jsonschema:"at most this many pivots (default 25)"`
}

type pivot struct {
	EntityType string   `json:"entity_type"`
	Value      string   `json:"value"`
	InputType  string   `json:"input_type"`
	Installed  []string `json:"installed_tools" jsonschema:"installed tools that take this input"`
	Registry   []string `json:"registry_tools,omitempty" jsonschema:"other tools in the registry that take it"`
}

type pivotsOut struct {
	Pivots []pivot `json:"pivots"`
	Note   string  `json:"note"`
}

type detectIn struct {
	Target string `json:"target" jsonschema:"a username, domain, email address, phone number, IP address or URL"`
}

type detectOut struct {
	InputType string `json:"input_type"`
	Prefix    string `json:"prefix" jsonschema:"the ot run shorthand, such as d: for a domain"`
}

type playbookTool struct {
	Ref       string `json:"ref"`
	Installed bool   `json:"installed"`
}

type playbookInfo struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Case        string         `json:"case"`
	Source      string         `json:"source"`
	Tools       []playbookTool `json:"tools"`
}

type playbooksOut struct {
	Playbooks []playbookInfo `json:"playbooks"`
}

type nameIn struct {
	Name string `json:"name" jsonschema:"the playbook's name"`
}

type runsIn struct {
	Tool   string `json:"tool,omitempty" jsonschema:"only runs of this tool (namespace/name or name)"`
	Target string `json:"target,omitempty" jsonschema:"only runs against this target"`
	Case   string `json:"case,omitempty" jsonschema:"only runs saved under this case"`
	Limit  int    `json:"limit,omitempty" jsonschema:"newest first, at most this many (default 20)"`
}

type runSummary struct {
	RunID      string `json:"run_id"`
	Tool       string `json:"tool"`
	Version    string `json:"version"`
	Target     string `json:"target"`
	Case       string `json:"case,omitempty"`
	Status     string `json:"status"`
	ExitCode   int    `json:"exit_code"`
	Entities   int    `json:"entities"`
	StartedAt  string `json:"started_at"`
	OutputPath string `json:"output_path"`
}

type runsOut struct {
	Runs []runSummary `json:"runs"`
}

type getRunIn struct {
	RunID      string `json:"run_id" jsonschema:"the run, from run_tool, list_runs or a batch"`
	View       string `json:"view,omitempty" jsonschema:"entities (default): the entities, paged; summary: emails, domains, IPs, URLs and entity values found, deduplicated"`
	Offset     int    `json:"offset,omitempty"`
	Limit      int    `json:"limit,omitempty" jsonschema:"entities per page, 1 to 200 (default 50)"`
	IncludeRaw bool   `json:"include_raw,omitempty" jsonschema:"also return the tool's raw output, cut to fit"`
}

type getRunOut struct {
	Run        runSummary          `json:"run"`
	Entities   []envelope.Entity   `json:"entities,omitempty"`
	Total      int                 `json:"entities_total"`
	Offset     int                 `json:"offset"`
	Summary    *results.Indicators `json:"summary,omitempty"`
	Raw        string              `json:"raw,omitempty"`
	RawCut     bool                `json:"raw_cut,omitempty"`
	Warnings   []string            `json:"warnings,omitempty"`
	Artifact   *envelope.Artifact  `json:"artifact,omitempty"`
	OutputHash string              `json:"output_sha256,omitempty"`
	Note       string              `json:"note"`
}

type extractIn struct {
	Tool string `json:"tool,omitempty" jsonschema:"scan this tool's saved runs"`
	Case string `json:"case,omitempty" jsonschema:"scan the runs in this case"`
}

type diffIn struct {
	Tool   string `json:"tool" jsonschema:"the tool, namespace/name or name"`
	Target string `json:"target" jsonschema:"the target both runs were against"`
	Case   string `json:"case,omitempty"`
}

type guidesIn struct {
	Query     string `json:"query,omitempty"`
	InputType string `json:"input_type,omitempty" jsonschema:"guides about this kind of target"`
	Level     string `json:"level,omitempty" jsonschema:"beginner, intermediate or advanced"`
	Limit     int    `json:"limit,omitempty"`
}

type readGuideIn struct {
	Guide string `json:"guide" jsonschema:"the guide, namespace/name or namespace/name@version"`
	Page  string `json:"page,omitempty" jsonschema:"the page path from pages; the first page by default"`
}

type readGuideOut struct {
	Ref     string   `json:"ref"`
	Version string   `json:"version"`
	Title   string   `json:"title"`
	Path    string   `json:"path"`
	Body    string   `json:"body_markdown"`
	Pages   []string `json:"pages"`
	Next    string   `json:"next,omitempty"`
	Tools   []string `json:"related_tools,omitempty"`
}

type validateIn struct {
	Path string `json:"path,omitempty" jsonschema:"the otinstaller.yaml to check (default ./otinstaller.yaml)"`
}

type validateOut struct {
	Valid    bool                `json:"valid"`
	Problems []*manifest.Problem `json:"problems"`
}

type doctorOut struct {
	OK     bool          `json:"ok"`
	Checks []doctorCheck `json:"checks"`
}

type consentStatusOut struct {
	Verdict agent.Verdict `json:"verdict" jsonschema:"allow: runs without asking; ask: the person will be asked; refuse: it won't run"`
	Class   agent.Class   `json:"class,omitempty"`
	Reason  string        `json:"reason"`
	Effects []string      `json:"effects,omitempty"`
}

func (s *mcpServer) addReadTools() {
	a := s.a
	readTool(s, "search_tools", "Search tools",
		"Search the OTInstaller Registry for OSINT tools. Results list each tool's input and output types, whether it needs API keys, and its trust status (signed, verified publisher, health).",
		func(ctx context.Context, in searchIn) (*api.SearchResult, error) {
			return a.API.Search(ctx, api.SearchParams{Query: in.Query, Input: in.InputType, Output: in.OutputType, Category: in.Category,
				Runtime: in.Runtime, Kind: "tool", NoKeys: in.NoKeys, Limit: orInt(in.Limit, 20), Cursor: in.Cursor})
		})
	readTool(s, "get_tool", "Get a tool",
		"Everything needed to run a tool: its inputs (names, types, defaults), what it finds, the API keys it needs and whether they are set, its ethics flags and network access, and whether a run will need the person's consent. Works for installed and registry tools.",
		func(ctx context.Context, in toolIn) (*toolInfo, error) { return s.toolInfo(ctx, in.Tool) })
	readTool(s, "list_installed", "List installed tools", "The tools installed on this machine, with their versions and the exact image digest or wheel hash.",
		func(ctx context.Context, _ struct{}) (*installedOut, error) {
			st, err := state.Load()
			if err != nil {
				return nil, err
			}
			out := &installedOut{Installed: []installRecord{}}
			for _, i := range st.Sorted() {
				out.Installed = append(out.Installed, recordOf(i))
			}
			return out, nil
		})
	readTool(s, "list_types", "List input and entity types",
		"The input types tools take, the entity types they find, and the pivot map: which input types each entity type can feed.",
		func(ctx context.Context, _ struct{}) (*typesOut, error) {
			in, out := manifest.Types()
			return &typesOut{InputTypes: in, EntityTypes: out, Pivots: specfiles.Pivots}, nil
		})
	readTool(s, "suggest_pivots", "Suggest next runs",
		"Given a saved run (or entities), list what to look at next: each entity worth pivoting on, the input type it fits, and the installed tools (and optionally registry tools) that take it. Runs nothing.",
		s.suggestPivots)
	readTool(s, "detect_type", "Detect a target's type",
		"What kind of target a string is, as ot auto would guess: url, ip, email, phone, domain, else username.",
		func(ctx context.Context, in detectIn) (*detectOut, error) {
			t := runner.DetectTyped(strings.TrimSpace(in.Target))
			return &detectOut{InputType: runner.TypedPrefixes[t.Prefix], Prefix: t.Prefix + ":"}, nil
		})
	readTool(s, "list_playbooks", "List playbooks", "Named sets of tools run together against one target, bundled or the person's own, and which of their tools are installed.",
		func(ctx context.Context, _ struct{}) (*playbooksOut, error) {
			all, err := playbook.All(playbook.Dirs(state.Home()))
			if err != nil {
				return nil, err
			}
			out := &playbooksOut{Playbooks: []playbookInfo{}}
			for _, p := range all {
				out.Playbooks = append(out.Playbooks, playbookOf(p))
			}
			return out, nil
		})
	readTool(s, "get_playbook", "Get a playbook", "One playbook: its tools and which are installed.",
		func(ctx context.Context, in nameIn) (*playbookInfo, error) {
			p, err := playbook.Find(playbook.Dirs(state.Home()), in.Name)
			if err != nil {
				return nil, &toolError{Code: "playbook_not_found", Message: err.Error(), Hint: "list_playbooks lists them"}
			}
			info := playbookOf(p)
			return &info, nil
		})
	readTool(s, "list_runs", "List saved runs", "Saved runs, newest first, optionally of one tool, against one target, or in one case.", s.listRuns)
	readTool(s, "get_run", "Read a saved run",
		"A run's result: its status and provenance, the entities it found (paged), a deduplicated summary of the indicators, or its raw output. Also reports runs still going.",
		s.getRun)
	readTool(s, "extract_indicators", "Extract indicators", "Emails, domains, IP addresses, URLs and entities found across a tool's saved runs, or a case's.",
		func(ctx context.Context, in extractIn) (*results.Indicators, error) {
			dir := results.Dir("")
			if in.Case != "" {
				dir = filepath.Join(dir, "cases", results.Sanitize(in.Case))
			}
			if in.Tool != "" {
				dir = filepath.Join(dir, toolDir(in.Tool))
			}
			if in.Tool == "" && in.Case == "" {
				return nil, &toolError{Code: "usage", Message: "give a tool or a case"}
			}
			files, err := results.Outputs(dir)
			if err != nil {
				return nil, &toolError{Code: "no_runs", Message: "no saved runs at " + dir}
			}
			ind, err := results.Extract(files)
			if ind != nil {
				cleanIndicators(ind)
			}
			return ind, err
		})
	readTool(s, "diff_runs", "Compare two runs", "What changed between the two most recent saved runs of a tool against a target: entities and output lines added and removed.",
		func(ctx context.Context, in diffIn) (*results.Change, error) {
			base := results.Dir("")
			if in.Case != "" {
				base = filepath.Join(base, "cases", results.Sanitize(in.Case))
			}
			dir := filepath.Join(base, toolDir(in.Tool), results.Sanitize(in.Target))
			files, _ := results.Outputs(dir)
			if len(files) < 2 {
				return nil, &toolError{Code: "no_runs", Message: fmt.Sprintf("need two saved runs to compare, found %d in %s", len(files), dir)}
			}
			c, err := results.Diff(files[len(files)-2], files[len(files)-1])
			if c != nil {
				for _, l := range [][]string{c.Added, c.Removed, c.AddedEntities, c.RemovedEntities} {
					for i := range l {
						l[i] = clean(l[i])
					}
				}
			}
			return c, err
		})
	readTool(s, "search_guides", "Search guides", "Search the registry's investigation guides (methods, checklists, references), by words, target type or level.",
		func(ctx context.Context, in guidesIn) (*api.SearchResult, error) {
			return a.API.SearchGuides(ctx, api.SearchParams{Query: in.Query, Input: in.InputType, Level: in.Level, Limit: orInt(in.Limit, 20)})
		})
	readTool(s, "read_guide", "Read a guide page", "One page of a guide, as Markdown, with the list of its pages and the tools it uses.",
		func(ctx context.Context, in readGuideIn) (*readGuideOut, error) {
			ref, err := guideArg(in.Guide)
			if err != nil {
				return nil, err
			}
			g, err := a.API.Guide(ctx, ref.NS, ref.Name, ref.Version)
			if err != nil {
				return nil, err
			}
			out := &readGuideOut{Ref: g.Ref, Version: g.Version, Title: g.Title}
			for _, n := range g.Nav {
				out.Pages = append(out.Pages, n.Path)
			}
			for _, t := range g.RelatedTools {
				out.Tools = append(out.Tools, t.Ref)
			}
			page := in.Page
			if page == "" && len(out.Pages) > 0 {
				page = out.Pages[0]
			}
			p, err := a.API.GuidePage(ctx, ref.NS, ref.Name, g.Version, page, "md")
			if err != nil {
				return nil, err
			}
			out.Path, out.Body = p.Path, p.Body
			if p.Next != nil {
				out.Next = p.Next.Path
			}
			return out, nil
		})
	readTool(s, "validate_manifest", "Validate a manifest",
		"Check an otinstaller.yaml as the registry will, with the same error codes. For publishers packaging a tool or guide.",
		func(ctx context.Context, in validateIn) (*validateOut, error) {
			path := orDefault(in.Path, "otinstaller.yaml")
			doc, m, err := manifest.LoadFile(path)
			if err != nil {
				return nil, &toolError{Code: "manifest_yaml_invalid", Message: err.Error()}
			}
			ps := manifest.Validate(doc, m, manifest.Options{Dir: filepath.Dir(path)})
			if ps == nil {
				ps = []*manifest.Problem{}
			}
			return &validateOut{Valid: len(ps) == 0, Problems: ps}, nil
		})
	readTool(s, "doctor", "Check this machine", "Whether Docker (or Podman), cosign, the keychain and the registry are available.",
		func(ctx context.Context, _ struct{}) (*doctorOut, error) {
			checks := a.doctorChecks(ctx)
			ok := true
			for _, c := range checks {
				ok = ok && c.Status != "fail"
			}
			return &doctorOut{OK: ok, Checks: checks}, nil
		})
	readTool(s, "get_consent_status", "Check whether a run needs consent",
		"What would happen if run_tool were called with these arguments: allowed without asking, the person asked, or refused (and why). Asks nobody and runs nothing.",
		func(ctx context.Context, in runIn) (*consentStatusOut, error) {
			plan, err := s.planRun(ctx, in)
			if err != nil {
				return nil, err
			}
			d := s.sess.DecideRun(plan.inst.Manifest, plan.values)
			return &consentStatusOut{Verdict: d.Verdict, Class: d.Class, Reason: d.Reason, Effects: agent.Describe(plan.inst.Manifest)}, nil
		})
}

// cleanIndicators applies clean to everything extract found, which comes straight from tool output.
func cleanIndicators(ind *results.Indicators) {
	for _, l := range [][]string{ind.Emails, ind.Domains, ind.IPs, ind.URLs} {
		for i := range l {
			l[i] = clean(l[i])
		}
	}
	for _, l := range ind.Entities {
		for i := range l {
			l[i] = clean(l[i])
		}
	}
}

func orInt(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func playbookOf(p *playbook.Playbook) playbookInfo {
	st, _ := state.Load()
	info := playbookInfo{Name: p.Name, Description: p.Description, Case: p.Case, Source: p.Source, Tools: []playbookTool{}}
	for _, ref := range p.Tools {
		info.Tools = append(info.Tools, playbookTool{Ref: ref, Installed: st != nil && st.Installed[ref] != nil})
	}
	return info
}

// toolInfo combines the registry's view of a tool with the local one.
func (s *mcpServer) toolInfo(ctx context.Context, arg string) (*toolInfo, error) {
	ref, err := parseRef(arg)
	if err != nil || ref.LocalPath != "" {
		return nil, &toolError{Code: "usage", Message: fmt.Sprintf("give a package as namespace/name, not %q", arg)}
	}
	info := &toolInfo{}
	var m *manifest.Manifest
	st, _ := state.Load()
	if st != nil {
		if inst := st.Installed[ref.Ref()]; inst != nil {
			r := recordOf(inst)
			info.Installed, m = &r, inst.Manifest
		}
	}
	t, err := s.a.API.Tool(ctx, ref.NS, ref.Name)
	switch {
	case err == nil:
		info.Trust = &t.ToolSummary
		info.License, info.Homepage, info.Deprecated = t.License, t.Homepage, t.DeprecatedMsg
		if m == nil || ref.Version == "" {
			if _, rm, perr := manifest.ParseJSON(t.Manifest); perr == nil && (m == nil || rm.Version == m.Version) {
				m = rm
			}
		}
	case m == nil:
		return nil, err
	default:
		info.Unavailable = "the registry could not be asked (" + err.Error() + "); this is the installed version"
	}
	if m.IsGuide() {
		return nil, &toolError{Code: "usage", Message: m.Ref() + " is a guide; use read_guide"}
	}
	info.Raw = m
	info.Ref, info.Version, info.Summary = m.Ref(), m.Version, m.Summary
	info.Inputs, info.Ethics, info.Network, info.Timeout = m.Inputs, m.Ethics, m.Network, m.Timeout()
	for _, o := range m.Outputs {
		info.Outputs = append(info.Outputs, o.Type)
	}
	info.Secrets = []secretInfo{}
	for _, sec := range m.Secrets {
		info.Secrets = append(info.Secrets, secretInfo{Name: sec.Name, Required: sec.Required, Description: sec.Description, URL: sec.URL, Set: keySet(sec.Name)})
	}
	example := map[string]string{}
	for _, in := range m.Inputs {
		if in.Required {
			example[in.Name] = "<" + in.Type + ">"
		}
	}
	info.Consent = agent.Classify(m, example)
	info.Effects = agent.Describe(m)
	info.Example = map[string]any{"tool": m.Ref(), "inputs": example}
	if m.Test != nil {
		info.TestInput = m.Test.Input
	}
	return info, nil
}

// keySet reports whether a key is in the environment or the keychain, without reading it out.
func keySet(name string) bool {
	if os.Getenv(name) != "" {
		return true
	}
	for _, n := range keys.List() {
		if n == name {
			return true
		}
	}
	return false
}

func (s *mcpServer) suggestPivots(ctx context.Context, in pivotsIn) (*pivotsOut, error) {
	ents := in.Entities
	if in.RunID != "" {
		r, err := findSavedRun(in.RunID)
		if err != nil {
			return nil, err
		}
		ents = r.meta.Entities
	}
	if len(ents) == 0 {
		return nil, &toolError{Code: "usage", Message: "give a run_id or entities"}
	}
	return s.a.pivots(ctx, ents, in.Registry, orInt(in.Limit, 25)), nil
}

// pivots lists what entities could feed next: for each, the input type it fits and the tools that take it.
func (a *App) pivots(ctx context.Context, ents []envelope.Entity, registry bool, limit int) *pivotsOut {
	st, _ := state.Load()
	byInput := map[string][]string{}
	if st != nil {
		for _, inst := range st.Sorted() {
			if inst.Manifest == nil || inst.Manifest.IsGuide() {
				continue
			}
			for _, inp := range inst.Manifest.Inputs {
				if !hasString(byInput[inp.Type], inst.Ref) {
					byInput[inp.Type] = append(byInput[inp.Type], inst.Ref)
				}
			}
		}
	}
	fromRegistry := map[string][]string{}
	out := &pivotsOut{Pivots: []pivot{}, Note: "Nothing was run. Check each tool with get_tool before running it."}
	seen := map[string]bool{}
	for _, e := range cleanEntities(ents) {
		for _, t := range specfiles.Pivots[e.Type] {
			v := pivotValue(e, t)
			key := t.Input + "\x00" + strings.ToLower(v)
			if v == "" || seen[key] {
				continue
			}
			seen[key] = true
			p := pivot{EntityType: e.Type, Value: v, InputType: t.Input, Installed: append([]string{}, byInput[t.Input]...)}
			if registry {
				if _, done := fromRegistry[t.Input]; !done {
					fromRegistry[t.Input] = []string{}
					if res, err := a.API.Search(ctx, api.SearchParams{Input: t.Input, Kind: "tool", Limit: 5, Query: ""}); err == nil {
						for _, r := range res.Results {
							fromRegistry[t.Input] = append(fromRegistry[t.Input], r.Namespace+"/"+r.Name+": "+r.Summary)
						}
					} else {
						out.Note += " The registry could not be asked: " + err.Error()
					}
				}
				p.Registry = fromRegistry[t.Input]
			}
			out.Pivots = append(out.Pivots, p)
			if len(out.Pivots) == limit {
				return out
			}
		}
	}
	return out
}

// pivotValue is the value an entity gives an input, by the pivot map's rule.
func pivotValue(e envelope.Entity, t specfiles.PivotTarget) string {
	v := e.Value
	if t.Attr != "" {
		s, _ := e.Attrs[t.Attr].(string)
		v = s
	}
	switch t.Transform {
	case "host":
		rest := v
		if _, after, ok := strings.Cut(v, "://"); ok {
			rest = after
		}
		host, _, _ := strings.Cut(rest, "/")
		host, _, _ = strings.Cut(host, ":")
		if strings.Contains(host, ".") && !strings.Contains(host, "@") {
			return strings.ToLower(host)
		}
		return ""
	case "email_domain":
		if _, d, ok := strings.Cut(v, "@"); ok && strings.Contains(d, ".") {
			return strings.ToLower(d)
		}
		return ""
	}
	return strings.TrimSpace(v)
}

func hasString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// savedRun is a run found on disk.
type savedRun struct {
	output string
	meta   *results.Meta
}

func summaryOf(output string, m *results.Meta) runSummary {
	s := runSummary{RunID: m.RunID, Tool: m.Ref, Version: m.ToolVersion, Target: m.Target, Status: m.Status, ExitCode: m.ExitCode,
		Entities: len(m.Entities), StartedAt: m.StartedAt.Format("2006-01-02T15:04:05Z"), OutputPath: output}
	if m.Case != nil {
		s.Case = *m.Case
	}
	if s.RunID == "" {
		s.RunID = idFromPath(output)
	}
	return s
}

// idFromPath reads the run id out of a saved file name: <time>_<tool>_<target>_<id>.<ext>.
func idFromPath(p string) string {
	base := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
	if i := strings.LastIndexByte(base, '_'); i >= 0 {
		return base[i+1:]
	}
	return ""
}

// findSavedRun looks a run up by id among the saved runs.
func findSavedRun(id string) (*savedRun, error) {
	id = strings.TrimSpace(id)
	if len(id) != 8 {
		return nil, &toolError{Code: "run_not_found", Message: fmt.Sprintf("%q is not a run id", id)}
	}
	files, _ := results.Outputs(results.Dir(""))
	for i := len(files) - 1; i >= 0; i-- {
		if idFromPath(files[i]) == id {
			if m := results.MetaFor(files[i]); m != nil {
				return &savedRun{files[i], m}, nil
			}
		}
	}
	return nil, &toolError{Code: "run_not_found", Message: "no saved run " + id + " under " + results.Dir(""), Hint: "list_runs lists them"}
}

func (s *mcpServer) listRuns(ctx context.Context, in runsIn) (*runsOut, error) {
	dir := results.Dir("")
	if in.Case != "" {
		dir = filepath.Join(dir, "cases", results.Sanitize(in.Case))
	}
	files, _ := results.Outputs(dir)
	out := &runsOut{Runs: []runSummary{}}
	limit := orInt(in.Limit, 20)
	tool := ""
	if in.Tool != "" {
		tool = toolDir(in.Tool)
	}
	for i := len(files) - 1; i >= 0 && len(out.Runs) < limit; i-- {
		m := results.MetaFor(files[i])
		if m == nil {
			continue
		}
		if tool != "" && results.Sanitize(m.Tool) != tool {
			continue
		}
		if in.Target != "" && results.Sanitize(m.Target) != results.Sanitize(in.Target) {
			continue
		}
		out.Runs = append(out.Runs, summaryOf(files[i], m))
	}
	return out, nil
}

func (s *mcpServer) getRun(ctx context.Context, in getRunIn) (*getRunOut, error) {
	if lr := s.liveRun(in.RunID); lr != nil && !lr.isDone() {
		return &getRunOut{Run: runSummary{RunID: lr.id, Tool: lr.tool, Status: "running", StartedAt: lr.started.UTC().Format("2006-01-02T15:04:05Z")},
			Note: "still running; call get_run again in a little while, or cancel_run"}, nil
	}
	r, err := findSavedRun(in.RunID)
	if err != nil {
		return nil, err
	}
	out := &getRunOut{Run: summaryOf(r.output, r.meta), Total: len(r.meta.Entities), Offset: in.Offset, Warnings: r.meta.Warnings,
		Artifact: r.meta.Artifact, OutputHash: r.meta.SHA256, Note: untrustedNote}
	switch in.View {
	case "summary":
		ind, err := results.Extract([]string{r.output})
		if err != nil {
			return nil, err
		}
		cleanIndicators(ind)
		out.Summary = ind
	case "", "entities":
		limit := orInt(in.Limit, 50)
		if limit > 200 {
			limit = 200
		}
		lo := min(max(in.Offset, 0), len(r.meta.Entities))
		hi := min(lo+limit, len(r.meta.Entities))
		out.Entities = cleanEntities(r.meta.Entities[lo:hi])
	default:
		return nil, &toolError{Code: "usage", Message: "view is entities or summary"}
	}
	if in.IncludeRaw {
		b, err := os.ReadFile(r.output)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		budget := s.sess.Policy.MaxOutputChars / 2
		if len(b) > budget {
			b, out.RawCut = b[:budget], true
		}
		out.Raw = stripControl(string(b))
	}
	return out, nil
}

// sortedKeys is used for stable messages.
func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
