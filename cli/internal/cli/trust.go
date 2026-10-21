package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// ---------- removed packages ----------

// removedCache is ~/.ot/cache/removed.json: the registry's removal list and when it was fetched.
type removedCache struct {
	FetchedAt time.Time          `json:"fetched_at"`
	Removed   []api.RemovedEntry `json:"removed"`
}

// removedList returns the removal list, refreshing it when it is older than maxAge. When the registry cannot
// be reached the cached list is used (and nil without one).
func (a *App) removedList(ctx context.Context, maxAge time.Duration) []api.RemovedEntry {
	path := state.Path("cache", "removed.json")
	var c removedCache
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	if time.Since(c.FetchedAt) < maxAge {
		return c.Removed
	}
	ctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()
	r, err := a.API.Removed(ctx)
	if err != nil {
		return c.Removed
	}
	c = removedCache{FetchedAt: time.Now(), Removed: r.Removed}
	if b, err := json.Marshal(c); err == nil {
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		_ = os.WriteFile(path, b, 0o644)
	}
	return c.Removed
}

// removal is the entry that removes ref@version, if any (a whole-package removal covers every version).
func removal(list []api.RemovedEntry, ref, version string) *api.RemovedEntry {
	for i, e := range list {
		if e.Ref == ref && (e.Version == "" || e.Version == version) {
			return &list[i]
		}
	}
	return nil
}

// warnRemoved tells people with a removed version installed, once a day, what to do about it.
func (a *App) warnRemoved(ctx context.Context) {
	st, err := state.Load()
	if err != nil || len(st.Installed) == 0 {
		return
	}
	list := a.removedList(ctx, 24*time.Hour)
	for _, inst := range st.Sorted() {
		if r := removal(list, inst.Ref, inst.Version); r != nil {
			fmt.Fprintf(a.Err, "warning: %s@%s was removed from the registry (%s). ot will not run it; remove it with `ot uninstall %s`.\n",
				inst.Ref, inst.Version, r.Category, inst.Ref)
		}
	}
}

// ---------- reports ----------

func (a *App) reportCmd() *cobra.Command {
	var reason, details, version string
	cmd := &cobra.Command{
		Use:   "report <namespace/name>",
		Short: "Report a tool or guide to the registry's reviewers",
		Long: "Opens the report form on the website. With --reason it files the report directly (anonymous unless you are signed in).\n" +
			"Reasons: malware, policy, impersonation, license, broken, other. Malware reports are looked at within 24 hours.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := parseRef(args[0])
			if err != nil || ref.LocalPath != "" {
				return exitErr(ExitUsage, "give a package as namespace/name")
			}
			if version == "" {
				version = ref.Version
			}
			if reason == "" {
				u := strings.TrimRight(a.Config.SiteURL, "/") + "/" + ref.Ref() + "/report"
				if version != "" {
					u += "?v=" + version
				}
				return a.openLink(u, "open the link yourself, or use --reason and --details")
			}
			r, err := a.API.Report(cmd.Context(), ref.NS, ref.Name, version, reason, details)
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, r)
			}
			fmt.Fprintf(a.Out, "Report %s filed. %s\n", r.ID, r.Note)
			return nil
		},
	}
	cmd.Flags().StringVar(&reason, "reason", "", "malware, policy, impersonation, license, broken or other")
	cmd.Flags().StringVar(&details, "details", "", "what you saw (required except for broken)")
	cmd.Flags().StringVar(&version, "version", "", "the version you are reporting")
	return cmd
}

// ---------- claims and transfers ----------

func printTransfer(a *App, t *api.Transfer) {
	if a.jsonMode() {
		_ = writeJSON(a.Out, t)
		return
	}
	kind := "Transfer"
	if t.Kind == "claim" {
		kind = "Claim"
	}
	fmt.Fprintf(a.Out, "%s %s: %s → %s (%s)\n", kind, t.ID, t.Ref, t.To, strings.ReplaceAll(t.Status, "_", " "))
	if t.Verification != "" {
		fmt.Fprintf(a.Out, "Verified by %s.\n", strings.ReplaceAll(t.Verification, "_", " "))
	}
	if t.VerificationError != "" {
		fmt.Fprintf(a.Out, "Not verified yet: %s\n", t.VerificationError)
	}
	if t.ClaimToken != "" {
		fmt.Fprintf(a.Out, "\nClaim token (shown once): %s\n", t.ClaimToken)
	}
	if t.Instructions != "" {
		fmt.Fprintf(a.Out, "%s\n", t.Instructions)
	}
	if t.Status == "pending" && t.Kind == "claim" {
		fmt.Fprintf(a.Out, "Then run: ot claim --verify %s\n", t.ID)
	}
}

func (a *App) claimCmd() *cobra.Command {
	var to, verify string
	cmd := &cobra.Command{
		Use:   "claim <namespace/name>",
		Short: "Claim a community-packaged wrapper of your own tool",
		Long: "Starts a claim on a package in osintverse-community. You prove you maintain the upstream repository through your\n" +
			"linked GitHub or GitLab account, or by committing a .otinstaller-claim file with the token printed here. An admin then\n" +
			"moves the package, with its history, stars and installs, to your namespace.",
		Args: cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`")
			}
			var t *api.Transfer
			var err error
			switch {
			case verify != "":
				t, err = a.API.TransferAction(cmd.Context(), verify, "verify")
			case len(args) == 1:
				ref, perr := parseRef(args[0])
				if perr != nil || ref.LocalPath != "" {
					return exitErr(ExitUsage, "give a package as namespace/name")
				}
				t, err = a.API.Claim(cmd.Context(), ref.NS, ref.Name, to)
			default:
				return exitErr(ExitUsage, "give a package, or --verify <claim id>")
			}
			if err != nil {
				return a.requestError(err)
			}
			printTransfer(a, t)
			return nil
		},
	}
	cmd.Flags().StringVar(&to, "to", "", "your namespace that should receive it (needed if you own several)")
	cmd.Flags().StringVar(&verify, "verify", "", "check a pending claim again")
	return cmd
}

func (a *App) transferCmd() *cobra.Command {
	var to, accept, decline string
	cmd := &cobra.Command{
		Use:   "transfer <namespace/name> --to <namespace>",
		Short: "Offer a package to another namespace, or accept or decline an offer",
		Long:  "Moves happen once the receiving namespace's owner accepts. The old address keeps working as an alias.",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`")
			}
			var t *api.Transfer
			var err error
			switch {
			case accept != "":
				t, err = a.API.TransferAction(cmd.Context(), accept, "accept")
			case decline != "":
				if _, err := a.API.TransferAction(cmd.Context(), decline, "decline"); err != nil {
					return a.requestError(err)
				}
				if a.jsonMode() {
					return writeJSON(a.Out, map[string]string{"id": decline, "status": "declined"})
				}
				fmt.Fprintf(a.Out, "Declined %s.\n", decline)
				return nil
			case len(args) == 1 && to != "":
				ref, perr := parseRef(args[0])
				if perr != nil || ref.LocalPath != "" {
					return exitErr(ExitUsage, "give a package as namespace/name")
				}
				t, err = a.API.OfferTransfer(cmd.Context(), ref.NS, ref.Name, to)
			default:
				return exitErr(ExitUsage, "give a package and --to <namespace>, or --accept/--decline <transfer id>")
			}
			if err != nil {
				return a.requestError(err)
			}
			printTransfer(a, t)
			return nil
		},
	}
	cmd.Flags().StringVar(&to, "to", "", "the namespace to offer the package to")
	cmd.Flags().StringVar(&accept, "accept", "", "accept an offered transfer")
	cmd.Flags().StringVar(&decline, "decline", "", "decline an offered transfer")
	return cmd
}

// ---------- owners ----------

func (a *App) yankCmd() *cobra.Command {
	var undo bool
	cmd := &cobra.Command{
		Use:   "yank <namespace/name@version>",
		Short: "Hide a version from search and @latest (it stays installable by exact version)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := parseRef(args[0])
			if err != nil || ref.LocalPath != "" || ref.Version == "" {
				return exitErr(ExitUsage, "give a version as namespace/name@version")
			}
			if err := a.API.Yank(cmd.Context(), ref.NS, ref.Name, ref.Version, undo); err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"ref": ref.Ref(), "version": ref.Version, "yanked": !undo})
			}
			if undo {
				fmt.Fprintf(a.Out, "%s@%s is back in search and @latest.\n", ref.Ref(), ref.Version)
			} else {
				fmt.Fprintf(a.Out, "Yanked %s@%s. Installs by exact version still work; undo with `ot yank --undo`.\n", ref.Ref(), ref.Version)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&undo, "undo", false, "un-yank the version")
	return cmd
}

func (a *App) deprecateCmd() *cobra.Command {
	var message, replacement string
	var undo bool
	cmd := &cobra.Command{
		Use:   "deprecate <namespace/name> --message <text> [--replacement <namespace/name>]",
		Short: "Mark a package deprecated, shown in search and on install",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := parseRef(args[0])
			if err != nil || ref.LocalPath != "" {
				return exitErr(ExitUsage, "give a package as namespace/name")
			}
			if undo {
				err = a.API.Undeprecate(cmd.Context(), ref.NS, ref.Name)
			} else if message == "" {
				return exitErr(ExitUsage, "say why with --message")
			} else {
				err = a.API.Deprecate(cmd.Context(), ref.NS, ref.Name, message, replacement)
			}
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"ref": ref.Ref(), "deprecated": !undo})
			}
			fmt.Fprintf(a.Out, "%s is %s.\n", ref.Ref(), map[bool]string{true: "no longer deprecated", false: "deprecated"}[undo])
			return nil
		},
	}
	cmd.Flags().StringVar(&message, "message", "", "why, shown to users")
	cmd.Flags().StringVar(&replacement, "replacement", "", "the package to use instead")
	cmd.Flags().BoolVar(&undo, "undo", false, "remove the deprecation")
	return cmd
}

// isRemoved reports whether an API error says the package was removed.
func isRemoved(err error) (*api.Error, bool) {
	var ae *api.Error
	if errors.As(err, &ae) && ae.Code == "tool_removed" {
		return ae, true
	}
	return nil, false
}
