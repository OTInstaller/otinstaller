package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// pivotCommand is one suggested next run as a command line.
type pivotCommand struct {
	pivot
	Commands []string `json:"commands"`
}

func (a *App) pivotCmd() *cobra.Command {
	var registry bool
	var limit int
	cmd := &cobra.Command{
		Use:   "pivot <run-id | saved file>",
		Short: "Suggest the next runs from what a saved run found",
		Long: "Reads a saved run's entities and lists, for each one worth following, the input type it fits (from the pivot map,\n" +
			"spec/pivots.json) and the installed tools that take it, with the `ot run` command for each.\n" +
			"--registry also lists tools you haven't installed. Nothing is run.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var meta *results.Meta
			if _, err := os.Stat(args[0]); err == nil {
				if strings.HasSuffix(args[0], ".meta.json") {
					meta = metaFile(args[0])
				} else {
					meta = results.MetaFor(args[0])
				}
				if meta == nil {
					return exitErr(ExitUsage, "%s has no .meta.json sidecar next to it", args[0])
				}
			} else {
				r, err := findSavedRun(args[0])
				if err != nil {
					return exitErr(ExitUsage, "no saved run %s under %s; give a run id from `ot run` or a saved file", args[0], strings.Join(resultDirs(), " or "))
				}
				meta = r.meta
			}
			var own []string
			for _, v := range meta.Input {
				own = append(own, v)
			}
			out := a.pivots(cmd.Context(), meta.Entities, registry, limit, own...)
			st, _ := state.Load()
			var rows []pivotCommand
			for _, p := range out.Pivots {
				pc := pivotCommand{pivot: p, Commands: []string{}}
				for _, ref := range p.Installed {
					if st == nil || st.Installed[ref] == nil {
						continue
					}
					pc.Commands = append(pc.Commands, runLine(st.Installed[ref].Manifest, p.InputType, p.Value))
				}
				rows = append(rows, pc)
			}
			if a.jsonMode() {
				if rows == nil {
					rows = []pivotCommand{}
				}
				return writeJSON(a.Out, map[string]any{"run_id": meta.RunID, "pivots": rows})
			}
			if len(rows) == 0 {
				fmt.Fprintf(a.Out, "Nothing in %s's %d entities to pivot on.\n", meta.Ref, len(meta.Entities))
				return nil
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "ENTITY\tVALUE\tINPUT\tNEXT")
			for _, r := range rows {
				next := strings.Join(r.Commands, "  |  ")
				if next == "" {
					next = "no installed tool takes " + r.InputType
					if len(r.Registry) > 0 {
						next += "; try " + strings.SplitN(r.Registry[0], ":", 2)[0]
					}
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.EntityType, truncate(r.Value, 40), r.InputType, next)
			}
			return tw.Flush()
		},
	}
	cmd.Flags().BoolVar(&registry, "registry", false, "also suggest tools from the registry that aren't installed")
	cmd.Flags().IntVar(&limit, "limit", 25, "at most this many pivots")
	return cmd
}

// runLine is the `ot run` command that feeds value to a tool's input of a type.
func runLine(m *manifest.Manifest, inputType, value string) string {
	arg := value
	if strings.ContainsAny(arg, " \t\"'") {
		arg = `"` + strings.ReplaceAll(arg, `"`, `\"`) + `"`
	}
	if p := prefixFor(inputType); p != "" && len(inputsOfType(m, inputType)) == 1 {
		return fmt.Sprintf("ot run %s %s:%s", m.Ref(), p, arg)
	}
	if names := inputsOfType(m, inputType); len(names) > 0 {
		return fmt.Sprintf("ot run %s --%s %s", m.Ref(), names[0], arg)
	}
	return "ot run " + m.Ref()
}

func inputsOfType(m *manifest.Manifest, typ string) []string {
	var out []string
	for _, in := range m.Inputs {
		if in.Type == typ {
			out = append(out, in.Name)
		}
	}
	return out
}

func metaFile(path string) *results.Meta {
	files, _ := results.Outputs(filepath.Dir(path))
	stem := strings.TrimSuffix(path, ".meta.json")
	for _, f := range files {
		if strings.TrimSuffix(f, filepath.Ext(f)) == stem {
			return results.MetaFor(f)
		}
	}
	return nil
}
