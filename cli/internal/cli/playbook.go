package cli

import (
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/playbook"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

const playbookHelp = `Run a playbook: a named list of tools, run together against the same typed inputs.

Usage:
  ot playbook --list
  ot playbook <name> <type>:<value> [...] [flags]

Typed inputs fill each tool's input of that type:
  u:<username>  d:<domain>  e:<email>  p:<phone>  ip:<ip>  url:<url>
A bare target (example.com) gets its type guessed, as in ` + "`ot auto`" + `.

Tools in the playbook with no input of those types are skipped. Runs are saved under
<results-dir>/cases/playbook-<name>/ unless the playbook or --case names another case.

Playbooks are bundled with ot, or are YAML files in <ot home>/playbooks or ./playbooks
(./playbooks wins on a name clash):

  name: my-recon
  description: "What it is for"
  inputs: [domain]          # optional: the input types it is meant for
  tools:
    - osintverse-community/dnstwist
    - osintverse-community/crtsh-subdomains

Flags:
  -l, --list                list the playbooks
      --dry-run             list the tools that would run, without running them
  -f, --format string       summary as table (default) or json
  -y, --yes                 install the playbook's tools that are not installed yet, without asking
      --native              install and run pipx tools on the host instead of in a container
      --parallel int        how many tools run at once (default 4)
      --results-dir string  where runs are saved (default $OT_RESULTS_DIR, else results_dir in config.json, else ./results)
      --case string         save under <results-dir>/cases/<case>
`

func (a *App) playbookCmd() *cobra.Command {
	return &cobra.Command{
		Use:                "playbook <name> <type>:<value> ...",
		Short:              "Run a playbook (a set of tools) against typed inputs",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			list := false
			var rest []string
			for _, arg := range args {
				if arg == "--list" || arg == "-l" {
					list = true
					continue
				}
				if arg == "--all" {
					return exitErr(ExitUsage, "--all is for `ot run`; a playbook already names its tools")
				}
				rest = append(rest, arg)
			}
			ra, err := parseArgs(rest, true)
			if err != nil {
				return err
			}
			if ra.Help {
				fmt.Fprint(a.Out, playbookHelp)
				return nil
			}
			dirs := playbook.Dirs(state.Home())
			if list || ra.Pkg == "" {
				return a.listPlaybooks(dirs, ra.Format)
			}
			p, err := playbook.Find(dirs, ra.Pkg)
			if err != nil {
				return exitErr(ExitUsage, "%v", err)
			}
			st, err := state.Load()
			if err != nil {
				return err
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
			// --yes installs every missing tool; at a terminal, ot asks first and leaves out deprecated and broken ones.
			install := missing
			if len(missing) > 0 && !ra.Yes {
				install = nil
				if a.interactive() {
					fmt.Fprintf(a.Err, "Playbook %s needs tools that are not installed:\n", p.Name)
					if install, err = a.offerInstall(cmd.Context(), missing, nil); err != nil {
						return err
					}
				}
			}
			if len(install) > 0 {
				var todo []pkgRef
				for _, ref := range install {
					pr, err := parseRef(ref)
					if err != nil {
						return err
					}
					todo = append(todo, pr)
				}
				res, err := a.installMany(cmd.Context(), todo, ra.Native)
				if err != nil {
					what := "tools"
					if len(todo) == 1 {
						what = install[0]
					}
					return fmt.Errorf("installing %s for playbook %s: %w", what, p.Name, err)
				}
				// The playbook's own order is the order of the summary. A package that moved is installed under its new
				// name, so the results are matched by position. Tools left out at the question stay out.
				for i, r := range res {
					st.Installed[install[i]] = r.inst
				}
				selection = nil
				for _, ref := range p.Tools {
					if inst := st.Installed[ref]; inst != nil {
						selection = append(selection, inst)
					}
				}
			} else if len(missing) > 0 {
				var inputs []string
				for _, t := range ra.Typed {
					inputs = append(inputs, t.Prefix+":"+t.Value)
				}
				return &ExitError{Code: ExitUsage, Reason: "not_installed",
					Err: fmt.Errorf("playbook %s needs tools that are not installed: %s", p.Name, strings.Join(missing, ", ")),
					Hint: fmt.Sprintf("install them with `ot install %s`, or install and run in one go with `ot playbook %s %s --yes`",
						strings.Join(missing, " "), p.Name, strings.Join(quoteArgs(inputs), " "))}
			}
			if ra.Case == "" {
				ra.Case = p.Case
			}
			if orDefault(ra.Format, "table") == "table" {
				fmt.Fprintf(a.Err, "Playbook %s: %s\n", p.Name, strings.Join(p.Tools, ", "))
			}
			return a.runAll(cmd.Context(), ra, "a playbook", selection)
		},
	}
}

func (a *App) listPlaybooks(dirs []string, format string) error {
	all, err := playbook.All(dirs)
	if err != nil {
		return exitErr(ExitUsage, "%v", err)
	}
	switch orDefault(format, "table") {
	case "json":
		return newJSONEncoder(a.Out).Encode(all)
	case "table":
	default:
		return exitErr(ExitUsage, "playbooks are listed as table or json, not %q", format)
	}
	tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tTAKES\tDESCRIPTION\tTOOLS\tSOURCE")
	for _, p := range all {
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", p.Name, orDefault(strings.Join(p.Inputs, ", "), "-"), truncate(p.Description, 60), strings.Join(p.Tools, ", "), p.Source)
	}
	return tw.Flush()
}
