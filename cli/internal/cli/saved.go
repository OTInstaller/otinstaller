package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/results"
)

// toolDir is a package's folder in the results tree: its name without the namespace.
func toolDir(tool string) string {
	if _, name, ok := strings.Cut(tool, "/"); ok {
		tool = name
	}
	return results.Sanitize(tool)
}

func (a *App) extractCmd() *cobra.Command {
	var caseName, resultsDir string
	cmd := &cobra.Command{
		Use:   "extract <tool | path>",
		Short: "Pull emails, domains, IPs, URLs and entities out of saved results",
		Long: "Scan saved runs for emails, domains, IP addresses and URLs, and collect the entities their\n" +
			"sidecars hold. Give a tool (namespace/name or name) to scan its runs, a file or folder, or\n" +
			"--case to scan a whole case.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			base := results.Dir(resultsDir)
			var dir string
			switch {
			case caseName != "" && len(args) == 0:
				dir = filepath.Join(base, "cases", results.Sanitize(caseName))
			case caseName != "":
				dir = filepath.Join(base, "cases", results.Sanitize(caseName), toolDir(args[0]))
			case len(args) == 0:
				return exitErr(ExitUsage, "name a tool or a path, or use --case")
			default:
				dir = args[0]
				if _, err := os.Stat(dir); err != nil {
					dir = filepath.Join(base, toolDir(args[0]))
				}
			}
			if _, err := os.Stat(dir); err != nil {
				return exitErr(ExitUsage, "no saved results at %s", dir)
			}
			files, err := results.Outputs(dir)
			if err != nil {
				return err
			}
			ind, err := results.Extract(files)
			if err != nil {
				return err
			}
			if a.jsonMode() {
				return writeJSON(a.Out, ind)
			}
			found := false
			section := func(title string, values []string) {
				if len(values) == 0 {
					return
				}
				found = true
				fmt.Fprintf(a.Out, "%s:\n", title)
				for _, v := range values {
					fmt.Fprintf(a.Out, "  %s\n", v)
				}
				fmt.Fprintln(a.Out)
			}
			section("Emails", ind.Emails)
			section("Domains", ind.Domains)
			section("IPs", ind.IPs)
			section("URLs", ind.URLs)
			var types []string
			for t := range ind.Entities {
				types = append(types, t)
			}
			sort.Strings(types)
			for _, t := range types {
				section("Entities: "+t, ind.Entities[t])
			}
			if !found {
				fmt.Fprintf(a.Out, "No indicators in %d saved run(s).\n", len(files))
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&caseName, "case", "", "scan the runs saved under this case")
	cmd.Flags().StringVar(&resultsDir, "results-dir", "", "where runs are saved (default $OT_RESULTS_DIR, else ./results)")
	return cmd
}

func (a *App) diffCmd() *cobra.Command {
	var caseName, resultsDir string
	cmd := &cobra.Command{
		Use:   "diff <tool> <target>",
		Short: "Compare the two most recent saved runs of a tool against a target",
		Long: "Compare the two most recent saved runs of a tool against the same target: the output lines and\n" +
			"the entities that appeared or disappeared. Line order is ignored, since most tools list results\n" +
			"in a different order on each run.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			base := results.Dir(resultsDir)
			if caseName != "" {
				base = filepath.Join(base, "cases", results.Sanitize(caseName))
			}
			dir := filepath.Join(base, toolDir(args[0]), results.Sanitize(args[1]))
			files, _ := results.Outputs(dir)
			if len(files) < 2 {
				return exitErr(ExitUsage, "need two saved runs to compare, found %d in %s", len(files), dir)
			}
			c, err := results.Diff(files[len(files)-2], files[len(files)-1])
			if err != nil {
				return err
			}
			if a.jsonMode() {
				return writeJSON(a.Out, c)
			}
			fmt.Fprintf(a.Out, "Comparing %s (%s) with %s (%s)\n", filepath.Base(c.Older), orDefault(c.OlderDate, "?"), filepath.Base(c.Newer), orDefault(c.NewerDate, "?"))
			if len(c.Added)+len(c.Removed)+len(c.AddedEntities)+len(c.RemovedEntities) == 0 {
				fmt.Fprintln(a.Out, "No changes between these two runs.")
				return nil
			}
			for _, l := range c.AddedEntities {
				fmt.Fprintf(a.Out, "+ entity %s\n", l)
			}
			for _, l := range c.RemovedEntities {
				fmt.Fprintf(a.Out, "- entity %s\n", l)
			}
			for _, l := range c.Added {
				fmt.Fprintf(a.Out, "+ %s\n", l)
			}
			for _, l := range c.Removed {
				fmt.Fprintf(a.Out, "- %s\n", l)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&caseName, "case", "", "compare runs saved under this case")
	cmd.Flags().StringVar(&resultsDir, "results-dir", "", "where runs are saved (default $OT_RESULTS_DIR, else ./results)")
	return cmd
}
