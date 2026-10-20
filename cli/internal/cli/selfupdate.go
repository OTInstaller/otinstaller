package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/selfupdate"
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
