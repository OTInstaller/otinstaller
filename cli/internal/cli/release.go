package cli

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

var (
	releaseVersionRe = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$`)
	manifestVersion  = regexp.MustCompile(`(?m)^version:[ \t]*.*$`)
)

// git runs git in dir and returns its trimmed output; stderr is folded into the error.
func git(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(errb.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), msg)
	}
	return strings.TrimSpace(out.String()), nil
}

// releaseCmd releases a guide from the publisher's own computer: no CI run is needed, because a guide release
// is only a version bump and a tag. Tools keep their release workflow, which builds and signs the artifact.
func (a *App) releaseCmd() *cobra.Command {
	var remote string
	var noPush bool
	cmd := &cobra.Command{
		Use:   "release <version> [path]",
		Short: "Release a guide: set its version, commit, tag and push, without CI",
		Long: "Sets version in otinstaller.yaml, checks the guide as the registry will, commits, tags v<version> and pushes\n" +
			"the commit and tag together. The registry picks the tag up within a minute.\n\n" +
			"Only for guides. Tools are released by their otinstaller release workflow, which builds and signs the image or wheel.",
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			version := strings.TrimPrefix(strings.TrimSpace(args[0]), "v")
			if !releaseVersionRe.MatchString(version) {
				return exitErr(ExitUsage, "%q is not a version like 1.2.0", args[0])
			}
			dir := "."
			if len(args) == 2 {
				dir = args[1]
			}
			path := filepath.Join(dir, manifest.FileName)
			_, m, err := manifest.LoadFile(path)
			if err != nil {
				return exitErr(ExitUsage, "%v", err)
			}
			if !m.IsGuide() {
				return exitErr(ExitUsage, "ot release is for guides; release %s with its otinstaller release workflow, which builds and signs it", m.Ref())
			}
			tag := "v" + version

			// The registry reads the tagged commit, so everything the guide needs must be committed already.
			if _, err := git(dir, "rev-parse", "--is-inside-work-tree"); err != nil {
				return exitErr(ExitUsage, "%s is not in a git repository", dir)
			}
			if status, err := git(dir, "status", "--porcelain", "--untracked-files=no"); err != nil {
				return err
			} else if status != "" {
				return exitErr(ExitUsage, "commit your changes first; the registry reads the tagged commit:\n%s", status)
			}
			if _, err := git(dir, "rev-parse", "-q", "--verify", "refs/tags/"+tag); err == nil {
				return exitErr(ExitUsage, "%s already exists; versions never change, so pick a new one", tag)
			}
			if !noPush {
				if out, err := git(dir, "ls-remote", "--tags", remote, "refs/tags/"+tag); err != nil {
					return err
				} else if out != "" {
					return exitErr(ExitUsage, "%s is already on %s; versions never change, so pick a new one", tag, remote)
				}
			}

			// Bump the version, then check the result exactly as the registry will before anything is committed.
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if !manifestVersion.Match(raw) {
				return exitErr(ExitUsage, "%s has no top-level version line", path)
			}
			bumped := manifestVersion.ReplaceAll(raw, []byte("version: "+version))
			if err := os.WriteFile(path, bumped, 0o644); err != nil {
				return err
			}
			restore := func() { _ = os.WriteFile(path, raw, 0o644) }
			doc, m2, err := manifest.LoadFile(path)
			if err != nil {
				restore()
				return exitErr(ExitUsage, "%v", err)
			}
			if problems := manifest.Validate(doc, m2, manifest.Options{Tag: tag, Dir: dir}); len(problems) > 0 {
				restore()
				if a.jsonMode() {
					return problemsError(fmt.Sprintf("not released: %s has %d problem(s)", path, len(problems)), problems)
				}
				fmt.Fprintf(a.Out, "Not released: %s has %d problem(s):\n", path, len(problems))
				for _, p := range problems {
					fmt.Fprintf(a.Out, "  %s: %s\n", p.Code, p.Message)
				}
				return &ExitError{Code: ExitUsage}
			}

			if !bytes.Equal(raw, bumped) {
				if _, err := git(dir, "commit", "-q", "-m", "Release "+version, "--", manifest.FileName); err != nil {
					restore()
					return err
				}
			}
			if _, err := git(dir, "tag", "-a", tag, "-m", "Release "+version); err != nil {
				return err
			}
			if a.jsonMode() && noPush {
				return writeJSON(a.Out, map[string]any{"ref": m.Ref(), "version": version, "tag": tag, "pushed": false})
			}
			if noPush {
				fmt.Fprintf(a.Out, "Tagged %s %s locally. Push it with: git push --atomic %s HEAD %s\n", m.Ref(), tag, remote, tag)
				return nil
			}
			if _, err := git(dir, "push", "-q", "--atomic", remote, "HEAD", tag); err != nil {
				return fmt.Errorf("%w\nThe commit and tag are made locally; push them with: git push --atomic %s HEAD %s", err, remote, tag)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"ref": m.Ref(), "version": version, "tag": tag, "pushed": true, "remote": remote})
			}
			fmt.Fprintf(a.Out, "Released %s %s: pushed %s. The registry checks it within a minute; follow it with `ot sync %s --log`.\n",
				m.Ref(), version, tag, m.Ref())
			return nil
		},
	}
	cmd.Flags().StringVar(&remote, "remote", "origin", "git remote to push to")
	cmd.Flags().BoolVar(&noPush, "no-push", false, "commit and tag locally without pushing")
	return cmd
}
