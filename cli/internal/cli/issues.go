package cli

import (
	"fmt"
	"runtime"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// issuesCmd lists a package's community issues, so people check for a known problem before opening another.
func (a *App) issuesCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "issues <namespace/name>",
		Short: "List a package's open issues (problems people reported, questions, requests)",
		Long: "Lists the package's open issues from the registry's community, newest activity first. " +
			"Open one on the website, or say a version works or is broken for you with `ot report <tool> --works` or `--broken`.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := parseRef(args[0])
			if err != nil || ref.LocalPath != "" {
				return exitErr(ExitUsage, "give a package as namespace/name")
			}
			status := "open"
			if all {
				status = "all"
			}
			list, err := a.API.Issues(cmd.Context(), ref.NS, ref.Name, status)
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, list)
			}
			page := strings.TrimRight(a.Config.SiteURL, "/") + "/" + ref.Ref() + "/issues"
			if len(list.Issues) == 0 {
				fmt.Fprintf(a.Out, "No %s issues on %s. Something wrong? Open one at %s\n", map[bool]string{true: "", false: "open"}[all], ref.Ref(), page)
				return nil
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "#\tKIND\tSTATUS\tVERSION\tREPLIES\tTITLE")
			for _, i := range list.Issues {
				fmt.Fprintf(tw, "%d\t%s\t%s\t%s\t%d\t%s\n", i.Number, strings.ReplaceAll(i.Kind, "_", " "), strings.ReplaceAll(i.Status, "_", " "), orDash(i.Version), i.Comments, i.Title)
			}
			_ = tw.Flush()
			fmt.Fprintf(a.Err, "%d open, %d closed: %s\n", list.Counts.Open, list.Counts.Closed, page)
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "closed issues too")
	return cmd
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// confirmVersion records "works for me" or "broken for me" on the installed version (or the latest), for
// `ot report <tool> --works | --broken`. Broken goes through the same path as the failure prompt, so it joins or
// opens the version's broken issue.
func (a *App) confirmVersion(cmd *cobra.Command, ref pkgRef, version string, works bool) error {
	native := false
	if st, err := state.Load(); err == nil {
		if inst, ok := st.Installed[ref.Ref()]; ok && (version == "" || version == inst.Version) {
			version, native = inst.Version, inst.Native
		}
	}
	if works {
		if a.API.Token == "" {
			return exitErr(ExitUsage, "saying a version works needs a sign-in: run `ot login`")
		}
		c, err := a.API.Confirm(cmd.Context(), ref.NS, ref.Name, "works", version, runtime.GOOS+"/"+runtime.GOARCH, a.engineName(native), Version)
		if err != nil {
			return a.requestError(err)
		}
		if a.jsonMode() {
			return writeJSON(a.Out, c)
		}
		fmt.Fprintf(a.Out, "Thanks. %d %s %s works in the last 30 days.\n", c.Works, map[bool]string{true: "person says", false: "people say"}[c.Works == 1], c.Version)
		return nil
	}
	if version == "" {
		return exitErr(ExitUsage, "say which version is broken with --version, or install it first")
	}
	res, err := a.sendRunReport(cmd.Context(), failedRun{ref: ref, version: version, native: native, exitCode: 1})
	if err != nil {
		return a.requestError(err)
	}
	if a.jsonMode() {
		return writeJSON(a.Out, res)
	}
	fmt.Fprintln(a.Out, reportOutcome(a, failedRun{ref: ref, version: version}, res))
	return nil
}
