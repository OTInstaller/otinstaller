package cli

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
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
	// Flags are what else to know, whatever the status: deprecated, possibly_broken, yanked (the installed version),
	// source_unavailable and moved.
	Flags []string `json:"flags"`
	// Replacement is the package to move to: the deprecation's replacement, or where the package moved.
	Replacement string `json:"replacement,omitempty"`
	// warnings are the flags as sentences, printed on stderr.
	warnings []string
}

// checkConcurrency is how many packages are checked at once.
const checkConcurrency = 4

// checkUpdates asks the registry about each package: its latest version and lifecycle (GET /tools/:ns/:name), and
// whether the installed version was yanked or removed (GET /tools/:ns/:name/versions). Rows keep the order of insts.
func (a *App) checkUpdates(ctx context.Context, insts []*state.Installed) []*updateRow {
	rows := make([]*updateRow, len(insts))
	sem := make(chan struct{}, checkConcurrency)
	var wg sync.WaitGroup
	for i, inst := range insts {
		rows[i] = &updateRow{Ref: inst.Ref, Installed: inst.Version, Flags: []string{}}
		wg.Add(1)
		go func(row *updateRow) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			a.checkUpdate(ctx, row)
		}(rows[i])
	}
	wg.Wait()
	return rows
}

func (a *App) checkUpdate(ctx context.Context, row *updateRow) {
	ns, name, _ := strings.Cut(row.Ref, "/")
	t, err := a.API.Tool(ctx, ns, name)
	var ae *api.Error
	switch {
	case err == nil:
	case errors.As(err, &ae) && ae.Status == 404:
		row.Status, row.Note = "not in registry", "installed from a local manifest, or unpublished"
		return
	default:
		if re, ok := isRemoved(err); ok {
			row.Status, row.Note = "removed", re.Message
		} else {
			row.Status, row.Note = "error", err.Error()
		}
		return
	}
	row.Latest = t.LatestVersion
	row.Status = "up to date"
	if semverLess(row.Installed, t.LatestVersion) {
		row.Status = "update available"
	}
	// The installed version may have been yanked or removed since, even when it is still the latest.
	if versions, err := a.API.Versions(ctx, ns, name); err == nil {
		for _, v := range versions {
			switch {
			case v.Version != row.Installed:
			case v.Status == "removed":
				row.Status, row.Note = "removed", row.Ref+"@"+row.Installed+" was removed from the registry"
			case v.Status == "yanked":
				w := fmt.Sprintf("%s@%s was yanked by its publisher", row.Ref, row.Installed)
				if row.Status == "update available" {
					w += fmt.Sprintf("; `ot update %s` installs %s", row.Ref, t.LatestVersion)
				}
				row.flag("yanked", w)
			}
		}
	}
	if t.Status == "deprecated" {
		w := row.Ref + " is deprecated"
		if t.DeprecatedMsg != "" {
			w += ": " + strings.TrimSuffix(t.DeprecatedMsg, ".")
		}
		if t.Replacement != "" {
			row.Replacement = t.Replacement
			w += fmt.Sprintf("; its publisher suggests %s (`ot install %s`)", t.Replacement, t.Replacement)
		}
		row.flag("deprecated", w)
	}
	if t.Health == "broken" {
		row.flag("possibly_broken", row.Ref+" is marked possibly broken by recent health checks")
	}
	if t.SourceGone {
		row.flag("source_unavailable", "the source repository of "+row.Ref+" is no longer available; it will get no new versions")
	}
	if t.MovedTo != "" {
		row.Note = "moved to " + t.MovedTo
		if row.Replacement == "" {
			row.Replacement = t.MovedTo
		}
		row.flag("moved", fmt.Sprintf("%s has moved to %s; install it there with `ot install %s`, then `ot uninstall %s`", row.Ref, t.MovedTo, t.MovedTo, row.Ref))
	}
}

// flag adds a lifecycle flag and the warning that explains it.
func (r *updateRow) flag(name, warning string) {
	r.Flags = append(r.Flags, name)
	r.warnings = append(r.warnings, warning)
}

// unflag drops a flag that no longer holds, such as yanked once a newer version is installed.
func (r *updateRow) unflag(name string) {
	for i, f := range r.Flags {
		if f == name {
			r.Flags = append(r.Flags[:i:i], r.Flags[i+1:]...)
			r.warnings = append(r.warnings[:i:i], r.warnings[i+1:]...)
			return
		}
	}
}

func (a *App) printUpdateRows(rows []*updateRow) error {
	// One warning per flag, on stderr in both modes, so a person sees them under JSON too.
	defer func() {
		for _, r := range rows {
			for _, w := range r.warnings {
				fmt.Fprintln(a.Err, "warning:", w)
			}
		}
	}()
	if a.jsonMode() {
		return writeJSON(a.Out, rows)
	}
	tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "PACKAGE\tINSTALLED\tLATEST\tSTATUS")
	for _, r := range rows {
		status := r.Status
		if r.Note != "" {
			status += " (" + r.Note + ")"
		}
		if len(r.Flags) > 0 {
			status += " [" + strings.ReplaceAll(strings.Join(r.Flags, ", "), "_", " ") + "]"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.Ref, r.Installed, orDefault(r.Latest, "-"), status)
	}
	return tw.Flush()
}

func (a *App) outdatedCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "outdated",
		Short: "Check installed packages for newer versions (changes nothing)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// ot itself is checked too, at most once a day, and said last.
			defer a.noteNewerOT(cmd.Context())
			st, err := state.Load()
			if err != nil {
				return err
			}
			if len(st.Installed) == 0 {
				fmt.Fprintln(a.Err, "Nothing installed yet.")
				return nil
			}
			return a.printUpdateRows(a.checkUpdates(cmd.Context(), st.Sorted()))
		},
	}
	return cmd
}

func (a *App) updateCmd() *cobra.Command {
	var all bool
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
				row.unflag("yanked")
			}
			if err := a.printUpdateRows(rows); err != nil {
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
	return cmd
}
