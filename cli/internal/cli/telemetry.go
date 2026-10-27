package cli

// `ot telemetry [status|on|off]`: what ot counts, whether it does and why, and turning it on or off. The counting
// itself is in usage.go.

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// telemetryStatus is `ot telemetry --json`.
type telemetryStatus struct {
	Enabled bool `json:"enabled"`
	// Source is what decides it: default, config (config.json's telemetry), OT_NO_TELEMETRY or DO_NOT_TRACK.
	Source     string `json:"source"`
	ConfigPath string `json:"config_path"`
	// Counting is whether this ot counts anything: never a dev build talking to the public registry.
	Counting bool `json:"counting"`
	// Debug is OT_TELEMETRY_DEBUG=1: counts are printed on stderr instead of sent.
	Debug    bool   `json:"debug"`
	Registry string `json:"registry"`
	// Sends lists every field a count can carry; Never, what it never does.
	Sends  []string `json:"sends"`
	Never  []string `json:"never"`
	Policy string   `json:"policy"`
}

// telemetrySends are the fields of api.Install, api.RunCount, api.InstallFailure and api.RunsBody.
var telemetrySends = []string{"tool", "version", "outcome", "duration_ms", "engine", "via", "client", "mcp_client",
	"os", "arch", "ot_version", "from_backup", "first", "reason", "milestones"}

var telemetryNever = []string{"inputs", "targets", "results", "entity values", "file paths", "run ids", "case names",
	"command lines", "keys", "tokens", "account names", "local manifests"}

func onOff(on bool) string { return map[bool]string{true: "on", false: "off"}[on] }

func (a *App) telemetryCmd() *cobra.Command {
	status := func(cmd *cobra.Command, args []string) error { return a.printTelemetry() }
	cmd := &cobra.Command{
		Use:   "telemetry",
		Short: "Show what ot counts, or turn counting on or off",
		Long: "ot counts installs and runs of registry packages so the registry can show which tools are used and which\n" +
			"versions fail: the tool and version, how each run ended and how long it took, the container engine, what\n" +
			"started it, and the OS, architecture and ot version. Never your inputs, targets or results. The registry keeps\n" +
			"daily totals only.\n\n" +
			"`ot telemetry off` stops it, and the offer to report a failed run; so do OT_NO_TELEMETRY=1, DO_NOT_TRACK=1 and\n" +
			"\"telemetry\": false in config.json. OT_TELEMETRY_DEBUG=1 prints each count on stderr instead of sending it.",
		Example: "  ot telemetry\n  ot telemetry off\n  OT_TELEMETRY_DEBUG=1 ot run <tool> ...",
		Args:    cobra.NoArgs,
		RunE:    status,
	}
	cmd.AddCommand(
		&cobra.Command{Use: "status", Short: "Show what ot counts and whether it does (the default)", Args: cobra.NoArgs, RunE: status},
		&cobra.Command{Use: "on", Short: "Count installs and runs (the default)", Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, args []string) error { return a.switchTelemetry(true) }},
		&cobra.Command{Use: "off", Short: "Stop counting installs and runs, and offering to report failed runs", Args: cobra.NoArgs,
			RunE: func(cmd *cobra.Command, args []string) error { return a.switchTelemetry(false) }},
	)
	return cmd
}

// telemetryReport works out the setting from the environment and config.json as written.
func (a *App) telemetryReport() telemetryStatus {
	st := telemetryStatus{Source: "default", ConfigPath: state.Path("config.json"), Debug: os.Getenv("OT_TELEMETRY_DEBUG") == "1",
		Registry: a.API.Base, Sends: telemetrySends, Never: telemetryNever, Policy: privacyURL(a)}
	file := state.FileConfig()
	off, env := state.TelemetryOffByEnv()
	switch {
	case off:
		st.Source = env
	case file.Telemetry != nil:
		st.Source, st.Enabled = "config", *file.Telemetry
	default:
		st.Enabled = true
	}
	st.Counting = st.Enabled && a.counting()
	return st
}

// switchTelemetry turns counting on or off in config.json, and for the rest of this command. On is the default, so
// turning it on removes the key.
func (a *App) switchTelemetry(on bool) error {
	change := map[string]any{"telemetry": nil}
	if !on {
		change["telemetry"] = false
	}
	if err := state.SetConfig(change); err != nil {
		return err
	}
	off, env := state.TelemetryOffByEnv()
	a.Config.Telemetry = nil
	if !on || off {
		f := false
		a.Config.Telemetry = &f
		a.sink().drop()
	}
	a.noticeShown()
	st := a.telemetryReport()
	if a.jsonMode() {
		if on && off {
			fmt.Fprintf(a.Err, "warning: %s is set in your environment and wins over config.json, so telemetry stays off until you unset it\n", env)
		}
		return writeJSON(a.Out, st)
	}
	switch {
	case on && off:
		fmt.Fprintf(a.Out, "Telemetry stays off: %s is set in your environment and wins over config.json. Unset it to turn counting on.\n", env)
	case st.Enabled:
		fmt.Fprintln(a.Out, "Telemetry is on: ot counts installs and runs, never your inputs, targets or results. `ot telemetry` shows exactly what.")
	default:
		fmt.Fprintln(a.Out, "Telemetry is off: ot sends no install or run counts, and doesn't offer to report a failed run. `ot telemetry on` turns it back on.")
	}
	return nil
}

// printTelemetry is `ot telemetry status`. Read at a terminal, it says all the one-time notice would.
func (a *App) printTelemetry() error {
	st := a.telemetryReport()
	if a.jsonMode() {
		return writeJSON(a.Out, st)
	}
	why := map[string]string{"default": "the default", "config": "set in " + st.ConfigPath}[st.Source]
	if why == "" {
		why = st.Source + " is set in your environment"
	}
	fmt.Fprintf(a.Out, "Telemetry is %s (%s).\n\n", onOff(st.Enabled), why)
	if st.Enabled {
		fmt.Fprintln(a.Out, "ot counts each install and run of a registry package: the tool and version, how the run ended and how long\n"+
			"it took, the container engine, what started it (ot run, --all, a playbook, auto or an AI agent, and which agent),\n"+
			"and the OS, architecture and ot version; for installs, whether the registry's backup copy was used, whether it\n"+
			"was this machine's first, and why one failed. Never your inputs, targets, results, file paths, run ids, case\n"+
			"names, command lines, keys or tokens, and nothing from local manifests. The registry keeps daily totals only.")
	} else {
		fmt.Fprintln(a.Out, "ot sends no install or run counts, and doesn't offer to report a failed run.")
	}
	fmt.Fprintln(a.Out)
	switch {
	case st.Enabled && st.Debug:
		fmt.Fprintln(a.Out, "OT_TELEMETRY_DEBUG=1 is set: each count is printed on stderr instead of sent.")
	case st.Enabled && !st.Counting:
		fmt.Fprintln(a.Out, "This is a dev build talking to the public registry, so it counts nothing.")
	}
	if st.Source == "DO_NOT_TRACK" {
		fmt.Fprintln(a.Out, "DO_NOT_TRACK also stops the daily check for newer versions; the check for removed versions stays on.")
	}
	fmt.Fprintf(a.Out, "%s turns it %s; OT_NO_TELEMETRY=1 and DO_NOT_TRACK=1 turn it off too.\nOT_TELEMETRY_DEBUG=1 prints each count on stderr instead of sending it.\nPrivacy policy: %s\n",
		"`ot telemetry "+onOff(!st.Enabled)+"`", onOff(!st.Enabled), st.Policy)
	if st.Enabled && a.interactive() {
		a.noticeShown()
	}
	return nil
}

// telemetryOffNote is what ot start says when an environment variable keeps telemetry off whatever is chosen.
func telemetryOffNote() string {
	if off, env := state.TelemetryOffByEnv(); off {
		return "\n" + env + " is set in your environment, so it stays off whatever you choose here."
	}
	return ""
}
