package runner

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// Exec runs external programs. Tests replace it with a fake.
type Exec interface {
	LookPath(name string) (string, error)
	Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error)
}

type OSExec struct{}

func (OSExec) LookPath(name string) (string, error) { return exec.LookPath(name) }

func (OSExec) Run(ctx context.Context, name string, args, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), env...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	err := cmd.Run()
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode(), nil
	}
	if err != nil {
		return -1, err
	}
	return 0, nil
}

// Runner holds what installs and runs need.
type Runner struct {
	Exec   Exec
	Stderr io.Writer
	// Engine is "docker" or "podman"; empty when neither is installed.
	Engine string
}

func New(stderr io.Writer) *Runner {
	r := &Runner{Exec: OSExec{}, Stderr: stderr}
	r.Engine = DetectEngine(r.Exec)
	return r
}

// DetectEngine finds a Docker-compatible container engine.
func DetectEngine(ex Exec) string {
	for _, e := range []string{"docker", "podman"} {
		if _, err := ex.LookPath(e); err == nil {
			return e
		}
	}
	return ""
}

// RuntimeMissingError means Docker or pipx is not available (exit code 5).
type RuntimeMissingError struct{ Msg string }

func (e *RuntimeMissingError) Error() string { return e.Msg }

// TimeoutError means the tool ran past its timeout (exit code 124).
type TimeoutError struct{ Seconds int }

func (e *TimeoutError) Error() string {
	return fmt.Sprintf("tool did not finish within %ds", e.Seconds)
}

func (r *Runner) requireEngine() error {
	if r.Engine == "" {
		return &RuntimeMissingError{"this package needs Docker (or Podman), which was not found; install Docker Desktop and run `ot doctor`"}
	}
	return nil
}

// RunOptions are per-run settings.
type RunOptions struct {
	Values  map[string]string // resolved inputs
	Secrets map[string]string // secret name -> value
	OutDir  string            // host directory mounted at /out, optional
}

// Run executes an installed package and returns its result envelope.
func (r *Runner) Run(ctx context.Context, inst *state.Installed, opt RunOptions) (*envelope.Envelope, error) {
	m := inst.Manifest
	timeout := m.Timeout()
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	cmd := BuildCommand(m, opt.Values)
	env := make([]string, 0, len(opt.Secrets))
	for k, v := range opt.Secrets {
		env = append(env, k+"="+v)
	}

	var stdout bytes.Buffer
	started := time.Now()
	var exit int
	var err error
	switch {
	case inst.Runtime == "docker" || (inst.Runtime == "pipx" && !inst.Native):
		image := m.Runtime.Image
		if inst.LocalImage != "" {
			image = inst.LocalImage
		}
		exit, err = r.runContainer(ctx, m, image, cmd, opt, env, &stdout)
	case inst.Runtime == "pipx" && inst.Native:
		exit, err = r.runNative(ctx, cmd, env, &stdout)
	default:
		return nil, fmt.Errorf("unknown runtime %q", inst.Runtime)
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return nil, &TimeoutError{timeout}
	}
	if err != nil {
		return nil, err
	}

	raw, entities, warnings := envelope.ParseOutput(m.Runtime.OutputFormat, stdout.Bytes())
	if warnings == nil {
		warnings = []string{}
	}
	return &envelope.Envelope{
		Envelope:   envelope.Version,
		Tool:       m.Ref() + "@" + m.Version,
		Runtime:    inst.Runtime,
		Input:      opt.Values,
		StartedAt:  started.UTC(),
		DurationMS: time.Since(started).Milliseconds(),
		ExitCode:   exit,
		Entities:   entities,
		Raw:        raw,
		Warnings:   warnings,
	}, nil
}

// ContainerArgs builds the sandboxed `docker run` arguments.
func ContainerArgs(m *manifest.Manifest, name, image string, cmd []string, secretNames []string, outDir string) []string {
	args := []string{
		"run", "--rm", "--name", name,
		"--read-only", "--tmpfs", "/tmp:rw,size=256m",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--pids-limit", "256", "--memory", "1g", "--cpus", "2",
		"--user", "65534:65534", "-e", "HOME=/tmp",
	}
	if m.Network != nil && m.Network.Egress != nil && !*m.Network.Egress {
		args = append(args, "--network", "none")
	}
	// "-e NAME" without a value copies it from ot's environment, so secrets never appear in argv.
	for _, s := range secretNames {
		args = append(args, "-e", s)
	}
	if outDir != "" {
		args = append(args, "-v", outDir+":/out:rw")
	}
	// The image's entrypoint is replaced by the manifest's command.
	args = append(args, "--entrypoint", cmd[0], image)
	return append(args, cmd[1:]...)
}

func (r *Runner) runContainer(ctx context.Context, m *manifest.Manifest, image string, cmd []string, opt RunOptions, env []string, stdout io.Writer) (int, error) {
	if err := r.requireEngine(); err != nil {
		return 0, err
	}
	name := "ot-" + randomHex(6)
	var secretNames []string
	for k := range opt.Secrets {
		secretNames = append(secretNames, k)
	}
	args := ContainerArgs(m, name, image, cmd, secretNames, opt.OutDir)
	exit, err := r.Exec.Run(ctx, r.Engine, args, env, nil, stdout, r.Stderr)
	if ctx.Err() != nil {
		// The client was killed; make sure the container goes too.
		_, _ = r.Exec.Run(context.Background(), r.Engine, []string{"kill", name}, nil, nil, io.Discard, io.Discard)
	}
	return exit, err
}

func (r *Runner) runNative(ctx context.Context, cmd, env []string, stdout io.Writer) (int, error) {
	bin := filepath.Join(PipxBinDir(), cmd[0])
	if runtime.GOOS == "windows" {
		bin += ".exe"
	}
	if _, err := os.Stat(bin); err != nil {
		return 0, fmt.Errorf("%s is not installed in ot's pipx environment; run `ot install` again", cmd[0])
	}
	return r.Exec.Run(ctx, bin, cmd[1:], env, nil, stdout, r.Stderr)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// LocalImageName is the tag ot gives images it builds for sandboxed pipx packages.
func LocalImageName(m *manifest.Manifest) string {
	return "ot-local/" + m.Namespace + "-" + m.Name + ":" + strings.ToLower(m.Version)
}
