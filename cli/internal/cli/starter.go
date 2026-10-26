package cli

// What ot does when nothing installed can take a target, as on a fresh machine: at a terminal it offers the tools of a
// bundled playbook for that input type, as the registry describes them now, and installs them after one yes. Without
// a terminal it never installs; the not_installed error names the command that would. Playbooks themselves are in
// playbook.go; `ot mcp` answers with install_tool instead (mcp_run.go).

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/otinstaller/otinstaller/cli/internal/agent"
	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/playbook"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
)

// noToolsError is planAll's error when no installed tool has an input of the typed inputs' types.
type noToolsError struct {
	typed []runner.TypedInput
}

func (e *noToolsError) Error() string {
	return fmt.Sprintf("no installed tool has %s input", withArticle(typedTypes(e.typed)))
}

// withArticle puts "a" or "an" before an input type: "an email", "a username or email".
func withArticle(types string) string {
	if strings.HasPrefix(types, "email") || strings.HasPrefix(types, "ip") {
		return "an " + types
	}
	return "a " + types
}

// starterPick is a bundled playbook to offer for one typed input.
type starterPick struct {
	playbook *playbook.Playbook
	input    runner.TypedInput
}

// starters picks a bundled playbook for each typed input that has one, each playbook once.
func starters(typed []runner.TypedInput) []starterPick {
	var picks []starterPick
	seen := map[string]bool{}
	for _, t := range typed {
		p := playbook.Starter(runner.TypedPrefixes[t.Prefix])
		if p == nil || seen[p.Name] {
			continue
		}
		seen[p.Name] = true
		picks = append(picks, starterPick{p, t})
	}
	return picks
}

// starterTools are the tools of the picked playbooks that take one of the typed inputs' types, as the playbooks list
// them; the registry has the final say on what each takes.
func starterTools(picks []starterPick) []string {
	var refs []string
	seen := map[string]bool{}
	for _, s := range picks {
		for _, ref := range s.playbook.Tools {
			if !seen[ref] {
				seen[ref] = true
				refs = append(refs, ref)
			}
		}
	}
	return refs
}

// notInstalledError is a noToolsError for someone who can't be asked (or said no): exit 2, code not_installed, and a
// hint naming the `ot playbook ... --yes` command that installs tools for the input and runs them.
func notInstalledError(nt *noToolsError) error {
	e := &ExitError{Code: ExitUsage, Reason: "not_installed", Err: nt}
	var cmds []string
	for _, s := range starters(nt.typed) {
		cmds = append(cmds, fmt.Sprintf("`ot playbook %s %s --yes`", s.playbook.Name, quoteArgs([]string{s.input.Prefix + ":" + s.input.Value})[0]))
	}
	if len(cmds) > 0 {
		e.Hint = "install a bundled playbook's tools and run them with " + strings.Join(cmds, " or ") + ", or find tools with `ot search`"
	} else {
		e.Hint = fmt.Sprintf("find tools that take it with `ot search --input %s`, then `ot install` them", runner.TypedPrefixes[nt.typed[0].Prefix])
	}
	return e
}

// offerStarters is what runAll does about a noToolsError: at a terminal, offer the starter playbooks' tools that take
// the inputs and install the ones the person agrees to; otherwise (or for a dry run) the not_installed error.
func (a *App) offerStarters(ctx context.Context, ra *runArgs, nt *noToolsError) error {
	picks := starters(nt.typed)
	if len(picks) == 0 || ra.DryRun || !a.interactive() {
		return notInstalledError(nt)
	}
	types := map[string]bool{}
	for _, t := range nt.typed {
		types[runner.TypedPrefixes[t.Prefix]] = true
	}
	var names []string
	for _, s := range picks {
		names = append(names, s.playbook.Name)
	}
	fmt.Fprintf(a.Err, "No installed tool takes %s. The bundled %s playbook has some:\n", withArticle(typedTypes(nt.typed)), strings.Join(names, " and "))
	refs, err := a.offerInstall(ctx, starterTools(picks), types)
	if err != nil {
		return err
	}
	if len(refs) == 0 {
		return notInstalledError(nt)
	}
	return a.installSome(ctx, refs, ra.Native)
}

// offerInstall describes tools as the registry has them now (`ref version: summary (what a run does)`) and asks once
// whether to install them. Deprecated, possibly broken and removed tools are left out with a note, and so are tools
// with none of the input types in types, when types is given. It returns the refs to install: none when the person
// says no or nothing is left.
func (a *App) offerInstall(ctx context.Context, refs []string, types map[string]bool) ([]string, error) {
	var keep []string
	for _, ref := range refs {
		r, err := parseRef(ref)
		if err != nil {
			return nil, err
		}
		t, err := a.API.Tool(ctx, r.NS, r.Name)
		var ue *api.UnreachableError
		switch {
		case errors.As(err, &ue):
			return nil, err
		case err != nil:
			fmt.Fprintf(a.Err, "  note: leaving out %s: %v\n", ref, err)
			continue
		case t.Status == "deprecated":
			fmt.Fprintf(a.Err, "  note: leaving out %s: it is deprecated\n", ref)
			continue
		case t.Health == "broken":
			fmt.Fprintf(a.Err, "  note: leaving out %s: people who use it mark it possibly broken\n", ref)
			continue
		case t.Kind == "guide":
			continue
		}
		if types != nil && !takesAny(t.Inputs, types) {
			continue
		}
		effects := "runs offline"
		if _, m, err := manifest.ParseJSON(t.Manifest); err == nil && m.Runtime != nil {
			effects = strings.Join(agent.Describe(m), ", ")
		}
		fmt.Fprintf(a.Err, "  %s %s: %s (%s)\n", ref, t.LatestVersion, t.Summary, effects)
		keep = append(keep, ref)
	}
	if len(keep) == 0 {
		fmt.Fprintln(a.Err, "Nothing to install.")
		return nil, nil
	}
	fmt.Fprintf(a.Err, "Install %s and run? [y/N] ", plural(len(keep), "tool", "tools"))
	line, _ := bufio.NewReader(a.In).ReadString('\n')
	if ans := strings.ToLower(strings.TrimSpace(line)); ans != "y" && ans != "yes" {
		return nil, nil
	}
	return keep, nil
}

func takesAny(inputs []string, types map[string]bool) bool {
	for _, in := range inputs {
		if types[in] {
			return true
		}
	}
	return false
}

// installSome installs the tools someone agreed to. Failures are reported and the run goes on with what installed,
// unless nothing did or Docker or Podman is missing.
func (a *App) installSome(ctx context.Context, refs []string, native bool) error {
	var todo []pkgRef
	for _, ref := range refs {
		r, err := parseRef(ref)
		if err != nil {
			return err
		}
		todo = append(todo, r)
	}
	res, err := a.installMany(ctx, todo, native)
	if err == nil {
		return nil
	}
	installed := 0
	for _, r := range res {
		if r.inst != nil {
			installed++
		}
	}
	if installed == 0 || ExitCodeFor(err) == ExitRuntimeMissing {
		return err
	}
	fmt.Fprintf(a.Err, "warning: %v; running the rest\n", err)
	return nil
}
