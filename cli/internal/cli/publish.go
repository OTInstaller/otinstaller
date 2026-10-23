package cli

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/oci"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/spf13/cobra"
)

// publishPoll is how often `ot publish` asks how its release is doing.
const publishPoll = 3 * time.Second

// mirrorURL is where `ot publish --image` pushes: the registry's mirror, or OT_MIRROR_URL (a local one, say).
func mirrorURL() string {
	if u := strings.TrimRight(os.Getenv("OT_MIRROR_URL"), "/"); u != "" {
		return u
	}
	return "https://mirror.otinstaller.com"
}

// imageLine is the manifest's runtime.image line, which `ot publish --image` fills in as the release workflows do.
var imageLine = regexp.MustCompile(`(?m)^([ \t]+image:)[ \t]*.*$`)

// imageSource says where `ot publish` gets an image to host on the mirror: a local image, a saved archive, or a build.
type imageSource struct {
	ref, archive, platforms string
	build                   bool
}

func (s imageSource) set() bool { return s.ref != "" || s.archive != "" || s.build }

// publishCmd uploads a release straight to the registry: the manifest, its README and pages, and their images. It is
// how a package without a GitHub or GitLab repository is published. The registry then validates, scans and reviews the
// release as it does a tagged one, so `ot publish` follows the job and reports how it ended.
func (a *App) publishCmd() *cobra.Command {
	var wait, dryRun, sign bool
	var timeout time.Duration
	var src imageSource
	cmd := &cobra.Command{
		Use:   "publish [path]",
		Short: "Upload a release to the registry, without a GitHub or GitLab tag",
		Long: "Uploads the manifest in path (otinstaller.yaml, or the one in a directory) with its README, pages and their images.\n" +
			"The registry validates, scans and, for a new publisher, reviews the release as it does a tagged one.\n" +
			"The artifact must be public: a Docker image pinned by digest, or a PyPI wheel pinned by hash. A Docker image can\n" +
			"live on the registry itself: --image (a local image), --image-archive (a saved OCI or docker archive) or --build\n" +
			"pushes it to mirror.otinstaller.com/<namespace>/<name> and pins its digest in otinstaller.yaml. --sign signs it\n" +
			"with cosign (keyless); the first signer is then pinned for later versions.\n\n" +
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
			if sign && !src.set() {
				return exitErr(ExitUsage, "--sign signs the image ot publish pushes (--image, --image-archive or --build); sign other images with cosign yourself")
			}
			if dryRun {
				if src.set() {
					fmt.Fprintf(a.Err, "note: without --dry-run the image would be pushed to %s/%s/%s first\n", strings.TrimPrefix(strings.TrimPrefix(mirrorURL(), "https://"), "http://"), m.Namespace, m.Name)
				}
				files, err := manifest.BundleFiles(m, path, dir)
				if err != nil {
					return exitErr(ExitUsage, "%v", err)
				}
				return a.printBundle(m, files)
			}
			if a.API.Token == "" {
				return errNotSignedIn("sign in first with `ot login`, or set OTINSTALLER_TOKEN to an API token with the publish scope")
			}
			if src.set() {
				ref, err := a.hostImage(cmd.Context(), m, path, dir, src)
				if err != nil {
					return err
				}
				// The manifest now pins the pushed digest: check it again before anything is uploaded.
				if doc, m, err = manifest.LoadFile(path); err != nil {
					return err
				}
				if problems := manifest.Validate(doc, m, manifest.Options{Dir: dir}); len(problems) > 0 {
					return a.manifestProblems(path, problems)
				}
				if sign {
					if err := a.signImage(cmd.Context(), ref); err != nil {
						return err
					}
				} else {
					fmt.Fprintln(a.Err, "note: the image is not signed; agents (`ot mcp`) won't install an unsigned image. Sign it with --sign.")
				}
			}
			files, err := manifest.BundleFiles(m, path, dir)
			if err != nil {
				return exitErr(ExitUsage, "%v", err)
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
	cmd.Flags().StringVar(&src.ref, "image", "", "push this local image (docker or podman) to the registry's mirror and pin it")
	cmd.Flags().StringVar(&src.archive, "image-archive", "", "push the image in this archive (docker save, or buildx --output type=oci) to the mirror and pin it")
	cmd.Flags().BoolVar(&src.build, "build", false, "build the folder's Dockerfile with docker buildx, push it to the mirror and pin it")
	cmd.Flags().StringVar(&src.platforms, "platform", "linux/amd64", "platforms to --build, comma-separated; linux/amd64 is required")
	cmd.Flags().BoolVar(&sign, "sign", false, "sign the pushed image with cosign (keyless) before publishing")
	cmd.MarkFlagsMutuallyExclusive("image", "image-archive", "build")
	return cmd
}

// hostImage pushes the image to <mirror>/<namespace>/<name>, tagged with the version, and pins its digest in the
// manifest's runtime.image line. It returns the pinned reference.
func (a *App) hostImage(ctx context.Context, m *manifest.Manifest, manifestPath, dir string, src imageSource) (string, error) {
	if m.Runtime == nil || m.Runtime.Kind != "docker" {
		return "", exitErr(ExitUsage, "--image, --image-archive and --build are for Docker tools (runtime.kind: docker)")
	}
	work, err := os.MkdirTemp("", "ot-publish-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	archive := src.archive
	if archive == "" {
		archive = filepath.Join(work, "image.tar")
		if err := a.saveImage(ctx, src, dir, archive); err != nil {
			return "", err
		}
	}
	img, err := oci.Read(archive, filepath.Join(work, "image"))
	if err != nil {
		return "", exitErr(ExitUsage, "%v", err)
	}
	if !img.HasPlatform("linux/amd64") {
		return "", &ExitError{Code: ExitUsage, Reason: "artifact_platform_missing",
			Err:  fmt.Errorf("the image is for %s, but every tool must run on linux/amd64", strings.Join(img.Platforms, ", ")),
			Hint: "build it with `ot publish --build` (or `docker buildx build --platform linux/amd64`)"}
	}
	reg := &oci.Registry{Base: mirrorURL(), Username: "ot", Password: a.API.Token, Progress: a.Err}
	repo := m.Namespace + "/" + m.Name
	fmt.Fprintf(a.Err, "Pushing the image to %s/%s (%.1f MB, %s)\n", reg.Host(), repo, float64(img.Size())/(1<<20), strings.Join(img.Platforms, ", "))
	digest, err := reg.Push(ctx, repo, m.Version, img)
	if err != nil {
		var re *oci.RegistryError
		if errors.As(err, &re) && re.Code == "DENIED" {
			return "", &ExitError{Code: ExitUsage, Reason: "forbidden", Err: err, Hint: "push to a namespace you own or publish to; the image goes to <namespace>/<name> from otinstaller.yaml"}
		}
		return "", exitErr(ExitToolError, "%v", err)
	}
	ref := reg.Host() + "/" + repo + "@" + digest
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return "", err
	}
	loc := imageLine.FindSubmatchIndex(raw)
	if loc == nil {
		return "", exitErr(ExitUsage, "%s has no runtime.image line to pin the image in", manifestPath)
	}
	pinned := append(append(append([]byte{}, raw[:loc[3]]...), []byte(" "+ref)...), raw[loc[1]:]...)
	if err := os.WriteFile(manifestPath, pinned, 0o644); err != nil {
		return "", err
	}
	fmt.Fprintf(a.Err, "note: pinned runtime.image to %s in %s\n", ref, manifestPath)
	return ref, nil
}

// saveImage writes the image to archive: `docker save` (or Podman's OCI archive), or a buildx build of dir.
func (a *App) saveImage(ctx context.Context, src imageSource, dir, archive string) error {
	engine := a.Runner.Engine
	if engine == "" {
		return &runner.RuntimeMissingError{Msg: "pushing an image needs Docker (or Podman), which was not found; or pass --image-archive"}
	}
	var args []string
	switch {
	case src.build:
		if engine != "docker" {
			return exitErr(ExitUsage, "--build needs Docker with buildx; with Podman, build the image and pass --image")
		}
		args = []string{"buildx", "build", "--platform", src.platforms, "--output", "type=oci,dest=" + archive, dir}
	case engine == "podman":
		args = []string{"save", "--format", "oci-archive", "-o", archive, src.ref}
	default:
		args = []string{"save", "-o", archive, src.ref}
	}
	code, err := a.Runner.Exec.Run(ctx, engine, args, nil, nil, a.Err, a.Err)
	if err != nil {
		return err
	}
	if code != 0 {
		return exitErr(ExitToolError, "`%s %s` failed with exit code %d", engine, strings.Join(args[:2], " "), code)
	}
	return nil
}

// signImage signs ref with cosign, keyless. The mirror credential goes in a throwaway DOCKER_CONFIG, never in argv.
func (a *App) signImage(ctx context.Context, ref string) error {
	if _, err := a.Runner.Exec.LookPath("cosign"); err != nil {
		return &runner.RuntimeMissingError{Msg: "--sign needs cosign: https://docs.sigstore.dev/cosign/system_config/installation/"}
	}
	cfg, err := os.MkdirTemp("", "ot-cosign-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(cfg)
	host := ref[:strings.Index(ref, "/")]
	auth := base64.StdEncoding.EncodeToString([]byte("ot:" + a.API.Token))
	conf, _ := json.Marshal(map[string]any{"auths": map[string]any{host: map[string]string{"auth": auth}}})
	if err := os.WriteFile(filepath.Join(cfg, "config.json"), conf, 0o600); err != nil {
		return err
	}
	args := []string{"sign", "--yes"}
	if strings.HasPrefix(mirrorURL(), "http://") {
		args = append(args, "--allow-http-registry")
	}
	fmt.Fprintf(a.Err, "Signing %s with cosign\n", ref)
	code, err := a.Runner.Exec.Run(ctx, "cosign", append(args, ref), []string{"DOCKER_CONFIG=" + cfg}, nil, a.Err, a.Err)
	if err != nil {
		return err
	}
	if code != 0 {
		return exitErr(ExitToolError, "cosign sign failed with exit code %d; nothing was published", code)
	}
	return nil
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
