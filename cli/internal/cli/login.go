package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/keys"
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
	var gitlab, osintverse, printToken bool
	var scopes []string
	cmd := &cobra.Command{
		Use:   "login",
		Short: "Sign in with GitHub (or GitLab, or OSINTverse) to publish and manage packages",
		Long: "Signs in with a device code: open the link on any device and enter the code. The token is saved to the OS keychain.\n" +
			"With --json the link and code come first as one line of JSON and the result as a second. On a machine without a\n" +
			"keychain (CI, containers), use --print-token and pass the token in OTINSTALLER_TOKEN instead.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			if gitlab && osintverse {
				return exitErr(ExitUsage, "choose one of --gitlab and --osintverse")
			}
			if err := checkScopes(scopes); err != nil {
				return err
			}
			provider := "github"
			if gitlab {
				provider = "gitlab"
			} else if osintverse {
				provider = "osintverse"
			}
			ctx := cmd.Context()
			start, err := a.API.StartDeviceLogin(ctx, provider)
			if err != nil {
				return err
			}
			if a.jsonMode() {
				// One line each, so a caller can show the code before the sign-in finishes.
				b, _ := json.Marshal(map[string]any{"verification_uri": start.VerificationURI, "user_code": start.UserCode, "expires_in": start.ExpiresIn})
				fmt.Fprintln(a.Out, string(b))
			} else {
				fmt.Fprintf(a.Out, "Open %s and enter the code: %s\nWaiting for you to approve…\n", start.VerificationURI, start.UserCode)
			}
			interval := time.Duration(max(start.Interval, 1)) * time.Second
			deadline := time.Now().Add(time.Duration(max(start.ExpiresIn, 60)) * time.Second)
			host, _ := os.Hostname()
			for time.Now().Before(deadline) {
				if err := pollSleep(ctx, interval); err != nil {
					return err
				}
				res, err := a.API.PollDeviceLogin(ctx, provider, start.DeviceCode, "ot CLI on "+host, scopes...)
				if err != nil {
					return err
				}
				switch res.Status {
				case "ok":
					if !printToken {
						if err := keys.Set(TokenKey, res.Token); err != nil {
							return fmt.Errorf("signed in, but saving the token to the keychain failed: %w; on a machine without a keychain, run `ot login --print-token` and set OTINSTALLER_TOKEN", err)
						}
					}
					if a.jsonMode() {
						out := map[string]string{"login": res.Login, "provider": provider}
						if printToken {
							out["token"] = res.Token
						}
						b, _ := json.Marshal(out)
						fmt.Fprintln(a.Out, string(b))
						return nil
					}
					if printToken {
						fmt.Fprintln(a.Out, res.Token)
						fmt.Fprintf(a.Err, "Signed in as %s (%s). The token was not saved; keep it secret and pass it in OTINSTALLER_TOKEN.\n", res.Login, provider)
						return nil
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
	cmd.Flags().BoolVar(&osintverse, "osintverse", false, "sign in with an OSINTverse account (publish with `ot namespace create` and `ot publish`)")
	cmd.Flags().BoolVar(&printToken, "print-token", false, "print the token instead of saving it to the keychain")
	cmd.Flags().StringSliceVar(&scopes, "scope", nil, "limit the token to these scopes (read, publish, manage, feedback); default: all four")
	return cmd
}

func (a *App) logoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Forget the stored registry token",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			// A token from the environment was never stored, so a machine without a keychain has nothing to forget.
			if err := keys.Delete(TokenKey); err != nil && os.Getenv(TokenKey) == "" {
				return err
			}
			if os.Getenv(TokenKey) != "" {
				fmt.Fprintf(a.Err, "note: %s is set in the environment; unset it to sign out fully.\n", TokenKey)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]bool{"signed_out": true})
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
				return errNotSignedIn("not signed in; run `ot login`")
			}
			me, err := a.API.Me(cmd.Context())
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status == 401 {
				return errNotSignedIn("your token is no longer valid; run `ot login`")
			}
			if err != nil {
				return err
			}
			if a.jsonMode() {
				return writeJSON(a.Out, me)
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
