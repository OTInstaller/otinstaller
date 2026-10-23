package cli

import (
	"fmt"

	"github.com/spf13/cobra"
)

// namespaceCmd manages namespaces on the registry. A registry namespace needs no GitHub or GitLab account behind it:
// `ot publish` releases into it directly.
func (a *App) namespaceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "namespace",
		Short: "Create a namespace to publish into without GitHub or GitLab",
	}
	var org bool
	create := &cobra.Command{
		Use:   "create <name>",
		Short: "Create a registry namespace you own",
		Long: "Creates a namespace on the registry, owned by you, to publish into with `ot publish`. Like every new publisher it\n" +
			"waits for a reviewer, who looks at its first release. Names are 3-40 lowercase letters, digits and hyphens. A name\n" +
			"that is a GitHub or GitLab user needs that account linked to yours; organisations and groups get their namespace by\n" +
			"installing the GitHub App or connecting a GitLab project instead. You can create at most three.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`")
			}
			kind := "user"
			if org {
				kind = "org"
			}
			ns, err := a.API.CreateNamespace(cmd.Context(), args[0], kind)
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, ns)
			}
			fmt.Fprintf(a.Out, "Created the namespace %s (waiting for review).\n", ns.Name)
			fmt.Fprintf(a.Out, "Set `namespace: %s` in otinstaller.yaml and run `ot publish`; a reviewer looks at its first release before it goes public.\n", ns.Name)
			return nil
		},
	}
	create.Flags().BoolVar(&org, "org", false, "the namespace is an organisation's, not a person's")
	cmd.AddCommand(create)
	return cmd
}
