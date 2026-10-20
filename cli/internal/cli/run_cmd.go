package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// runArgs is what `ot run` parsed. Tool inputs are free-form flags, so cobra's parser is off.
type runArgs struct {
	Pkg        string
	Inputs     map[string]string
	Typed      []runner.TypedInput
	Format     string
	Output     string
	OutDir     string
	Native     bool
	Yes        bool
	Help       bool
	All        bool
	Parallel   int
	NoSave     bool
	ResultsDir string
	Case       string
	// DryRun lists what --all, a playbook or auto would run, without running it.
	DryRun bool
	// Detect turns bare targets (example.com) into typed inputs, for auto and playbooks.
	Detect bool
}

func parseRunArgs(args []string) (*runArgs, error) {
	return parseArgs(args, false)
}

func parseArgs(args []string, detect bool) (*runArgs, error) {
	ra := &runArgs{Inputs: map[string]string{}, Parallel: 4, Detect: detect}
	var positional []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") {
			positional = append(positional, arg)
			continue
		}
		name, val, hasVal := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		switch name {
		case "h", "help":
			ra.Help = true
			continue
		case "native":
			ra.Native = true
			continue
		case "y", "yes":
			ra.Yes = true
			continue
		case "all":
			ra.All = true
			continue
		case "no-save":
			ra.NoSave = true
			continue
		case "dry-run":
			ra.DryRun = true
			continue
		case "live":
			// otinstaller's live table; ot always shows progress with --all, playbooks and auto.
			continue
		}
		if !hasVal {
			if i+1 >= len(args) {
				return nil, &runner.UsageError{Msg: fmt.Sprintf("--%s needs a value", name)}
			}
			i++
			val = args[i]
		}
		switch name {
		case "format", "f":
			ra.Format = val
		case "o", "output":
			ra.Output = val
		case "out-dir":
			ra.OutDir = val
		case "results-dir":
			ra.ResultsDir = val
		case "case":
			ra.Case = val
		case "parallel":
			n, err := strconv.Atoi(val)
			if err != nil || n < 1 {
				return nil, &runner.UsageError{Msg: fmt.Sprintf("--parallel needs a whole number of at least 1, not %q", val)}
			}
			ra.Parallel = n
		default:
			ra.Inputs[name] = val
		}
	}
	// The package comes first, so a Windows path such as D:\tools\otinstaller.yaml is never read as
	// a typed input. --all has no package: every positional is a typed input.
	if !ra.All && len(positional) > 0 {
		ra.Pkg, positional = positional[0], positional[1:]
	}
	seen := map[string]bool{}
	for _, arg := range positional {
		t, ok, err := runner.ParseTypedInput(arg)
		if err != nil {
			return nil, err
		}
		if !ok && ra.Detect {
			t, ok = runner.DetectTyped(arg), true
		}
		if !ok {
			return nil, &runner.UsageError{Msg: fmt.Sprintf("unexpected argument %q; inputs are passed as --name value or as u:, d:, e:, p:, ip:, url:", arg)}
		}
		if seen[t.Prefix] {
			return nil, &runner.UsageError{Msg: fmt.Sprintf("%s: is given twice", t.Prefix)}
		}
		seen[t.Prefix] = true
		ra.Typed = append(ra.Typed, t)
	}
	return ra, nil
}

const runHelp = `Run a tool, save its output and print its result envelope.

Usage:
  ot run <namespace/name[@version]> [<type>:<value> ...] [--<input> <value> ...] [flags]
  ot run --all <type>:<value> [...] [flags]

Typed inputs fill the tool's input of that type:
  u:<username>  d:<domain>  e:<email>  p:<phone>  ip:<ip>  url:<url>

Flags:
  -f, --format string       json (default), table, csv or raw; with --all, table (default) or json
  -o, --output string       write the result to a file instead of stdout
      --out-dir string      host directory mounted at /out for tools that write files
      --native              run pipx tools on the host instead of in a container
  -y, --yes                 install without asking if the tool is not installed
      --results-dir string  where runs are saved (default $OT_RESULTS_DIR, else ./results)
      --case string         save under <results-dir>/cases/<case>
      --no-save             don't save the run
      --all                 run every installed tool that has an input of the given types
      --parallel int        how many tools --all runs at once (default 4)
      --dry-run             with --all, list the tools that would run, without running them

Run ` + "`ot info <tool>`" + ` to see a tool's inputs.
`

func (a *App) runCmd() *cobra.Command {
	return &cobra.Command{
		Use:                "run <namespace/name> --<input> <value> ...",
		Short:              "Run a tool",
		DisableFlagParsing: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			ra, err := parseRunArgs(args)
			if err != nil {
				return err
			}
			if ra.Help {
				fmt.Fprint(a.Out, runHelp)
				return nil
			}
			if ra.All {
				return a.runAll(cmd.Context(), ra, "--all", nil)
			}
			if ra.DryRun {
				return exitErr(ExitUsage, "--dry-run goes with --all; `ot info` shows what a single run needs")
			}
			if ra.Pkg == "" {
				fmt.Fprint(a.Out, runHelp)
				return &ExitError{Code: ExitUsage}
			}
			ref, err := parseRef(ra.Pkg)
			if err != nil {
				return err
			}
			inst, err := a.ensureInstalled(cmd, ref, ra)
			if err != nil {
				return err
			}
			m := inst.Manifest
			given, target, err := runner.ApplyTyped(m, ra.Inputs, ra.Typed)
			if err != nil {
				return err
			}
			values, err := runner.ResolveInputs(m, given)
			if err != nil {
				return err
			}
			if target == "" {
				target = firstGiven(m, given)
			}
			secrets, err := loadSecrets(m)
			if err != nil {
				return err
			}
			env, meta, err := a.execute(cmd.Context(), inst, values, secrets, target, ra, a.Runner.Stderr)
			if meta != nil {
				fmt.Fprintf(a.Err, "Saved %s\n", meta.OutputPath)
			}
			if err != nil {
				return err
			}
			w := a.Out
			if ra.Output != "" {
				f, err := os.Create(ra.Output)
				if err != nil {
					return err
				}
				defer f.Close()
				w = f
			}
			format := ra.Format
			if format == "" {
				format = orDefault(a.Config.Format, "json")
			}
			if err := env.Write(w, format); err != nil {
				return &runner.UsageError{Msg: err.Error()}
			}
			if ra.Output != "" {
				fmt.Fprintf(a.Err, "Wrote %d entities to %s\n", len(env.Entities), ra.Output)
			}
			if env.ExitCode != 0 {
				return &ExitError{Code: ExitToolError, Err: fmt.Errorf("%s exited with code %d", m.Ref(), env.ExitCode)}
			}
			return nil
		},
	}
}

// firstGiven is the value of the first input, in manifest order, the user passed. It names the
// results folder when no typed input did.
func firstGiven(m *manifest.Manifest, given map[string]string) string {
	for _, in := range m.Inputs {
		if v, ok := given[in.Name]; ok {
			return v
		}
	}
	return ""
}

// execute runs an installed tool and, unless --no-save, saves its output and sidecar. The meta
// is returned whenever something was saved, including for a timeout or an interrupted run.
func (a *App) execute(ctx context.Context, inst *state.Installed, values, secrets map[string]string, target string, ra *runArgs, stderr io.Writer) (*envelope.Envelope, *results.Meta, error) {
	opt := runner.RunOptions{Values: values, Secrets: secrets, OutDir: ra.OutDir, Stderr: stderr}
	if ra.NoSave {
		env, err := a.Runner.Run(ctx, inst, opt)
		return env, nil, err
	}
	m := inst.Manifest
	rec, err := results.Start(results.Dir(ra.ResultsDir), m.Name, target, ra.Case, m.Runtime.OutputFormat)
	if err != nil {
		return nil, nil, &ExitError{Code: ExitToolError, Err: err}
	}
	opt.Stdout = rec.Stdout()
	opt.Stderr = io.MultiWriter(stderr, rec.Stderr())
	env, runErr := a.Runner.Run(ctx, inst, opt)

	meta := &results.Meta{
		Command:     runner.BuildCommand(m, values),
		Tool:        m.Name,
		Ref:         m.Ref(),
		ToolVersion: inst.Version,
		Runtime:     inst.Runtime,
		Target:      target,
		Input:       values,
		Envelope:    envelope.Version,
		ExitCode:    -1,
	}
	if ra.Case != "" {
		meta.Case = &ra.Case
	}
	var timeout *runner.TimeoutError
	switch {
	case errors.As(runErr, &timeout):
		meta.Status = results.StatusTimeout
	case ctx.Err() != nil:
		// A killed tool usually just exits non-zero, so the context says whether it was Ctrl-C.
		meta.Status = results.StatusInterrupted
		env, runErr = nil, &ExitError{Code: ExitInterrupted, Err: errors.New("interrupted")}
	case runErr == nil:
		meta.ExitCode, meta.Entities, meta.Warnings = env.ExitCode, env.Entities, env.Warnings
		meta.Status = results.StatusComplete
		if env.ExitCode != 0 {
			meta.Status = results.StatusFailed
		}
	default:
		// The tool never ran (no Docker, a missing pipx binary): there is nothing to keep.
		rec.Discard()
		return nil, nil, runErr
	}
	if err := rec.Finish(meta); err != nil {
		if runErr == nil {
			runErr = err
		}
		fmt.Fprintf(a.Err, "warning: %v\n", err)
	}
	return env, meta, runErr
}
