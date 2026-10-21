package cli

import (
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
)

// tokenScopes are the scopes a token can be created with from the command line; staff tokens are made on the website.
var tokenScopes = []string{"read", "publish", "manage", "feedback"}

func checkScopes(scopes []string) error {
	for _, s := range scopes {
		ok := false
		for _, v := range tokenScopes {
			ok = ok || s == v
		}
		if !ok {
			return exitErr(ExitUsage, "unknown scope %q; scopes are %s", s, strings.Join(tokenScopes, ", "))
		}
	}
	return nil
}

func (a *App) tokenCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "token",
		Short: "Create, list and revoke registry API tokens",
		Long: "API tokens let scripts, CI and agents use your account without your keychain. Each token has scopes:\n" +
			"  read      your account, tokens and publish history\n" +
			"  publish   imports, manifest edits, syncs and sources\n" +
			"  manage    yanks, deprecations, claims, transfers, backup settings and tokens\n" +
			"  feedback  reports and feedback\n" +
			"Reading the registry needs no token at all. Pass a token in OTINSTALLER_TOKEN.",
	}
	var scopes []string
	var days int
	create := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a token; it is printed once",
		Example: "  ot token create ci-publish --scope publish --expires 30\n" +
			"  ot token create agent-readonly --scope read",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`")
			}
			if err := checkScopes(scopes); err != nil {
				return err
			}
			t, err := a.API.CreateToken(cmd.Context(), args[0], scopes, days)
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, t)
			}
			fmt.Fprintln(a.Out, t.Token)
			when := "never"
			if t.ExpiresAt != nil {
				when = time.UnixMilli(*t.ExpiresAt).Format("2006-01-02")
			}
			fmt.Fprintf(a.Err, "Token %s (scopes: %s; expires: %s). It is shown once; keep it secret and pass it in OTINSTALLER_TOKEN.\n",
				t.ID, strings.Join(t.Scopes, ", "), when)
			return nil
		},
	}
	create.Flags().StringSliceVar(&scopes, "scope", nil, "a scope it gets (repeat, or comma-separate); default: read, publish, manage, feedback")
	create.Flags().IntVar(&days, "expires", 0, "days until it expires, 1 to 365 (default 90)")
	cmd.AddCommand(create,
		&cobra.Command{
			Use:   "list",
			Short: "List your tokens (never their values)",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, args []string) error {
				if a.API.Token == "" {
					return errNotSignedIn("sign in first with `ot login`")
				}
				ts, err := a.API.Tokens(cmd.Context())
				if err != nil {
					return a.requestError(err)
				}
				if a.jsonMode() {
					return writeJSON(a.Out, ts)
				}
				day := func(ms *int64, none string) string {
					if ms == nil {
						return none
					}
					return time.UnixMilli(*ms).Format("2006-01-02")
				}
				tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
				fmt.Fprintln(tw, "ID\tNAME\tSCOPES\tEXPIRES\tLAST USED")
				for _, t := range ts {
					name := t.Name
					if t.Current {
						name += " (this one)"
					}
					sc := strings.Join(t.Scopes, ",")
					if !t.Scoped {
						sc = "all (older token)"
					}
					fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", t.ID, name, sc, day(t.ExpiresAt, "never"), day(t.LastUsedAt, "-"))
				}
				return tw.Flush()
			},
		},
		&cobra.Command{
			Use:   "revoke <id>",
			Short: "Revoke a token",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				if a.API.Token == "" {
					return errNotSignedIn("sign in first with `ot login`")
				}
				if err := a.API.RevokeToken(cmd.Context(), args[0]); err != nil {
					return a.requestError(err)
				}
				if a.jsonMode() {
					return writeJSON(a.Out, map[string]any{"id": args[0], "revoked": true})
				}
				fmt.Fprintf(a.Out, "Revoked %s.\n", args[0])
				return nil
			},
		},
	)
	return cmd
}
