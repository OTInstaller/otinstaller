package cli

import (
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/spf13/cobra"
)

// namespaceCmd manages namespaces on the registry. A registry namespace needs no GitHub or GitLab account behind it:
// `ot publish` releases into it directly. Any namespace can also trust repositories' CI to publish into it.
func (a *App) namespaceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "namespace",
		Short: "Create a namespace, and choose which repositories' CI may publish into it",
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
	cmd.AddCommand(create, a.namespaceTrustCmd(), a.namespaceTrustedCmd(), a.namespaceUntrustCmd())
	return cmd
}

// namespaceTrustCmd trusts a GitHub Actions workflow or GitLab CI pipeline to publish into a namespace with
// `ot publish --oidc`, without the GitHub App, a connected GitLab project or a stored token.
func (a *App) namespaceTrustCmd() *cobra.Command {
	var p api.TrustedPublisher
	cmd := &cobra.Command{
		Use:   "trust <namespace> <github:owner/repo | gitlab:group/project>",
		Short: "Let a repository's CI publish into a namespace (trusted publishing)",
		Long: "Trusts a repository's CI to publish into a namespace you own: a GitHub Actions workflow or a GitLab CI pipeline then\n" +
			"runs `ot publish --oidc`, which proves the repository with the job's OIDC ID token, so no token is stored in CI.\n" +
			"Narrow it with --workflow (the workflow file, or GitLab CI configuration path), --environment (the deployment\n" +
			"environment the job must run in; required for pull_request_target and merge-request pipelines) and --package.\n" +
			"The repository must be public. Its id is pinned the first time it publishes, so a repository deleted and created\n" +
			"again under the same name can't publish.",
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`")
			}
			provider, repo, ok := strings.Cut(args[1], ":")
			if !ok || (provider != "github" && provider != "gitlab") || repo == "" {
				return exitErr(ExitUsage, "name the repository as github:owner/repo or gitlab:group/project")
			}
			p.Provider, p.Repository = provider, repo
			out, err := a.API.AddTrustedPublisher(cmd.Context(), args[0], p)
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, out)
			}
			fmt.Fprintf(a.Out, "%s now trusts %s:%s%s (%s).\n", args[0], out.Provider, out.Repository, publisherLimits(out), out.ID)
			if out.Provider == "github" {
				fmt.Fprintln(a.Out, "In the workflow, give the job `permissions: id-token: write` and run `ot publish --oidc`.")
				fmt.Fprintln(a.Out, "The release workflow from `ot init` does this when the repository variable OTINSTALLER_PUBLISH is oidc.")
			} else {
				fmt.Fprintln(a.Out, "In .gitlab-ci.yml, give the job `id_tokens: {OTINSTALLER_ID_TOKEN: {aud: otinstaller}}` and run `ot publish --oidc`.")
				fmt.Fprintln(a.Out, "The release pipeline from `ot init` does this when the CI/CD variable OTINSTALLER_PUBLISH is oidc.")
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&p.Workflow, "workflow", "", "only this workflow file (release.yml) or GitLab CI configuration path (.gitlab-ci.yml)")
	cmd.Flags().StringVar(&p.Environment, "environment", "", "only jobs in this deployment environment")
	cmd.Flags().StringVar(&p.Package, "package", "", "only this package in the namespace")
	return cmd
}

// publisherLimits describes what narrows a trusted publisher, for one line of output.
func publisherLimits(p *api.TrustedPublisher) string {
	var parts []string
	if p.Workflow != "" {
		parts = append(parts, "workflow "+p.Workflow)
	}
	if p.Environment != "" {
		parts = append(parts, "environment "+p.Environment)
	}
	if p.Package != "" {
		parts = append(parts, "package "+p.Package)
	}
	if len(parts) == 0 {
		return ""
	}
	return " (" + strings.Join(parts, ", ") + ")"
}

func (a *App) namespaceTrustedCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "trusted <namespace>",
		Short: "List the CI publishers a namespace trusts",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`")
			}
			list, err := a.API.TrustedPublishers(cmd.Context(), args[0])
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"namespace": args[0], "publishers": list})
			}
			if len(list) == 0 {
				fmt.Fprintf(a.Out, "%s trusts no CI publishers. Add one with `ot namespace trust %s github:owner/repo`.\n", args[0], args[0])
				return nil
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tREPOSITORY\tWORKFLOW\tENVIRONMENT\tPACKAGE\tLAST USED")
			for _, p := range list {
				used := "never"
				if p.LastUsedAt != nil {
					used = time.UnixMilli(*p.LastUsedAt).UTC().Format("2006-01-02")
				}
				fmt.Fprintf(tw, "%s\t%s:%s\t%s\t%s\t%s\t%s\n", p.ID, p.Provider, p.Repository, orAny(p.Workflow), orAny(p.Environment), orAny(p.Package), used)
			}
			return tw.Flush()
		},
	}
}

func orAny(s string) string {
	if s == "" {
		return "any"
	}
	return s
}

func (a *App) namespaceUntrustCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "untrust <namespace> <id>",
		Short: "Stop trusting a CI publisher; tokens its runs hold stop working at once",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`")
			}
			if err := a.API.RemoveTrustedPublisher(cmd.Context(), args[0], args[1]); err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"namespace": args[0], "removed": args[1]})
			}
			fmt.Fprintf(a.Out, "%s no longer trusts publisher %s.\n", args[0], args[1])
			return nil
		},
	}
}
