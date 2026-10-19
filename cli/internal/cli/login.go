package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/osintverse/otinstaller/cli/internal/api"
	"github.com/osintverse/otinstaller/cli/internal/keys"
)

// TokenKey is the keychain entry that holds the registry API token.
const TokenKey = "OTINSTALLER_TOKEN"

// pollSleep is replaced in tests so device-flow polling does not wait.
var pollSleep = func(ctx context.Context, d time.Duration) error {
	select {
	case <-time.After(d):
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *App) loginCmd() *cobra.Command {
	var gitlab bool
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Sign in with GitHub (or GitLab) to star tools and publish",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			provider := "github"
			if gitlab {
				provider = "gitlab"
			}
			ctx := cmd.Context()
			start, err := a.API.StartDeviceLogin(ctx, provider)
			if err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "Open %s and enter the code: %s\nWaiting for you to approve…\n", start.VerificationURI, start.UserCode)
			interval := time.Duration(max(start.Interval, 1)) * time.Second
			deadline := time.Now().Add(time.Duration(max(start.ExpiresIn, 60)) * time.Second)
			host, _ := os.Hostname()
			for time.Now().Before(deadline) {
				if err := pollSleep(ctx, interval); err != nil {
					return err
				}
				res, err := a.API.PollDeviceLogin(ctx, provider, start.DeviceCode, "ot CLI on "+host)
				if err != nil {
					return err
				}
				switch res.Status {
				case "ok":
					if err := keys.Set(TokenKey, res.Token); err != nil {
						return fmt.Errorf("signed in, but saving the token to the keychain failed: %w", err)
					}
					fmt.Fprintf(a.Out, "Signed in as %s (%s).\n", res.Login, provider)
					return nil
				case "slow_down":
					interval += 5 * time.Second
				case "expired":
					return exitErr(ExitUsage, "the code expired; run `ot login` again")
				case "denied":
					return exitErr(ExitUsage, "sign-in was cancelled")
				}
			}
			return exitErr(ExitUsage, "the code expired; run `ot login` again")
		},
	}
	cmd.Flags().BoolVar(&gitlab, "gitlab", false, "sign in with GitLab instead of GitHub")
	return cmd
}

func (a *App) logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Forget the stored registry token",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := keys.Delete(TokenKey); err != nil {
				return err
			}
			fmt.Fprintln(a.Out, "Signed out. Revoke the token on otinstaller.com if this machine is not yours.")
			return nil
		},
	}
}

func (a *App) whoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show who you are signed in as",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return exitErr(ExitUsage, "not signed in; run `ot login`")
			}
			me, err := a.API.Me(cmd.Context())
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status == 401 {
				return exitErr(ExitUsage, "your token is no longer valid; run `ot login`")
			}
			if err != nil {
				return err
			}
			var accts []string
			for _, ac := range me.Accounts {
				accts = append(accts, ac.Provider+":"+ac.Login)
			}
			fmt.Fprintf(a.Out, "%s (%s)\n", me.Login, strings.Join(accts, ", "))
			for _, n := range me.Namespaces {
				fmt.Fprintf(a.Out, "  namespace %s: %s, %s\n", n.Name, n.Role, strings.ReplaceAll(n.Status, "_", " "))
			}
			return nil
		},
	}
}
