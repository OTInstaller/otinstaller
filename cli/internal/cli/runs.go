package cli

// `ot runs`: the saved runs, newest first, and one run in detail. MCP's list_runs and get_run read the same files
// (mcp_tools.go); `ot extract` and `ot diff` read their contents (saved.go).

import (
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/results"
)

// runFilter picks saved runs for `ot runs` and MCP's list_runs.
type runFilter struct {
	// Tool is namespace/name or just the name; Case narrows each folder to its cases/<case> folder.
	Tool, Target, Case, Status string
	// Since leaves out runs started before it; zero keeps them all.
	Since time.Time
	// Limit is how many, newest first; 0 for all.
	Limit int
}

// listSavedRuns lists the runs saved under dirs that pass the filter, newest first.
func listSavedRuns(dirs []string, f runFilter) []runSummary {
	var files []string
	for _, dir := range dirs {
		if f.Case != "" {
			dir = filepath.Join(dir, "cases", results.Sanitize(f.Case))
		}
		found, _ := results.Outputs(dir)
		files = append(files, found...)
	}
	// Each folder's files come oldest first; across folders, the time stamp that starts each file name orders them.
	if len(dirs) > 1 {
		sort.SliceStable(files, func(i, j int) bool { return runStamp(files[i]) < runStamp(files[j]) })
	}
	tool := ""
	if f.Tool != "" {
		tool = toolDir(f.Tool)
	}
	out := []runSummary{}
	for i := len(files) - 1; i >= 0 && (f.Limit <= 0 || len(out) < f.Limit); i-- {
		m := results.MetaFor(files[i])
		switch {
		case m == nil,
			tool != "" && results.Sanitize(m.Tool) != tool,
			f.Target != "" && results.Sanitize(m.Target) != results.Sanitize(f.Target),
			f.Status != "" && m.Status != f.Status,
			!f.Since.IsZero() && m.StartedAt.Before(f.Since):
			continue
		}
		out = append(out, summaryOf(files[i], m))
	}
	return out
}

// runStamp is the time stamp a saved file's name starts with: <time>_<tool>_<target>_<id>.<ext>.
func runStamp(path string) string {
	stamp, _, _ := strings.Cut(filepath.Base(path), "_")
	return stamp
}

func (a *App) runsCmd() *cobra.Command {
	var f runFilter
	var since time.Duration
	var resultsDir string
	cmd := &cobra.Command{
		Use:   "runs [run-id]",
		Short: "List saved runs, or show one",
		Long: "Lists the runs saved under the results folder ($OT_RESULTS_DIR, else results_dir in config.json, else ./results) and <ot home>/results, newest\n" +
			"first: by default the last 20 from the past week. With a run id it shows that run: what ran, how it ended, what it\n" +
			"found and where it is saved. `ot pivot <run-id>` then suggests what to run next.",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dirs := resultDirs()
			if resultsDir != "" {
				dirs = []string{results.Dir(resultsDir)}
			}
			if len(args) == 1 {
				return a.showRun(dirs, args[0])
			}
			switch f.Status {
			case "", results.StatusComplete, results.StatusFailed, results.StatusTimeout, results.StatusInterrupted:
			default:
				return exitErr(ExitUsage, "--status is complete, failed, timeout or interrupted, not %q", f.Status)
			}
			if since < 0 || f.Limit < 0 {
				return exitErr(ExitUsage, "--since and --limit can't be negative")
			}
			if since > 0 {
				f.Since = time.Now().Add(-since)
			}
			runs := listSavedRuns(dirs, f)
			if a.jsonMode() {
				return writeJSON(a.Out, runs)
			}
			if len(runs) == 0 {
				when := ""
				switch {
				case since > 0 && since%(24*time.Hour) == 0:
					when = " from the last " + plural(int(since/(24*time.Hour)), "day", "days")
				case since > 0:
					when = " from the last " + since.String()
				}
				fmt.Fprintf(a.Out, "No saved runs%s under %s.\n", when, strings.Join(dirs, " or "))
				return nil
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "RUN\tSTARTED\tTOOL\tTARGET\tSTATUS\tENTITIES\tCASE")
			for _, r := range runs {
				status := r.Status
				if r.ExitCode != 0 {
					status = fmt.Sprintf("%s (exit %d)", status, r.ExitCode)
				}
				started := r.StartedAt
				if t, err := time.Parse("2006-01-02T15:04:05Z", r.StartedAt); err == nil {
					started = t.Local().Format("2006-01-02 15:04")
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%d\t%s\n", r.RunID, started, r.Tool, truncate(r.Target, 40), status, r.Entities, orDefault(r.Case, "-"))
			}
			if err := tw.Flush(); err != nil {
				return err
			}
			if f.Limit > 0 && len(runs) == f.Limit {
				fmt.Fprintf(a.Err, "note: the newest %d; --limit 0 lists them all\n", f.Limit)
			}
			fmt.Fprintln(a.Err, "`ot runs <run-id>` shows a run; `ot pivot <run-id>` suggests what to run next.")
			return nil
		},
	}
	fl := cmd.Flags()
	fl.StringVar(&f.Tool, "tool", "", "only runs of this tool (namespace/name or name)")
	fl.StringVar(&f.Target, "target", "", "only runs against this target")
	fl.StringVar(&f.Case, "case", "", "only runs saved under this case")
	fl.StringVar(&f.Status, "status", "", "only runs that ended complete, failed, timeout or interrupted")
	fl.DurationVar(&since, "since", 7*24*time.Hour, "only runs started this long ago or less (0 for all)")
	fl.IntVar(&f.Limit, "limit", 20, "at most this many, newest first (0 for all)")
	fl.StringVar(&resultsDir, "results-dir", "", "read runs from this folder only (default $OT_RESULTS_DIR, else results_dir in config.json, else ./results, and <ot home>/results)")
	return cmd
}

// showRun prints one saved run: its sidecar in JSON mode, else a summary with what it found.
func (a *App) showRun(dirs []string, id string) error {
	r, err := findSavedRunIn(dirs, id)
	if err != nil {
		var te *toolError
		if errors.As(err, &te) {
			return &ExitError{Code: ExitUsage, Reason: te.Code, Err: errors.New(te.Message + "; `ot runs` lists them")}
		}
		return err
	}
	m := r.meta
	if a.jsonMode() {
		return writeJSON(a.Out, m)
	}
	s := summaryOf(r.output, m)
	fmt.Fprintf(a.Out, "Run %s: %s %s against %s\n", s.RunID, s.Tool, s.Version, orDefault(s.Target, "(no target)"))
	fmt.Fprintf(a.Out, "Status:   %s, exit %d, %s, %.1fs\n", s.Status, s.ExitCode, plural(s.Entities, "entity", "entities"), m.DurationSeconds)
	fmt.Fprintf(a.Out, "Started:  %s\n", m.StartedAt.Local().Format("2006-01-02 15:04:05"))
	if s.Case != "" {
		fmt.Fprintf(a.Out, "Case:     %s\n", s.Case)
	}
	fmt.Fprintf(a.Out, "Saved:    %s\n", r.output)
	for _, w := range m.Warnings {
		fmt.Fprintf(a.Out, "Warning:  %s\n", w)
	}
	if top := firstDistinct(m.Entities, 10); len(top) > 0 {
		fmt.Fprintln(a.Out, "Found:")
		tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
		for _, e := range top {
			fmt.Fprintf(tw, "  %s\t%s\n", e.Type, truncate(e.Value, 80))
		}
		tw.Flush()
		if rest := len(m.Entities) - len(top); rest > 0 {
			fmt.Fprintf(a.Out, "  … all %d are in %s\n", len(m.Entities), strings.TrimSuffix(r.output, filepath.Ext(r.output))+".meta.json")
		}
	}
	if len(m.Entities) > 0 {
		fmt.Fprintf(a.Out, "\nNext: `ot pivot %s` suggests what to run on what it found.\n", s.RunID)
	}
	return nil
}
