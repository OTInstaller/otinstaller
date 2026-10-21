package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
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
	// A missing API key is found before the pull, not after it: the registry's manifest says which keys the tool needs.
	if resp, err := a.API.Manifest(cmd.Context(), ref.NS, ref.Name, ref.Version); err == nil && resp.Manifest != nil {
		if _, m, err := manifest.ParseJSON(resp.Manifest); err == nil {
			if _, err := loadSecrets(m); err != nil {
				return nil, err
			}
		}
	}
	if !ra.Yes {
		// Without a terminal, no answer must not mean yes: installing pulls and trusts new code.
		if !a.interactive() {
			return nil, &ExitError{Code: ExitUsage, Reason: "not_installed", Err: fmt.Errorf("%s is not installed; run `ot install %s` first, or pass --yes to install it", ref.Ref(), ref.Ref())}
		}
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
				msg := fmt.Sprintf("%s needs the key %s; set it with `ot keys setup %s` (or `ot keys set %s`)", m.Ref(), s.Name, m.Ref(), s.Name)
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
	var fromEnv string
	set := &cobra.Command{
		Use:   "set <NAME>",
		Short: "Store a key (reads the value from stdin, or --from-env)",
		Long: "Stores a key in the OS keychain. The value is read from stdin (typed, with typing hidden, or piped), or copied from\n" +
			"an environment variable with --from-env. On machines without a keychain (CI, containers), skip this: set an\n" +
			"environment variable of the same name and ot uses it. `ot keys setup` walks through every key your tools need.",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var val string
			if fromEnv != "" {
				val = os.Getenv(fromEnv)
				if val == "" {
					return exitErr(ExitUsage, "%s is not set in the environment", fromEnv)
				}
			} else {
				prompt := ""
				if a.interactive() {
					prompt = fmt.Sprintf("Value for %s (typing is hidden): ", args[0])
				}
				v, err := a.readSecret(bufio.NewReader(a.In), prompt)
				if val = v; val == "" {
					return exitErr(ExitUsage, "no value given: %v", err)
				}
			}
			if err := keys.Set(args[0], val); err != nil {
				return fmt.Errorf("saving %s to the keychain failed: %w; without a keychain, set %s in the environment instead", args[0], err, args[0])
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"name": args[0], "saved": true})
			}
			fmt.Fprintf(a.Out, "Saved %s to the keychain.\n", args[0])
			return nil
		},
	}
	set.Flags().StringVar(&fromEnv, "from-env", "", "copy the value from this environment variable")
	cmd.AddCommand(
		set,
		a.keysSetupCmd(),
		&cobra.Command{
			Use:   "list",
			Short: "List stored key names (never values)",
			Long:  "Lists the keys in the keychain. With --json it also lists the keys installed tools declare, and where each is set.",
			Args:  cobra.NoArgs,
			RunE: func(cmd *cobra.Command, args []string) error {
				names := keys.List()
				if a.jsonMode() {
					return writeJSON(a.Out, a.keyStatus(names))
				}
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
				if a.jsonMode() {
					return writeJSON(a.Out, map[string]any{"name": args[0], "deleted": true})
				}
				fmt.Fprintf(a.Out, "Deleted %s.\n", args[0])
				return nil
			},
		},
	)
	return cmd
}

// keyInfo is one key in `ot keys list --json`. Values are never read out.
type keyInfo struct {
	Name     string   `json:"name"`
	Set      bool     `json:"set"`
	Source   string   `json:"source,omitempty"` // env or keychain; env wins when both are set
	Required []string `json:"required_by,omitempty"`
	Optional []string `json:"optional_for,omitempty"`
}

// keyStatus merges the stored key names with the keys installed tools declare.
func (a *App) keyStatus(stored []string) []keyInfo {
	byName := map[string]*keyInfo{}
	get := func(n string) *keyInfo {
		if byName[n] == nil {
			byName[n] = &keyInfo{Name: n}
		}
		return byName[n]
	}
	for _, n := range stored {
		get(n).Source = "keychain"
	}
	if st, err := state.Load(); err == nil {
		for _, inst := range st.Sorted() {
			if inst.Manifest == nil {
				continue
			}
			for _, s := range inst.Manifest.Secrets {
				k := get(s.Name)
				if s.Required {
					k.Required = append(k.Required, inst.Ref)
				} else {
					k.Optional = append(k.Optional, inst.Ref)
				}
			}
		}
	}
	out := []keyInfo{}
	for _, k := range byName {
		if os.Getenv(k.Name) != "" {
			k.Source = "env"
		}
		k.Set = k.Source != ""
		out = append(out, *k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// doctorCheck is one line of `ot doctor`. A warn doesn't make doctor fail.
type doctorCheck struct {
	Name   string `json:"name"`
	Status string `json:"status"` // ok, warn or fail
	Detail string `json:"detail"`
}

func (a *App) doctorCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "doctor",
		Short: "Check Docker, pipx, Python, keychain and registry access",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			checks := a.doctorChecks(cmd.Context())
			ok := true
			for _, c := range checks {
				ok = ok && c.Status != "fail"
			}
			if a.jsonMode() {
				if err := writeJSON(a.Out, map[string]any{"ok": ok, "checks": checks, "data_dir": state.Home(), "version": Version}); err != nil {
					return err
				}
			} else {
				for _, c := range checks {
					mark := map[string]string{"ok": "ok  ", "warn": "warn", "fail": "FAIL"}[c.Status]
					fmt.Fprintf(a.Out, "[%s] %-12s %s\n", mark, c.Name, c.Detail)
				}
				fmt.Fprintf(a.Out, "\nData directory: %s\n", state.Home())
			}
			if !ok {
				return &ExitError{Code: ExitRuntimeMissing}
			}
			return nil
		},
	}
}

// doctorChecks checks what ot needs: a container engine, pipx and Python for native runs, cosign, the keychain
// and the registry.
func (a *App) doctorChecks(ctx context.Context) []doctorCheck {
	ex := a.Runner.Exec
	var checks []doctorCheck
	check := func(name string, status, detail string) {
		checks = append(checks, doctorCheck{name, status, detail})
	}
	okOr := func(good bool, bad string) string {
		if good {
			return "ok"
		}
		return bad
	}
	if a.Runner.Engine != "" {
		code, _ := ex.Run(ctx, a.Runner.Engine, []string{"info", "--format", "{{.ServerVersion}}"}, nil, nil, io.Discard, io.Discard)
		check("containers", okOr(code == 0, "fail"), a.Runner.Engine+map[bool]string{true: " is running", false: " is installed but not running; start Docker Desktop (or `sudo systemctl start docker` on a Linux server)"}[code == 0])
	} else {
		check("containers", "fail", "Docker or Podman not found; tools run in containers, so install Docker Desktop (https://docs.docker.com/desktop/) or Docker Engine (https://docs.docker.com/engine/install/), then run `ot doctor` again")
	}
	_, _, hasPipx := runner.FindPipx(ex)
	check("pipx", okOr(hasPipx || a.Runner.Engine != "", "fail"), map[bool]string{true: "found", false: "not found (only needed for --native pipx runs)"}[hasPipx])
	py := "python3"
	if _, err := ex.LookPath(py); err != nil {
		py = "python"
	}
	_, pyerr := ex.LookPath(py)
	check("python", okOr(pyerr == nil || a.Runner.Engine != "", "fail"), map[bool]string{true: "found", false: "not found (only needed for --native pipx runs)"}[pyerr == nil])
	_, cerr := ex.LookPath("cosign")
	check("cosign", "ok", map[bool]string{true: "found; image signatures are verified", false: "not found; image signatures are skipped locally (optional)"}[cerr == nil])
	kerr := keys.Set("OT_DOCTOR_CHECK", "ok")
	if kerr == nil {
		_ = keys.Delete("OT_DOCTOR_CHECK")
		check("keychain", "ok", "readable and writable")
	} else {
		// CI and containers have no keychain; keys in environment variables work without one.
		check("keychain", "warn", fmt.Sprintf("%v; pass API keys and OTINSTALLER_TOKEN as environment variables instead", kerr))
	}
	_, aerr := a.API.Search(ctx, api.SearchParams{Limit: 1})
	check("registry", okOr(aerr == nil, "fail"), a.Config.APIURL+map[bool]string{true: " reachable", false: fmt.Sprintf(" unreachable: %v", aerr)}[aerr == nil])
	return checks
}
