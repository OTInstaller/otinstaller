package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/spf13/cobra"
)

// publishPoll is how often `ot publish` asks how its release is doing.
const publishPoll = 3 * time.Second

// publishCmd uploads a release straight to the registry: the manifest, its README and pages, and their images. It is
// how a package without a GitHub or GitLab repository is published. The registry then validates, scans and reviews the
// release as it does a tagged one, so `ot publish` follows the job and reports how it ended.
func (a *App) publishCmd() *cobra.Command {
	var wait, dryRun bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "publish [path]",
		Short: "Upload a release to the registry, without a GitHub or GitLab tag",
		Long: "Uploads the manifest in path (otinstaller.yaml, or the one in a directory) with its README, pages and their images.\n" +
			"The registry validates, scans and, for a new publisher, reviews the release as it does a tagged one.\n" +
			"The artifact must already be public: a Docker image pinned by digest, or a PyPI wheel pinned by hash.\n\n" +
			"You publish into a namespace you own or publish to; create one with `ot namespace create`. By default ot waits until\n" +
			"validation ends; --wait waits until the release is published, rejected or held for review.",
		Args: cobra.MaximumNArgs(1),
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
				problems = manifest.Validate(doc, m, manifest.Options{Dir: dir})
			}
			if len(problems) > 0 {
				return a.manifestProblems(path, problems)
			}
			files, err := manifest.BundleFiles(m, path, dir)
			if err != nil {
				return exitErr(ExitUsage, "%v", err)
			}
			if dryRun {
				return a.printBundle(m, files)
			}
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`, or set OTINSTALLER_TOKEN to an API token with the publish scope")
			}
			uploads := make([]api.UploadFile, 0, len(files))
			for _, f := range files {
				data, err := os.ReadFile(f.File)
				if err != nil {
					return err
				}
				uploads = append(uploads, api.UploadFile{Path: f.Path, Data: data})
			}
			ctx := cmd.Context()
			up, err := a.API.Publish(ctx, m.Namespace, m.Name, m.Version, uploads)
			if err != nil {
				return a.requestError(err)
			}
			fmt.Fprintf(a.Err, "Uploaded %s %s (%d files). Following the release at %s\n", up.Ref, up.Version, len(files), up.URL)
			if timeout == 0 {
				timeout = 5 * time.Minute
				if wait {
					timeout = 90 * time.Minute
				}
			}
			job, err := a.followJob(ctx, up.JobID, wait, timeout)
			if err != nil {
				return err
			}
			return a.publishOutcome(m, job, wait)
		},
	}
	cmd.Flags().BoolVar(&wait, "wait", false, "wait until the release is published, rejected or held for review (scans can take several minutes)")
	cmd.Flags().DurationVar(&timeout, "timeout", 0, "how long to wait (default 5m, or 90m with --wait)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "validate and list the files that would be uploaded, without uploading")
	return cmd
}

// manifestProblems prints a manifest's problems as `ot validate` does and exits 2.
func (a *App) manifestProblems(path string, problems []*manifest.Problem) error {
	ps := make([]api.Problem, len(problems))
	for i, p := range problems {
		ps[i] = api.Problem{Code: p.Code, Path: p.Path, Message: p.Message, Hint: p.Hint}
	}
	if !a.jsonMode() {
		printProblems(a.Err, ps)
	}
	return &ExitError{Code: ExitUsage, Err: fmt.Errorf("%s has %d problem(s); nothing was uploaded", path, len(problems)),
		Reason: problems[0].Code, Problems: ps, Hint: "fix them and run `ot publish` again (`ot validate` checks without uploading)"}
}

func (a *App) printBundle(m *manifest.Manifest, files []manifest.BundleFile) error {
	var total int64
	for _, f := range files {
		total += f.Size
	}
	if a.jsonMode() {
		list := make([]map[string]any, len(files))
		for i, f := range files {
			list[i] = map[string]any{"path": f.Path, "size": f.Size}
		}
		return writeJSON(a.Out, map[string]any{"ref": m.Ref(), "version": m.Version, "files": list, "total_bytes": total})
	}
	fmt.Fprintf(a.Out, "%s %s would upload %d files (%.1f KB):\n", m.Ref(), m.Version, len(files), float64(total)/1024)
	for _, f := range files {
		fmt.Fprintf(a.Out, "  %s\n", f.Path)
	}
	return nil
}

// followJob polls a publish job, printing each new status on stderr, until validation is over (or, with untilDone,
// until it is published, rejected or held for review), or the timeout passes.
func (a *App) followJob(ctx context.Context, id string, untilDone bool, timeout time.Duration) (*api.PublishJob, error) {
	deadline := time.Now().Add(timeout)
	last := ""
	for {
		job, err := a.API.PublishJob(ctx, id)
		if err != nil {
			return nil, a.requestError(err)
		}
		if job.Status != last {
			fmt.Fprintf(a.Err, "  %s\n", statusLine(job.Status))
			last = job.Status
		}
		finished := job.Status == "published" || job.Status == "rejected" || job.Status == "error" || job.Status == "awaiting_review"
		if finished || (!untilDone && job.Status != "queued" && job.Status != "validating") {
			return job, nil
		}
		if time.Now().After(deadline) {
			return job, nil
		}
		if err := pollSleep(ctx, publishPoll); err != nil {
			return nil, err
		}
	}
}

func statusLine(status string) string {
	switch status {
	case "queued":
		return "queued"
	case "validating":
		return "validating the manifest, pages and artifact"
	case "scanning":
		return "valid; checks running (security scan for tools, link and content checks for guides)"
	case "awaiting_review":
		return "checks passed; waiting for a reviewer"
	case "published":
		return "published"
	case "rejected":
		return "not published"
	}
	return status
}

// publishOutcome reports how the job ended: data on stdout, and an error (with the problems) when it was refused.
func (a *App) publishOutcome(m *manifest.Manifest, job *api.PublishJob, waited bool) error {
	if a.jsonMode() {
		if err := writeJSON(a.Out, job); err != nil {
			return err
		}
	}
	site := strings.TrimRight(a.Config.SiteURL, "/")
	switch job.Status {
	case "rejected", "error":
		reason := job.ErrorCode
		if reason == "" && len(job.Problems) > 0 {
			reason = job.Problems[0].Code
		}
		if !a.jsonMode() && len(job.Problems) > 0 {
			printProblems(a.Err, job.Problems)
		}
		detail := job.ErrorDetail
		if detail == "" && len(job.Problems) > 0 {
			detail = job.Problems[0].Message
		}
		// Problems found while validating are the manifest's to fix (exit 2); a failed check is the release's (exit 1).
		code := ExitToolError
		if len(job.Problems) > 0 {
			code = ExitUsage
		}
		return &ExitError{Code: code, Err: fmt.Errorf("%s %s was not published: %s", m.Ref(), m.Version, detail), Reason: reason, Problems: job.Problems,
			Hint: "see https://otinstaller.com/docs/errors#" + reason + "; fix it and run `ot publish` again"}
	}
	if a.jsonMode() {
		return nil
	}
	switch job.Status {
	case "published":
		fmt.Fprintf(a.Out, "Published %s %s: %s/%s\nInstall it with: ot install %s\n", m.Ref(), m.Version, site, m.Ref(), m.Ref())
	case "awaiting_review":
		fmt.Fprintf(a.Out, "%s %s passed its checks. %s is a new publisher, so a reviewer looks at its first release before it goes public (usually within 3 business days).\n",
			m.Ref(), m.Version, m.Namespace)
	case "scanning":
		fmt.Fprintf(a.Out, "%s %s is valid and its checks are running. You'll get an email when it is published; follow it at %s\n", m.Ref(), m.Version, job.URL)
	default:
		if waited {
			fmt.Fprintf(a.Out, "%s %s is still %s. Follow it at %s\n", m.Ref(), m.Version, job.Status, job.URL)
		} else {
			fmt.Fprintf(a.Out, "%s %s is %s. Follow it at %s\n", m.Ref(), m.Version, job.Status, job.URL)
		}
	}
	return nil
}
