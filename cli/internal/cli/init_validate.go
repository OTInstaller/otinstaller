package cli

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/scaffold"
)

func (a *App) initCmd() *cobra.Command {
	var p scaffold.Params
	var guide, yes, force bool
	cmd := &cobra.Command{
		Use:   "init [dir]",
		Short: "Create otinstaller.yaml and a release workflow in a repository",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := "."
			if len(args) == 1 {
				dir = args[0]
			}
			abs, _ := filepath.Abs(dir)
			if guide {
				p.Kind = "guide"
			}
			host, owner, repo := scaffold.GitRemote(dir)
			defaults := map[string]string{
				"kind":      orDefault(scaffold.Detect(dir), "docker"),
				"name":      scaffold.Slug(orDefault(repo, filepath.Base(abs))),
				"namespace": scaffold.Slug(owner),
				"license":   "MIT",
				"category":  "utilities",
				"input":     "domain",
			}
			if host != "" {
				p.Host = host
				p.Repo = host + ".com/" + owner + "/" + repo
			}
			ask := a.prompter(yes)
			var err error
			if p.Kind, err = ask("Kind (docker, pipx, guide)", p.Kind, defaults["kind"]); err != nil {
				return err
			}
			if p.Kind != "docker" && p.Kind != "pipx" && p.Kind != "guide" {
				return exitErr(ExitUsage, "kind must be docker, pipx or guide")
			}
			if p.Name, err = ask("Package name", p.Name, defaults["name"]); err != nil {
				return err
			}
			if p.Namespace, err = ask("Namespace (your GitHub/GitLab user or org)", p.Namespace, defaults["namespace"]); err != nil {
				return err
			}
			if p.Summary, err = ask("One-line summary (10-140 characters)", p.Summary, ""); err != nil {
				return err
			}
			if p.License, err = ask("License (SPDX id)", p.License, defaults["license"]); err != nil {
				return err
			}
			if p.Category, err = ask("Category", p.Category, defaults["category"]); err != nil {
				return err
			}
			label := "Main input type (email, username, phone, domain, ip, url, ...)"
			if p.Kind == "guide" {
				label = "Main topic (email, username, phone, domain, ip, ...)"
			}
			if p.Input, err = ask(label, p.Input, defaults["input"]); err != nil {
				return err
			}
			if p.Kind == "pipx" {
				if p.Package, err = ask("PyPI package name", p.Package, p.Name); err != nil {
					return err
				}
			}
			p.PythonProject = scaffold.HasPythonProject(dir)
			files, err := scaffold.Files(p)
			if err != nil {
				return err
			}
			// The example Dockerfile is only useful when the repo has none.
			if _, err := os.Stat(filepath.Join(dir, "Dockerfile")); err != nil {
				if c, ok := files["Dockerfile.otinstaller-example"]; ok {
					files["Dockerfile"] = c
				}
				if c, ok := files["tool.py.otinstaller-example"]; ok {
					files["tool.py"] = c
				}
			}
			delete(files, "Dockerfile.otinstaller-example")
			delete(files, "tool.py.otinstaller-example")

			paths := make([]string, 0, len(files))
			for path := range files {
				paths = append(paths, path)
			}
			sort.Strings(paths)
			for _, path := range paths {
				full := filepath.Join(dir, filepath.FromSlash(path))
				if _, err := os.Stat(full); err == nil && !force {
					fmt.Fprintf(a.Out, "  skipped %s (already exists; use --force to overwrite)\n", path)
					continue
				}
				if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
					return err
				}
				if err := os.WriteFile(full, []byte(files[path]), 0o644); err != nil {
					return err
				}
				fmt.Fprintf(a.Out, "  created %s\n", path)
			}
			if p.Kind == "guide" {
				fmt.Fprintln(a.Out, "\nNext: write the pages in docs/, list them under content.nav and the tools they use under related_tools, then run `ot validate`.")
			} else {
				fmt.Fprintln(a.Out, "\nNext: edit otinstaller.yaml (inputs, outputs, command, ethics) and README.md, then run `ot validate`.")
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&p.Kind, "kind", "", "docker, pipx or guide (detected from the repo by default)")
	f.BoolVar(&guide, "guide", false, "shorthand for --kind guide")
	f.StringVar(&p.Name, "name", "", "package name")
	f.StringVar(&p.Namespace, "namespace", "", "namespace (GitHub/GitLab user or org)")
	f.StringVar(&p.Summary, "summary", "", "one-line summary")
	f.StringVar(&p.License, "license", "", "SPDX license id")
	f.StringVar(&p.Category, "category", "", "category")
	f.StringVar(&p.Input, "input", "", "main input type")
	f.StringVar(&p.Package, "package", "", "PyPI package name (pipx)")
	f.BoolVarP(&yes, "yes", "y", false, "accept defaults without prompting")
	f.BoolVar(&force, "force", false, "overwrite existing files")
	return cmd
}

func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

// prompter returns a function that asks for a value unless a flag already set it.
func (a *App) prompter(yes bool) func(label, current, def string) (string, error) {
	in := bufio.NewReader(a.In)
	return func(label, current, def string) (string, error) {
		if current != "" {
			return current, nil
		}
		if yes {
			if def == "" {
				return "", exitErr(ExitUsage, "%s has no default; pass it as a flag", label)
			}
			return def, nil
		}
		if def != "" {
			fmt.Fprintf(a.Out, "%s [%s]: ", label, def)
		} else {
			fmt.Fprintf(a.Out, "%s: ", label)
		}
		line, err := in.ReadString('\n')
		line = strings.TrimSpace(line)
		if line == "" {
			if def == "" {
				if err != nil {
					return "", exitErr(ExitUsage, "%s is required", label)
				}
				return a.prompter(yes)(label, current, def)
			}
			return def, nil
		}
		return line, nil
	}
}

func (a *App) validateCmd() *cobra.Command {
	var tag string
	var asJSON, smoke bool
	cmd := &cobra.Command{
		Use:   "validate [path]",
		Short: "Check otinstaller.yaml against the spec",
		Long:  "Validates a manifest file, or the otinstaller.yaml in a directory. Exits 2 when problems are found.",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := "."
			if len(args) == 1 {
				path = args[0]
			}
			dir := path
			if fi, err := os.Stat(path); err == nil && fi.IsDir() {
				path = filepath.Join(path, manifest.FileName)
			} else {
				dir = filepath.Dir(path)
			}
			doc, m, err := manifest.LoadFile(path)
			var problems []*manifest.Problem
			if err != nil {
				p, ok := err.(*manifest.Problem)
				if !ok {
					return err
				}
				problems = []*manifest.Problem{p}
			} else {
				problems = manifest.Validate(doc, m, manifest.Options{Tag: tag, Dir: dir})
			}
			if asJSON {
				enc := json.NewEncoder(a.Out)
				enc.SetIndent("", "  ")
				if problems == nil {
					problems = []*manifest.Problem{}
				}
				enc.Encode(map[string]any{"valid": len(problems) == 0, "problems": problems})
			} else if len(problems) == 0 {
				fmt.Fprintf(a.Out, "%s is valid (%s %s, %s)\n", path, m.Ref(), m.Version, describeKind(m))
			} else {
				fmt.Fprintf(a.Out, "%s has %d problem(s):\n", path, len(problems))
				for _, p := range problems {
					loc := ""
					if p.Path != "" {
						loc = " at " + p.Path
					}
					fmt.Fprintf(a.Out, "  %s%s: %s\n", p.Code, loc, p.Message)
					if p.Hint != "" {
						fmt.Fprintf(a.Out, "    hint: %s\n", p.Hint)
					}
				}
				fmt.Fprintf(a.Out, "Docs: %s\n", problems[0].DocsURL())
			}
			if len(problems) > 0 {
				return &ExitError{Code: ExitUsage}
			}
			if smoke {
				return a.smokeTest(cmd, m, path)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&tag, "tag", "", "git tag being released; must equal v<version>")
	cmd.Flags().BoolVar(&asJSON, "json", false, "print problems as JSON")
	cmd.Flags().BoolVar(&smoke, "smoke", false, "also install the package and run its test input")
	return cmd
}

func describeKind(m *manifest.Manifest) string {
	if m.IsGuide() {
		return "guide"
	}
	return m.Runtime.Kind + " tool"
}
