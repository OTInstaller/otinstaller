package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/selfupdate"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

func (a *App) selfUpdateCmd() *cobra.Command {
	var check bool
	cmd := &cobra.Command{
		Use:   "self-update",
		Short: "Update ot to the latest release (signature-checked)",
		Long:  "Downloads the latest ot release, checks it against the release key's signature, and replaces this binary.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			u := a.Updater
			if u == nil {
				var err error
				if u, err = selfupdate.New(); err != nil {
					return exitErr(ExitUsage, "%v", err)
				}
			}
			ctx := cmd.Context()
			r, err := u.Latest(ctx)
			if err != nil {
				return err
			}
			if Version != "dev" && !selfupdate.Newer(r.Tag, Version) {
				fmt.Fprintf(a.Out, "ot %s is the latest release.\n", Version)
				return nil
			}
			if check {
				fmt.Fprintf(a.Out, "ot %s is available (you have %s). Run `ot self-update` to install it.\n", r.Tag, Version)
				return nil
			}
			exe := a.SelfPath
			if exe == "" {
				if exe, err = os.Executable(); err != nil {
					return err
				}
				if exe, err = filepath.EvalSymlinks(exe); err != nil {
					return err
				}
			}
			bin, err := u.Download(ctx, r)
			if err != nil {
				return exitErr(ExitTrust, "update refused: %v", err)
			}
			if err := selfupdate.Replace(exe, bin); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "Updated ot from %s to %s.\n", Version, r.Tag)
			return nil
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "only say whether an update is available")
	return cmd
}

// ---------- newer ot ----------

// otLatestCache is <ot home>/cache/ot-latest.json: the newest ot release and when it was looked up.
type otLatestCache struct {
	CheckedAt time.Time `json:"checked_at"`
	Version   string    `json:"version"`
}

// latestOT returns the newest ot release, looked up at most once a day, or "" when unknown. Dev builds, `ot mcp`, CI
// and OT_NO_UPDATE_CHECK=1 never look. A failed lookup is not retried until the next day, so an offline machine
// doesn't wait on it every time.
func (a *App) latestOT(ctx context.Context) string {
	if Version == "dev" || a.AgentMode || os.Getenv("CI") != "" || os.Getenv("OT_NO_UPDATE_CHECK") == "1" {
		return ""
	}
	path := state.Path("cache", "ot-latest.json")
	var c otLatestCache
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	if time.Since(c.CheckedAt) < 24*time.Hour {
		return c.Version
	}
	u := a.Updater
	if u == nil {
		u = selfupdate.Checker()
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c.CheckedAt = time.Now()
	if r, err := u.Latest(ctx); err == nil {
		c.Version = r.Tag
	}
	if b, err := json.Marshal(c); err == nil {
		_ = os.MkdirAll(filepath.Dir(path), 0o755)
		_ = os.WriteFile(path, b, 0o644)
	}
	return c.Version
}

// noteNewerOT says on stderr when a newer ot than this one is out.
func (a *App) noteNewerOT(ctx context.Context) {
	if latest := a.latestOT(ctx); latest != "" && selfupdate.Newer(latest, Version) {
		fmt.Fprintf(a.Err, "note: ot %s is out (you have %s); `ot self-update` installs it\n", latest, Version)
	}
}
