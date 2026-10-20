package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/keys"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

func newJSONEncoder(w io.Writer) *json.Encoder {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc
}

// runArgs is what `ot run` parsed. Tool inputs are free-form flags, so cobra's parser is off.
type runArgs struct {
	Pkg    string
	Inputs map[string]string
	Format string
	Output string
	OutDir string
	Native bool
	Yes    bool
	Help   bool
}

func parseRunArgs(args []string) (*runArgs, error) {
	ra := &runArgs{Inputs: map[string]string{}}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") {
			if ra.Pkg != "" {
				return nil, &runner.UsageError{Msg: fmt.Sprintf("unexpected argument %q; inputs are passed as --name value", arg)}
			}
			ra.Pkg = arg
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
		default:
			ra.Inputs[name] = val
		}
	}
	return ra, nil
}

const runHelp = `Run a tool and print its result envelope.

Usage:
  ot run <namespace/name[@version]> --<input> <value> [...] [flags]

Flags:
  -f, --format string   json (default), table, csv or raw
  -o, --output string   write the result to a file instead of stdout
      --out-dir string  host directory mounted at /out for tools that write files
      --native          run pipx tools on the host instead of in a container
  -y, --yes             install without asking if the tool is not installed

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
			if ra.Help || ra.Pkg == "" {
				fmt.Fprint(a.Out, runHelp)
				if ra.Pkg == "" && !ra.Help {
					return &ExitError{Code: ExitUsage}
				}
				return nil
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
			values, err := runner.ResolveInputs(m, ra.Inputs)
			if err != nil {
				return err
			}
			secrets, err := loadSecrets(m)
			if err != nil {
				return err
			}
			env, err := a.Runner.Run(cmd.Context(), inst, runner.RunOptions{Values: values, Secrets: secrets, OutDir: ra.OutDir})
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

// ensureInstalled returns the installed package, installing it first (after asking) if needed.
func (a *App) ensureInstalled(cmd *cobra.Command, ref pkgRef, ra *runArgs) (*state.Installed, error) {
	if ref.LocalPath != "" {
		// Local manifests are always (re)installed so edits take effect.
		return a.install(cmd.Context(), ref, ra.Native)
	}
	st, err := state.Load()
	if err != nil {
		return nil, err
	}
	if inst, ok := st.Installed[ref.Ref()]; ok && (ref.Version == "" || ref.Version == inst.Version) {
		// An installed version the registry has since removed is refused (the list is refreshed at most hourly).
		if a.CheckRemovals {
			if r := removal(a.removedList(cmd.Context(), time.Hour), inst.Ref, inst.Version); r != nil {
				return nil, exitErr(ExitTrust, "%s@%s was removed from the registry (%s); remove it with `ot uninstall %s`", inst.Ref, inst.Version, r.Category, inst.Ref)
			}
		}
		return inst, nil
	}
	if !ra.Yes {
		fmt.Fprintf(a.Err, "%s is not installed. Install it now? [Y/n] ", ref.Ref())
		line, _ := bufio.NewReader(a.In).ReadString('\n')
		if ans := strings.ToLower(strings.TrimSpace(line)); ans != "" && ans != "y" && ans != "yes" {
			return nil, exitErr(ExitUsage, "not installed; run `ot install %s` first", ref.Ref())
		}
	}
	return a.install(cmd.Context(), ref, ra.Native)
}

// loadSecrets reads declared secrets from the environment or keychain.
func loadSecrets(m *manifest.Manifest) (map[string]string, error) {
	out := map[string]string{}
	for _, s := range m.Secrets {
		v, err := keys.Get(s.Name)
		if errors.Is(err, keys.ErrNotFound) {
			if s.Required {
				msg := fmt.Sprintf("%s needs the key %s; set it with `ot keys set %s`", m.Ref(), s.Name, s.Name)
				if s.URL != "" {
					msg += " (get one at " + s.URL + ")"
				}
				return nil, &ExitError{Code: ExitMissingKey, Err: errors.New(msg)}
			}
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("reading %s from the keychain: %w", s.Name, err)
		}
		out[s.Name] = v
	}
	return out, nil
}

// smokeTest installs the manifest locally and runs its test input, as the registry's scanner does.
func (a *App) smokeTest(cmd *cobra.Command, m *manifest.Manifest, path string) error {
	if m.IsGuide() {
		fmt.Fprintln(a.Out, "Guides have no smoke test.")
		return nil
	}
	if m.Test == nil {
		return exitErr(ExitUsage, "manifest has no test.input to run")
	}
	inst, err := a.install(cmd.Context(), pkgRef{LocalPath: path}, false)
	if err != nil {
		return err
	}
	given := map[string]string{}
	for k, v := range m.Test.Input {
		given[k] = fmt.Sprint(v)
	}
	values, err := runner.ResolveInputs(m, given)
	if err != nil {
		return err
	}
	secrets, err := loadSecrets(m)
	if err != nil {
		return err
	}
	env, err := a.Runner.Run(cmd.Context(), inst, runner.RunOptions{Values: values, Secrets: secrets})
	if err != nil {
		return err
	}
	if env.ExitCode != m.Test.ExpectExitCode {
		return exitErr(ExitToolError, "smoke test failed: exit code %d, expected %d", env.ExitCode, m.Test.ExpectExitCode)
	}
	fmt.Fprintf(a.Out, "Smoke test passed in %dms (%d entities).\n", env.DurationMS, len(env.Entities))
	return nil
}

func (a *App) keysCmd() *cobra.Command {
	cmd := &cobra.Command{Use: "keys", Short: "Manage API keys stored in your OS keychain"}
	cmd.AddCommand(
		&cobra.Command{
			Use:   "set <NAME>",
			Short: "Store a key (reads the value from stdin)",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				fmt.Fprintf(a.Err, "Value for %s: ", args[0])
				line, err := bufio.NewReader(a.In).ReadString('\n')
				val := strings.TrimSpace(line)
				if val == "" {
					return exitErr(ExitUsage, "no value given: %v", err)
				}
				if err := keys.Set(args[0], val); err != nil {
					return err
				}
				fmt.Fprintf(a.Out, "Saved %s to the keychain.\n", args[0])
				return nil
			},
		},
		&cobra.Command{
			Use:   "list",
			Short: "List stored key names (never values)",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, args []string) error {
				names := keys.List()
				if len(names) == 0 {
					fmt.Fprintln(a.Out, "No keys stored.")
				}
				for _, n := range names {
					fmt.Fprintln(a.Out, n)
				}
				return nil
			},
		},
		&cobra.Command{
			Use:   "rm <NAME>",
			Short: "Delete a stored key",
			Args:  cobra.ExactArgs(1),
			RunE: func(cmd *cobra.Command, args []string) error {
				if err := keys.Delete(args[0]); err != nil {
					return err
				}
				fmt.Fprintf(a.Out, "Deleted %s.\n", args[0])
				return nil
			},
		},
	)
	return cmd
}

func (a *App) doctorCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check Docker, pipx, Python, keychain and registry access",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			ex := a.Runner.Exec
			ok := true
			check := func(label string, good bool, detail string) {
				mark := "ok  "
				if !good {
					mark = "FAIL"
					ok = false
				}
				fmt.Fprintf(a.Out, "[%s] %-12s %s\n", mark, label, detail)
			}
			if a.Runner.Engine != "" {
				code, _ := ex.Run(cmd.Context(), a.Runner.Engine, []string{"info", "--format", "{{.ServerVersion}}"}, nil, nil, io.Discard, io.Discard)
				check("containers", code == 0, a.Runner.Engine+map[bool]string{true: " is running", false: " is installed but not running; start Docker Desktop"}[code == 0])
			} else {
				check("containers", false, "Docker or Podman not found (needed for Docker tools and sandboxed pipx tools)")
			}
			_, _, hasPipx := runner.FindPipx(ex)
			check("pipx", hasPipx || a.Runner.Engine != "", map[bool]string{true: "found", false: "not found (only needed for --native pipx runs)"}[hasPipx])
			py := "python3"
			if _, err := ex.LookPath(py); err != nil {
				py = "python"
			}
			_, pyerr := ex.LookPath(py)
			check("python", pyerr == nil || a.Runner.Engine != "", map[bool]string{true: "found", false: "not found (only needed for --native pipx runs)"}[pyerr == nil])
			_, cerr := ex.LookPath("cosign")
			check("cosign", true, map[bool]string{true: "found; image signatures are verified", false: "not found; image signatures are skipped locally (optional)"}[cerr == nil])
			kerr := keys.Set("OT_DOCTOR_CHECK", "ok")
			if kerr == nil {
				_ = keys.Delete("OT_DOCTOR_CHECK")
			}
			check("keychain", kerr == nil, map[bool]string{true: "readable and writable", false: fmt.Sprint(kerr)}[kerr == nil])
			_, aerr := a.API.Search(cmd.Context(), api.SearchParams{Limit: 1})
			check("registry", aerr == nil, a.Config.APIURL+map[bool]string{true: " reachable", false: fmt.Sprintf(" unreachable: %v", aerr)}[aerr == nil])
			fmt.Fprintf(a.Out, "\nData directory: %s\n", state.Home())
			if !ok {
				return &ExitError{Code: ExitRuntimeMissing}
			}
			return nil
		},
	}
}
