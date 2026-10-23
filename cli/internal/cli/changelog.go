package cli

import (
	"context"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// whatsNewLines is how much of a release's notes `ot info` prints; `ot changelog` prints them whole.
const whatsNewLines = 12

// changelogCmd prints a package's release notes: the versions newer than the installed one, or the latest few.
func (a *App) changelogCmd() *cobra.Command {
	var all bool
	var limit int
	cmd := &cobra.Command{
		Use:   "changelog <namespace/name>",
		Short: "Show a package's release notes, newest first",
		Long: "Prints the release notes the registry captured for each version (the host's release, or the version's\n" +
			"section of CHANGELOG.md). For an installed package it shows the versions newer than yours, so you can see what\n" +
			"`ot update` would bring; otherwise, or with --all, the latest ones.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := parseRef(args[0])
			if err != nil {
				return err
			}
			if ref.LocalPath != "" {
				return exitErr(ExitUsage, "release notes come from the registry; give a package as namespace/name")
			}
			versions, err := a.API.Versions(cmd.Context(), ref.NS, ref.Name)
			if err != nil {
				return a.requestError(err)
			}
			installed := ""
			if st, err := state.Load(); err == nil {
				if inst, ok := st.Installed[ref.Ref()]; ok {
					installed = inst.Version
				}
			}
			shown := releasedVersions(versions)
			if installed != "" && !all {
				var newer []api.Version
				for _, v := range shown {
					if semverLess(installed, v.Version) {
						newer = append(newer, v)
					}
				}
				shown = newer
			}
			if limit > 0 && len(shown) > limit {
				shown = shown[:limit]
			}
			if a.jsonMode() {
				out := make([]map[string]any, 0, len(shown))
				for _, v := range shown {
					out = append(out, map[string]any{"version": v.Version, "status": v.Status, "published_at": v.PublishedAt, "changelog": cleanNotes(v.Changelog)})
				}
				return writeJSON(a.Out, map[string]any{"ref": ref.Ref(), "installed": installed, "versions": out})
			}
			if len(shown) == 0 {
				if installed != "" {
					fmt.Fprintf(a.Out, "%s %s is the latest version. `ot changelog %s --all` shows earlier notes.\n", ref.Ref(), installed, ref.Ref())
				} else {
					fmt.Fprintf(a.Out, "%s has no published versions.\n", ref.Ref())
				}
				return nil
			}
			if installed != "" && !all {
				fmt.Fprintf(a.Err, "You have %s; newer versions:\n\n", installed)
			}
			for i, v := range shown {
				if i > 0 {
					fmt.Fprintln(a.Out)
				}
				printRelease(a.Out, v, 0)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "every version, not only those newer than the installed one")
	cmd.Flags().IntVar(&limit, "limit", 10, "at most this many versions (0 for all)")
	return cmd
}

// releasedVersions are the published and yanked versions, newest first (removed ones have no notes to show).
func releasedVersions(vs []api.Version) []api.Version {
	out := make([]api.Version, 0, len(vs))
	for _, v := range vs {
		if v.Status == "published" || v.Status == "yanked" {
			out = append(out, v)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return semverLess(out[j].Version, out[i].Version) })
	return out
}

// cleanNotes is a release's notes with terminal control sequences removed: they come from a publisher's repository.
func cleanNotes(s *string) string {
	if s == nil {
		return ""
	}
	return strings.TrimSpace(stripControl(*s))
}

// printRelease prints one version's heading and notes, cut to maxLines when it is more than 0.
func printRelease(w io.Writer, v api.Version, maxLines int) {
	head := v.Version
	if v.PublishedAt != nil {
		head += " · " + time.UnixMilli(*v.PublishedAt).UTC().Format("2 Jan 2006")
	}
	if v.Status == "yanked" {
		head += " · yanked"
	}
	fmt.Fprintln(w, head)
	notes := cleanNotes(v.Changelog)
	if notes == "" {
		fmt.Fprintln(w, "  (no release notes)")
		return
	}
	lines := strings.Split(notes, "\n")
	cut := maxLines > 0 && len(lines) > maxLines
	if cut {
		lines = lines[:maxLines]
	}
	for _, l := range lines {
		fmt.Fprintln(w, strings.TrimRight("  "+l, " "))
	}
	if cut {
		fmt.Fprintln(w, "  …")
	}
}

// whatsNew finds the notes of one version of a registry package, or nil when there are none (or the lookup failed).
func (a *App) whatsNew(ctx context.Context, ns, name, version string) *api.Version {
	versions, err := a.API.Versions(ctx, ns, name)
	if err != nil {
		return nil
	}
	for _, v := range versions {
		if v.Version == version && cleanNotes(v.Changelog) != "" {
			v := v
			return &v
		}
	}
	return nil
}
