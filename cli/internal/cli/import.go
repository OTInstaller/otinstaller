package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

// importCmd runs the import wizard: the registry detects what a repository contains and drafts its
// manifest, ot asks for what it could not detect, then opens a pull/merge request or keeps the manifest
// on the registry.
func (a *App) importCmd() *cobra.Command {
	var id, file, save, wrapper, dockerfile string
	var request int
	var registry, draftOnly, yes, list, community bool
	cmd := &cobra.Command{
		Use:   "import <github-or-gitlab-url>...",
		Short: "Publish an existing GitHub or GitLab repository: detect, complete, open a PR/MR",
		Long: "Runs the import wizard for a repository you administer (GitHub) or maintain (GitLab). The registry drafts\n" +
			"otinstaller.yaml from the repository, ot asks for what it could not detect, and then opens a pull or merge\n" +
			"request adding the manifest and a release workflow. With --registry the manifest stays on the registry instead\n" +
			"(repository owners only). Several URLs start a bulk import of up to 50 repositories.\n\n" +
			"Anyone can package an open-source tool they don't maintain with --community. It finishes as a submission: the\n" +
			"registry creates osintverse-community/<name> with the manifest (and, when upstream publishes no image, the\n" +
			"--dockerfile you give and the release workflow), starts its release, and a community reviewer approves the first\n" +
			"one. --request links the tool request it answers. The package is labelled Community-packaged and credits the\n" +
			"upstream project. osintverse-community admins can instead open a pull request in a wrapper repository (--wrapper).",
		Example: "  ot import https://github.com/alice/whois-plus\n  ot import --id 01J... --file otinstaller.yaml\n  ot import --list\n" +
			"  ot import --community https://github.com/sherlock-project/sherlock --dockerfile Dockerfile --request 12\n" +
			"  ot import --community https://github.com/sherlock-project/sherlock --wrapper https://github.com/osintverse-community/sherlock",
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login` (or `ot login --gitlab`)")
			}
			switch {
			case list:
				return a.listImports(ctx)
			case id == "" && len(args) == 0:
				return exitErr(ExitUsage, "give a repository URL, or --id to continue an import")
			case id == "" && len(args) > 1:
				return a.bulkImport(ctx, args, community)
			}
			var imp *api.Import
			var err error
			if id != "" {
				imp, err = a.API.Import(ctx, id)
			} else {
				fmt.Fprintf(a.Err, "Looking at %s…\n", args[0])
				if community {
					imp, err = a.API.StartCommunityImport(ctx, args[0])
				} else {
					imp, err = a.API.StartImport(ctx, args[0])
				}
			}
			if err != nil {
				return a.requestError(err)
			}
			return a.runWizard(ctx, imp, wizardOptions{file: file, save: save, wrapper: wrapper, dockerfile: dockerfile, request: request, registry: registry, draftOnly: draftOnly, yes: yes, asJSON: a.jsonMode()})
		},
	}
	f := cmd.Flags()
	f.StringVar(&id, "id", "", "continue an earlier import")
	f.StringVar(&file, "file", "", "use this manifest file as the draft")
	f.StringVar(&save, "save", "", "write the draft manifest to this file")
	f.BoolVar(&registry, "registry", false, "keep the manifest on the registry instead of opening a pull/merge request")
	f.BoolVar(&community, "community", false, "package an open-source tool you don't own as a community wrapper (finishes as a reviewed submission)")
	f.StringVar(&dockerfile, "dockerfile", "", "the Dockerfile a community wrapper builds when upstream publishes no image")
	f.IntVar(&request, "request", 0, "the tool request a community submission answers")
	f.StringVar(&wrapper, "wrapper", "", "osintverse-community admins: open a pull/merge request in this wrapper repository instead of submitting")
	f.BoolVar(&draftOnly, "draft", false, "stop after saving the draft; finish later with --id")
	f.BoolVarP(&yes, "yes", "y", false, "do not prompt; fail if the draft still needs input")
	f.BoolVar(&list, "list", false, "list your imports")
	return cmd
}

type wizardOptions struct {
	file, save, wrapper, dockerfile  string
	request                          int
	registry, draftOnly, yes, asJSON bool
}

func (a *App) runWizard(ctx context.Context, imp *api.Import, o wizardOptions) error {
	var err error
	switch imp.Status {
	case "detecting":
		return exitErr(ExitToolError, "%s is still being detected; try again in a moment", imp.Repo)
	case "failed":
		msg := "detection failed"
		if imp.Error != nil {
			msg = imp.Error.Message
		}
		return exitErr(ExitToolError, "%s: %s", imp.Repo, msg)
	case "finished":
		a.printFinished(imp)
		return nil
	}
	if !o.asJSON {
		a.printDetection(imp)
	}
	ask := a.prompter(o.yes)

	if o.file != "" {
		text, err := os.ReadFile(o.file)
		if err != nil {
			return err
		}
		if imp, err = a.API.EditImport(ctx, imp.ID, map[string]any{"yaml": string(text)}); err != nil {
			return a.requestError(err)
		}
	}
	if slices.Contains(imp.Missing, "kind") {
		if o.yes {
			return exitErr(ExitUsage, "could not tell what %s is; run without --yes to choose docker, pipx or guide", imp.Repo)
		}
		kind, err := ask("What is it? (docker, pipx, guide)", "", "")
		if err != nil {
			return err
		}
		if imp, err = a.API.EditImport(ctx, imp.ID, map[string]any{"kind": strings.TrimSpace(kind)}); err != nil {
			return a.requestError(err)
		}
	}
	if len(imp.Missing) > 0 || len(imp.Suggested) > 0 {
		if o.yes && len(imp.Missing) > 0 {
			return exitErr(ExitUsage, "the draft still needs: %s (complete it with --file, or run without --yes)", strings.Join(imp.Missing, ", "))
		}
		if !o.yes {
			change, err := a.completeDraft(imp, ask)
			if err != nil {
				return err
			}
			if len(change) > 0 {
				if imp, err = a.API.EditImport(ctx, imp.ID, map[string]any{"manifest": change}); err != nil {
					return a.requestError(err)
				}
			}
		}
	}
	if o.save != "" {
		if err := os.WriteFile(o.save, []byte(imp.DraftYAML), 0o644); err != nil {
			return err
		}
		fmt.Fprintf(a.Err, "Saved the draft to %s\n", o.save)
	}
	if len(imp.Problems) > 0 {
		if o.asJSON {
			return writeJSON(a.Out, imp)
		}
		printProblems(a.Out, imp.Problems)
		fmt.Fprintf(a.Out, "\nFix the draft and continue with: ot import --id %s --file otinstaller.yaml (--save writes the draft to a file)\n", imp.ID)
		return &ExitError{Code: ExitUsage}
	}
	if o.draftOnly {
		if o.asJSON {
			return writeJSON(a.Out, imp)
		}
		fmt.Fprintf(a.Out, "Draft saved. Finish it with: ot import --id %s\n", imp.ID)
		return nil
	}

	if imp.Community {
		if o.wrapper != "" {
			return a.finishWrapper(ctx, imp, o, ask)
		}
		return a.finishSubmission(ctx, imp, o)
	}
	mode := "pr"
	switch {
	case imp.ExistingManifest:
		mode = "connect"
	case o.registry:
		mode = "registry"
	case !o.yes && slices.Contains(imp.FinishModes, "registry"):
		fmt.Fprintln(a.Out, "\nHow should the import finish?\n  pr        open a pull/merge request with otinstaller.yaml and a release workflow (recommended)\n  registry  keep the manifest on the registry; the package is labelled and ranks a little lower")
		if mode, err = ask("Finish with", "", "pr"); err != nil {
			return err
		}
		if mode != "pr" && mode != "registry" {
			return exitErr(ExitUsage, "answer pr or registry")
		}
	}
	if imp, err = a.API.FinishImport(ctx, imp.ID, mode); err != nil {
		return a.requestError(err)
	}
	if o.asJSON {
		return writeJSON(a.Out, imp)
	}
	a.printFinished(imp)
	return nil
}

var inputName = regexp.MustCompile(`[^a-z0-9_]+`)

// completeDraft asks for what detection could not find and returns the top-level manifest keys to set.
func (a *App) completeDraft(imp *api.Import, ask func(label, current, def string) (string, error)) (map[string]any, error) {
	change := map[string]any{}
	d := imp.Draft
	fmt.Fprintln(a.Out, "\nA few things the repository doesn't say:")
	for _, field := range append(append([]string{}, imp.Missing...), imp.Suggested...) {
		switch field {
		case "summary":
			v, err := ask("One-line summary (10-140 characters)", "", "")
			if err != nil {
				return nil, err
			}
			change["summary"] = v
		case "license":
			v, err := ask("License (SPDX id)", "", "MIT")
			if err != nil {
				return nil, err
			}
			change["license"] = v
		case "readme":
			v, err := ask("README file", "", "README.md")
			if err != nil {
				return nil, err
			}
			change["readme"] = v
		case "inputs":
			typ, err := ask("Main input type (email, username, phone, domain, ip, url, name, ...)", "", "domain")
			if err != nil {
				return nil, err
			}
			name, err := ask("Input name, used as {name} in the command", "", strings.Trim(inputName.ReplaceAllString(strings.ToLower(typ), "_"), "_"))
			if err != nil {
				return nil, err
			}
			change["inputs"] = []map[string]any{{"name": name, "type": typ, "required": true}}
		case "outputs":
			v, err := ask("What it finds, as entity types (comma-separated: account, email, domain, ip, person, ...)", "", "other")
			if err != nil {
				return nil, err
			}
			var outs []map[string]any
			for _, t := range strings.Split(v, ",") {
				if t = strings.TrimSpace(t); t != "" {
					outs = append(outs, map[string]any{"type": t})
				}
			}
			change["outputs"] = outs
		case "command":
			runtime, _ := d["runtime"].(map[string]any)
			def := firstInput(change, d)
			if entry, _ := runtime["entrypoint"].(string); entry != "" {
				def = entry + " " + def
			} else if name, _ := d["name"].(string); name != "" {
				def = name + " " + def
			}
			v, err := ask("Command inside the container or package ({input} is replaced by the input)", "", def)
			if err != nil {
				return nil, err
			}
			rt := map[string]any{}
			for k, val := range runtime {
				rt[k] = val
			}
			rt["command"] = strings.Fields(v)
			change["runtime"] = rt
		case "ethics":
			touches, err := a.yesNo(ask, "Does it contact the target directly (not just public sources)?", false)
			if err != nil {
				return nil, err
			}
			auth, err := a.yesNo(ask, "Does it log in to accounts?", false)
			if err != nil {
				return nil, err
			}
			personal, err := a.yesNo(ask, "Does it collect personal data?", true)
			if err != nil {
				return nil, err
			}
			change["ethics"] = map[string]any{"touches_target": touches, "auth_required": auth, "collects_personal_data": personal}
		case "test":
			name := strings.Trim(firstInput(change, d), "{}")
			v, err := ask(fmt.Sprintf("A safe test value for %s, for smoke tests (Enter to skip)", name), "", "-")
			if err != nil {
				return nil, err
			}
			if v != "-" {
				change["test"] = map[string]any{"input": map[string]any{name: v}}
			}
		case "related_tools":
			v, err := ask("Registry tools this guide uses (namespace/name, comma-separated; Enter for none)", "", "-")
			if err != nil {
				return nil, err
			}
			if v != "-" {
				var tools []string
				for _, t := range strings.Split(v, ",") {
					if t = strings.TrimSpace(t); t != "" {
						tools = append(tools, t)
					}
				}
				change["related_tools"] = tools
			}
		case "content":
			fmt.Fprintln(a.Out, "  The guide's pages were not found. Add content.root and content.nav to the draft and pass it with --file.")
		}
	}
	return change, nil
}

// firstInput is "{name}" of the first input, from this session's answers or the draft.
func firstInput(change, draft map[string]any) string {
	for _, src := range []map[string]any{change, draft} {
		switch ins := src["inputs"].(type) {
		case []map[string]any:
			if len(ins) > 0 {
				return fmt.Sprintf("{%v}", ins[0]["name"])
			}
		case []any:
			if len(ins) > 0 {
				if m, ok := ins[0].(map[string]any); ok {
					return fmt.Sprintf("{%v}", m["name"])
				}
			}
		}
	}
	return "{target}"
}

func (a *App) yesNo(ask func(label, current, def string) (string, error), q string, def bool) (bool, error) {
	d := "n"
	if def {
		d = "y"
	}
	v, err := ask(q+" (y/n)", "", d)
	if err != nil {
		return false, err
	}
	return strings.HasPrefix(strings.ToLower(strings.TrimSpace(v)), "y"), nil
}

func (a *App) printDetection(imp *api.Import) {
	kind := imp.DetectedKind
	if kind == "" {
		kind = "unknown"
	} else if kind != "guide" {
		kind += " tool"
	}
	fmt.Fprintf(a.Out, "%s %s → %s/%v (%s", imp.Provider, imp.Repo, imp.Namespace, imp.Draft["name"], kind)
	if len(imp.Signals) > 0 {
		fmt.Fprintf(a.Out, ", from %s", strings.Join(imp.Signals, ", "))
	}
	fmt.Fprintln(a.Out, ")")
	for _, s := range imp.Assumed {
		fmt.Fprintf(a.Out, "  note: %s\n", s)
	}
	for _, w := range imp.Warnings {
		fmt.Fprintf(a.Out, "  warning: %s\n", w)
	}
}

// buildsImage reports whether a community draft builds its own image (upstream publishes none: a placeholder digest).
func buildsImage(draft map[string]any) bool {
	rt, _ := draft["runtime"].(map[string]any)
	image, _ := rt["image"].(string)
	return rt["kind"] == "docker" && strings.HasSuffix(image, "@sha256:"+strings.Repeat("0", 64))
}

// finishSubmission finishes a community import as a submission: the registry's community bot creates the wrapper
// repository and starts its release, and a community reviewer approves the first one.
func (a *App) finishSubmission(ctx context.Context, imp *api.Import, o wizardOptions) error {
	var dockerfile string
	if o.dockerfile != "" {
		b, err := os.ReadFile(o.dockerfile)
		if err != nil {
			return exitErr(ExitUsage, "reading the Dockerfile: %v", err)
		}
		dockerfile = string(b)
	} else if buildsImage(imp.Draft) {
		return &ExitError{Code: ExitUsage, Reason: "dockerfile_required",
			Err:  fmt.Errorf("%s publishes no image, so the wrapper builds one from a Dockerfile", imp.Repo),
			Hint: fmt.Sprintf("write one and run `ot import --id %s --dockerfile Dockerfile` (templates: https://otinstaller.com/docs/community#submissions)", imp.ID)}
	}
	done, err := a.API.FinishSubmission(ctx, imp.ID, dockerfile, o.request)
	if err != nil {
		return a.requestError(err)
	}
	if o.asJSON {
		return writeJSON(a.Out, done)
	}
	if s := done.Submission; s != nil {
		fmt.Fprintf(a.Out, "\nSubmitted as #%d: %s\n", s.Number, s.URL)
		if s.Status == "releasing" {
			fmt.Fprintln(a.Out, "The release is on its way. Once its scans pass, a community reviewer looks at it; you get updates in your inbox.")
		} else {
			fmt.Fprintln(a.Out, "The Dockerfile doesn't follow the template, so a reviewer starts the build after reading it.")
		}
	}
	return nil
}

// finishWrapper opens a community import's pull/merge request in its wrapper repository.
func (a *App) finishWrapper(ctx context.Context, imp *api.Import, o wizardOptions, ask func(label, current, def string) (string, error)) error {
	name, _ := imp.Draft["name"].(string)
	repo, err := ask("Wrapper repository in osintverse-community", o.wrapper, fmt.Sprintf("https://%s.com/osintverse-community/%s", imp.Provider, name))
	if err != nil {
		return err
	}
	if imp, err = a.API.FinishWrapper(ctx, imp.ID, repo); err != nil {
		return a.requestError(err)
	}
	if o.asJSON {
		return writeJSON(a.Out, imp)
	}
	a.printFinished(imp)
	return nil
}

func (a *App) printFinished(imp *api.Import) {
	switch imp.FinishMode {
	case "wrapper":
		fmt.Fprintf(a.Out, "\nOpened %s\nMerge it, then push a vX.Y.Z tag in the wrapper repository to publish the community package.\n", imp.PRURL)
	case "pr":
		fmt.Fprintf(a.Out, "\nOpened %s\nMerge it, then run the release workflow it adds (or push a tag for a guide) to publish.\n", imp.PRURL)
	case "registry":
		fmt.Fprintln(a.Out, "\nThe manifest is kept on the registry; new vX.Y.Z tags publish new versions.")
		if imp.QueuedTag != "" {
			fmt.Fprintf(a.Out, "Publishing %s now.\n", imp.QueuedTag)
		}
	case "connect":
		fmt.Fprintln(a.Out, "\nConnected. Push a vX.Y.Z tag to publish.")
	}
	if imp.Package != nil {
		fmt.Fprintf(a.Out, "Package: %s\n", imp.Package.Ref)
	}
}

func printProblems(w io.Writer, ps []api.Problem) {
	fmt.Fprintf(w, "\nThe draft has %d problem(s):\n", len(ps))
	for _, p := range ps {
		loc := ""
		if p.Path != "" {
			loc = " at " + p.Path
		}
		fmt.Fprintf(w, "  %s%s: %s\n", p.Code, loc, p.Message)
		if p.Hint != "" {
			fmt.Fprintf(w, "    hint: %s\n", p.Hint)
		}
	}
}

// requestError turns registry refusals (4xx) into usage errors, printing a draft's problems when there are any.
func (a *App) requestError(err error) error {
	var e *api.Error
	if errors.As(err, &e) && len(e.Problems) > 0 {
		// Stdout is for data; in JSON mode the problems are in the error itself.
		if !a.jsonMode() {
			printProblems(a.Err, e.Problems)
		}
		return &ExitError{Code: ExitUsage, Err: err}
	}
	if errors.As(err, &e) && e.Status >= 400 && e.Status < 500 {
		return &ExitError{Code: ExitUsage, Err: err}
	}
	return err
}

func (a *App) bulkImport(ctx context.Context, repos []string, community bool) error {
	b, err := a.API.StartImports(ctx, repos, community)
	if err != nil {
		return a.requestError(err)
	}
	if a.jsonMode() {
		return writeJSON(a.Out, b)
	}
	fmt.Fprintf(a.Out, "Importing %d repositories; detection runs in the background.\n", len(b.Imports))
	for _, imp := range b.Imports {
		fmt.Fprintf(a.Out, "  %s  %s\n", imp.ID, imp.Repo)
	}
	fmt.Fprintln(a.Out, "\nCheck progress with `ot import --list`, then finish each with `ot import --id <id>`.")
	return nil
}

func (a *App) listImports(ctx context.Context) error {
	imps, err := a.API.Imports(ctx)
	if err != nil {
		return a.requestError(err)
	}
	if a.jsonMode() {
		return writeJSON(a.Out, imps)
	}
	if len(imps) == 0 {
		fmt.Fprintln(a.Out, "No imports yet. Start one with `ot import <repository-url>`.")
		return nil
	}
	for _, imp := range imps {
		detail := imp.DetectedKind
		switch {
		case imp.Status == "failed" && imp.Error != nil:
			detail = imp.Error.Message
		case imp.Status == "finished" && imp.PRURL != "":
			detail = imp.PRURL
		case len(imp.Missing) > 0:
			detail = strings.TrimSpace(detail + " needs " + strings.Join(imp.Missing, ", "))
		}
		fmt.Fprintf(a.Out, "%s  %-9s  %-40s  %s\n", imp.ID, imp.Status, truncate(imp.Provider+":"+imp.Repo, 40), detail)
	}
	return nil
}
