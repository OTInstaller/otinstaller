package cli

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"
)

// syncCmd checks a package's source repository now, instead of waiting for the next webhook or the
// 6-hourly poll. The registry allows 10 manual syncs per package per hour.
func (a *App) syncCmd() *cobra.Command {
	var showLog, asJSON bool
	cmd := &cobra.Command{
		Use:   "sync <namespace/name>",
		Short: "Check a package's GitHub or GitLab repository for new tags and changes now",
		Long: "Asks the registry to check your package's source repository right away: new vX.Y.Z tags are queued for publishing,\n" +
			"and renames, archiving and README changes are picked up. With --log it shows the sync status and the last 50 events instead.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := parseRef(args[0])
			if err != nil {
				return err
			}
			if ref.LocalPath != "" || ref.Version != "" {
				return exitErr(ExitUsage, "give a package as namespace/name")
			}
			if a.API.Token == "" {
				return exitErr(ExitUsage, "sign in first with `ot login`")
			}
			ctx := cmd.Context()
			if showLog {
				log, err := a.API.SyncLog(ctx, ref.NS, ref.Name)
				if err != nil {
					return a.importError(err)
				}
				if asJSON {
					return writeJSON(a.Out, log)
				}
				s := log.Source
				fmt.Fprintf(a.Out, "%s from %s (%s)\nSync:      %s\n", ref.Ref(), s.URL, s.Provider, s.SyncStatus)
				if s.LastError != "" {
					fmt.Fprintf(a.Out, "Error:     %s\n", s.LastError)
				}
				fmt.Fprintf(a.Out, "Last event: %s\nLast poll:  %s\n", when(s.LastEventAt), when(s.LastPollAt))
				if s.ManifestMode == "registry" {
					fmt.Fprintln(a.Out, "Manifest:  held by the registry")
				}
				if len(log.Events) > 0 {
					fmt.Fprintln(a.Out, "\nRecent events:")
				}
				for _, e := range log.Events {
					line := e.Summary
					if e.Error != "" {
						line += ": " + e.Error
					}
					fmt.Fprintf(a.Out, "  %s  %-7s  %-6s  %s\n", when(e.ReceivedAt), e.Kind, e.Status, line)
				}
				return nil
			}
			res, err := a.API.Sync(ctx, ref.NS, ref.Name)
			if err != nil {
				return a.importError(err)
			}
			if asJSON {
				return writeJSON(a.Out, res)
			}
			switch res.Status {
			case "ok", "archived", "unarchived":
				if len(res.Queued) > 0 {
					fmt.Fprintf(a.Out, "Synced %s. Publishing %d new tag(s): %v\n", ref.Ref(), len(res.Queued), res.Queued)
				} else {
					fmt.Fprintf(a.Out, "Synced %s. No new release tags.\n", ref.Ref())
				}
				if res.Status == "archived" {
					fmt.Fprintln(a.Out, "The repository is archived, so the package is now marked deprecated.")
				}
			case "unavailable":
				return exitErr(ExitToolError, "the source repository of %s is gone or no longer public; the package is hidden from search until it is restored", ref.Ref())
			case "transfer_pending":
				return exitErr(ExitToolError, "the source repository of %s moved to another owner, who has to confirm the transfer", ref.Ref())
			default:
				return exitErr(ExitToolError, "sync %s for %s; see `ot sync --log %s`", res.Status, ref.Ref(), ref.Ref())
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&showLog, "log", false, "show the sync status and recent events instead of syncing")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

// when formats a Unix-millisecond timestamp, or "never".
func when(ms int64) string {
	if ms == 0 {
		return "never"
	}
	return time.UnixMilli(ms).UTC().Format("2006-01-02 15:04 UTC")
}
