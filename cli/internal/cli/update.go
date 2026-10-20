package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// updateRow is one installed package compared with the registry.
type updateRow struct {
	Ref       string `json:"ref"`
	Installed string `json:"installed"`
	Latest    string `json:"latest,omitempty"`
	// Status: "up to date", "update available", "updated", "removed", "not in registry" or "error".
	Status string `json:"status"`
	Note   string `json:"note,omitempty"`
}

// checkUpdates asks the registry for the latest version of each package.
func (a *App) checkUpdates(ctx context.Context, insts []*state.Installed) []*updateRow {
	var rows []*updateRow
	for _, inst := range insts {
		row := &updateRow{Ref: inst.Ref, Installed: inst.Version}
		rows = append(rows, row)
		ns, name, _ := strings.Cut(inst.Ref, "/")
		resp, err := a.API.Manifest(ctx, ns, name, "")
		var ae *api.Error
		switch {
		case err == nil:
		case errors.As(err, &ae) && ae.Status == 404:
			row.Status, row.Note = "not in registry", "installed from a local manifest, or unpublished"
			continue
		default:
			if re, ok := isRemoved(err); ok {
				row.Status, row.Note = "removed", re.Message
			} else {
				row.Status, row.Note = "error", err.Error()
			}
			continue
		}
		row.Latest = resp.Version
		switch {
		case resp.Status == "removed":
			row.Status, row.Note = "removed", resp.RemovedReason
		case semverLess(inst.Version, resp.Version):
			row.Status = "update available"
		default:
			row.Status = "up to date"
		}
		if resp.MovedTo != "" {
			row.Note = "moved to " + resp.MovedTo
		}
	}
	return rows
}

func (a *App) printUpdateRows(rows []*updateRow, asJSON bool) error {
	if asJSON {
		return writeJSON(a.Out, rows)
	}
	tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "PACKAGE\tINSTALLED\tLATEST\tSTATUS")
	for _, r := range rows {
		status := r.Status
		if r.Note != "" {
			status += " (" + r.Note + ")"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.Ref, r.Installed, orDefault(r.Latest, "-"), status)
	}
	return tw.Flush()
}

func (a *App) outdatedCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "outdated",
		Short: "Check installed packages for newer versions (changes nothing)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := state.Load()
			if err != nil {
				return err
			}
			if len(st.Installed) == 0 {
				fmt.Fprintln(a.Err, "Nothing installed yet.")
				return nil
			}
			return a.printUpdateRows(a.checkUpdates(cmd.Context(), st.Sorted()), asJSON)
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) updateCmd() *cobra.Command {
	var all, asJSON bool
	cmd := &cobra.Command{
		Use:   "update [namespace/name ...]",
		Short: "Install the latest version of installed packages",
		Long: "Install the latest published version of the named packages, or of every installed package with --all.\n" +
			"Each update goes through the same signature and trust checks as `ot install`.",
		RunE: func(cmd *cobra.Command, args []string) error {
			if all == (len(args) > 0) {
				return exitErr(ExitUsage, "name the packages to update, or use --all")
			}
			st, err := state.Load()
			if err != nil {
				return err
			}
			insts := st.Sorted()
			if !all {
				insts = nil
				for _, ref := range args {
					inst := st.Installed[ref]
					if inst == nil {
						return exitErr(ExitUsage, "%s is not installed; install it with `ot install %s`", ref, ref)
					}
					insts = append(insts, inst)
				}
			}
			rows := a.checkUpdates(cmd.Context(), insts)
			failed := false
			for i, row := range rows {
				if row.Status != "update available" {
					continue
				}
				ns, name, _ := strings.Cut(row.Ref, "/")
				inst, err := a.install(cmd.Context(), pkgRef{NS: ns, Name: name}, insts[i].Native)
				if err != nil {
					row.Status, row.Note, failed = "error", err.Error(), true
					continue
				}
				row.Status, row.Note = "updated", "from "+row.Installed
				row.Installed = inst.Version
			}
			if err := a.printUpdateRows(rows, asJSON); err != nil {
				return err
			}
			for _, r := range rows {
				if r.Status == "error" || (!all && r.Status != "updated" && r.Status != "up to date") {
					failed = true
				}
			}
			if failed {
				return &ExitError{Code: ExitToolError}
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "update every installed package")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}
