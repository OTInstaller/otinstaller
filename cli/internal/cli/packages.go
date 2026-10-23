package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// pkgRef is "namespace/name[@version]" or a path to a local manifest.
type pkgRef struct {
	NS, Name, Version string
	LocalPath         string
}

func (r pkgRef) Ref() string { return r.NS + "/" + r.Name }

func parseRef(s string) (pkgRef, error) {
	if strings.HasSuffix(s, ".yaml") || strings.HasSuffix(s, ".yml") || strings.HasPrefix(s, ".") || strings.ContainsAny(s, `\`) {
		if fi, err := os.Stat(s); err == nil {
			if fi.IsDir() {
				s = filepath.Join(s, manifest.FileName)
			}
			return pkgRef{LocalPath: s}, nil
		}
	}
	ref, ver, _ := strings.Cut(s, "@")
	ns, name, ok := strings.Cut(ref, "/")
	if !ok || ns == "" || name == "" || strings.Contains(name, "/") {
		return pkgRef{}, &runner.UsageError{Msg: fmt.Sprintf("%q is not a package; use namespace/name[@version] or a path to otinstaller.yaml", s)}
	}
	return pkgRef{NS: ns, Name: name, Version: ver}, nil
}

func (a *App) searchCmd() *cobra.Command {
	var p api.SearchParams
	cmd := &cobra.Command{
		Use:   "search [query]",
		Short: "Search the registry",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 1 {
				p.Query = args[0]
			}
			res, err := a.API.Search(cmd.Context(), p)
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, res)
			}
			if len(res.Results) == 0 {
				fmt.Fprintln(a.Out, "No packages found.")
				return nil
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "PACKAGE\tVERSION\tINPUTS\tSUMMARY")
			for _, t := range res.Results {
				fmt.Fprintf(tw, "%s/%s\t%s\t%s\t%s%s\n", t.Namespace, t.Name, t.LatestVersion,
					strings.Join(t.Inputs, ","), truncate(t.Summary, 60), badges(t))
			}
			return tw.Flush()
		},
	}
	f := cmd.Flags()
	f.StringVar(&p.Input, "input", "", "only packages that accept this input type")
	f.StringVar(&p.Output, "output", "", "only packages that produce this entity type")
	f.StringVar(&p.Category, "category", "", "only this category")
	f.StringVar(&p.Runtime, "runtime", "", "docker or pipx")
	f.StringVar(&p.Kind, "kind", "", "tool or guide")
	f.BoolVar(&p.NoKeys, "no-keys", false, "only packages that need no API keys")
	f.IntVar(&p.Limit, "limit", 25, "maximum results")
	return cmd
}

func badges(t api.ToolSummary) string {
	var b []string
	if t.Health == "broken" {
		b = append(b, "possibly broken")
	}
	if t.Status == "deprecated" {
		b = append(b, "deprecated")
	}
	if t.ManifestHeld {
		b = append(b, "manifest held by registry")
	}
	if len(b) == 0 {
		return ""
	}
	return " [" + strings.Join(b, ", ") + "]"
}

func truncate(s string, n int) string {
	if len([]rune(s)) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

func (a *App) infoCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "info <namespace/name>",
		Short: "Show a package's inputs, keys, ethics flags, trust status and what's new",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := parseRef(args[0])
			if err != nil {
				return err
			}
			var m *manifest.Manifest
			var t *api.ToolDetail
			if ref.LocalPath != "" {
				if _, m, err = manifest.LoadFile(ref.LocalPath); err != nil {
					return err
				}
			} else {
				if t, err = a.API.Tool(cmd.Context(), ref.NS, ref.Name); err != nil {
					return a.requestError(err)
				}
				if _, m, err = manifest.ParseJSON(t.Manifest); err != nil {
					return err
				}
			}
			// What changed in this version, for registry packages that have release notes.
			var notes *api.Version
			if t != nil {
				notes = a.whatsNew(cmd.Context(), ref.NS, ref.Name, m.Version)
			}
			if a.jsonMode() {
				out := map[string]any{"registry": t, "manifest": m, "changelog": nil}
				if notes != nil {
					out["changelog"] = cleanNotes(notes.Changelog)
				}
				return writeJSON(a.Out, out)
			}
			printInfo(a.Out, m, t)
			if notes != nil {
				fmt.Fprintf(a.Out, "\nWhat's new in ")
				printRelease(a.Out, *notes, whatsNewLines)
				fmt.Fprintf(a.Out, "  (all notes: `ot changelog %s`)\n", m.Ref())
			}
			return nil
		},
	}
	return cmd
}

func printInfo(w io.Writer, m *manifest.Manifest, t *api.ToolDetail) {
	fmt.Fprintf(w, "%s %s (%s)\n%s\n\n", m.Ref(), m.Version, describeKind(m), m.Summary)
	if t != nil {
		var trust []string
		if t.Verified {
			trust = append(trust, "verified publisher")
		}
		if t.Signed {
			trust = append(trust, "signed")
		}
		if t.ManifestHeld {
			trust = append(trust, "manifest held by registry")
		}
		if t.CommunityWrap {
			trust = append(trust, "community-packaged")
		}
		trust = append(trust, "health: "+orDefault(t.Health, "not checked"))
		fmt.Fprintf(w, "Trust:   %s\n", strings.Join(trust, ", "))
		if t.DeprecatedMsg != "" {
			fmt.Fprintf(w, "Deprecated: %s\n", t.DeprecatedMsg)
		}
	}
	fmt.Fprintf(w, "License: %s\n", m.License)
	if m.IsGuide() {
		fmt.Fprintf(w, "Level:   %s\nTools:   %s\n", m.Level, strings.Join(m.RelatedTools, ", "))
		return
	}
	fmt.Fprintln(w, "Inputs:")
	for _, in := range m.Inputs {
		req := "optional"
		if in.Required {
			req = "required"
		}
		fmt.Fprintf(w, "  --%s (%s, %s)\n", in.Name, in.Type, req)
	}
	var outs []string
	for _, o := range m.Outputs {
		outs = append(outs, o.Type)
	}
	fmt.Fprintf(w, "Outputs: %s\n", strings.Join(outs, ", "))
	for _, s := range m.Secrets {
		req := "optional"
		if s.Required {
			req = "required"
		}
		where := ""
		if s.URL != "" {
			where = " (get one at " + s.URL + ")"
		}
		fmt.Fprintf(w, "Key:     %s (%s): set it with `ot keys set %s`%s\n", s.Name, req, s.Name, where)
	}
	if e := m.Ethics; e != nil {
		fmt.Fprintf(w, "Ethics:  %s, %s, %s\n",
			yesNo(e.TouchesTarget, "contacts the target", "does not contact the target"),
			yesNo(e.AuthRequired, "logs in to accounts", "does not log in to accounts"),
			yesNo(e.CollectsPersonalData, "collects personal data", "no personal data"))
	}
	if m.Test != nil && len(m.Test.Input) > 0 {
		fmt.Fprintf(w, "\nRun:     %s\n         (the registry's own test input; the first run installs the tool after asking once)\n", runner.ExampleCommand(m))
	} else {
		fmt.Fprintf(w, "\nRun:     %s\n", runner.ExampleCommand(m))
	}
}

func yesNo(b bool, y, n string) string {
	if b {
		return y
	}
	return n
}

func (a *App) installCmd() *cobra.Command {
	var native bool
	cmd := &cobra.Command{
		Use:   "install <namespace/name[@version]> ...",
		Short: "Install tools (pulls their images or installs their Python packages)",
		Long: "Installs one or more tools, one after another. Every name is checked before anything is installed, so a typo\n" +
			"installs nothing. When Docker or Podman is missing, ot stops at the first tool and exits 5.",
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var refs []pkgRef
			seen := map[string]bool{}
			for _, arg := range args {
				ref, err := parseRef(arg)
				if err != nil {
					return err
				}
				if !seen[arg] {
					seen[arg] = true
					refs = append(refs, ref)
				}
			}
			res, err := a.installMany(cmd.Context(), refs, native)
			if a.jsonMode() {
				if len(res) == 1 {
					if res[0].inst == nil {
						return err
					}
					return writeJSON(a.Out, installOutput{recordOf(res[0].inst), res[0].Example, res[0].MissingKeys})
				}
				if werr := writeJSON(a.Out, res); werr != nil {
					return werr
				}
				return err
			}
			a.printInstallHints(res)
			return err
		},
	}
	cmd.Flags().BoolVar(&native, "native", false, "install pipx tools on the host instead of in a container")
	return cmd
}

// printInstallHints says on stderr how to try what was just installed, and which keys to set first.
func (a *App) printInstallHints(res []*installResult) {
	var tries, needs []string
	for _, r := range res {
		if r.inst == nil || r.Example == "" {
			continue
		}
		tries = append(tries, r.Example)
		if len(r.MissingKeys) > 0 {
			needs = append(needs, fmt.Sprintf("Needs %s: run `ot keys setup %s` to set %s",
				map[bool]string{true: "a key", false: "keys"}[len(r.MissingKeys) == 1], r.Ref, strings.Join(r.MissingKeys, " and ")))
		}
	}
	switch len(tries) {
	case 0:
		return
	case 1:
		fmt.Fprintf(a.Err, "Try it: %s\n", tries[0])
	default:
		fmt.Fprintf(a.Err, "Try them:\n  %s\n", strings.Join(tries, "\n  "))
	}
	for _, n := range needs {
		fmt.Fprintln(a.Err, n)
	}
}

// installOutput is `ot install --json` for one package: the install record, a command to try it with, and the
// required keys it still needs.
type installOutput struct {
	installRecord
	Example     string   `json:"example,omitempty"`
	MissingKeys []string `json:"missing_keys,omitempty"`
}

// installResult is one package of a batch install, as `ot install a b --json` lists them.
type installResult struct {
	Ref         string   `json:"ref"`
	Status      string   `json:"status"` // installed, failed, or not_tried after Docker or Podman was found missing
	Version     string   `json:"version,omitempty"`
	Example     string   `json:"example,omitempty"`
	MissingKeys []string `json:"missing_keys,omitempty"`
	Error       string   `json:"error,omitempty"`
	ExitCode    int      `json:"exit_code,omitempty"`
	inst        *state.Installed
}

// installMany installs packages one after another, for `ot install`, `ot guide tools` and `ot playbook -y`. A
// failure doesn't stop the rest, except a missing container engine (exit 5), which every other install would hit too.
// With one package the error is that install's own; with several it says how many failed and exits with their common
// code, or 1 when the codes differ.
func (a *App) installMany(ctx context.Context, refs []pkgRef, native bool) ([]*installResult, error) {
	var res []*installResult
	var failed []string
	var first error
	codes, reasons := map[int]bool{}, map[string]bool{}
	for i, ref := range refs {
		name := ref.Ref()
		if ref.LocalPath != "" {
			name = ref.LocalPath
		}
		r := &installResult{Ref: name}
		res = append(res, r)
		inst, err := a.install(ctx, ref, native)
		if err == nil {
			r.Status, r.Version, r.inst = "installed", inst.Version, inst
			if inst.Manifest != nil {
				r.Ref, r.Example, r.MissingKeys = inst.Ref, runner.ExampleCommand(inst.Manifest), missingKeys(inst.Manifest)
			}
			continue
		}
		code := ExitCodeFor(err)
		r.Status, r.Error, r.ExitCode = "failed", err.Error(), code
		failed = append(failed, name)
		codes[code], reasons[errorCode(err, code)] = true, true
		if first == nil {
			first = err
		}
		if len(refs) > 1 && !a.jsonMode() {
			fmt.Fprintf(a.Err, "error: %s: %v\n", name, err)
		}
		var rm *runner.RuntimeMissingError
		if errors.As(err, &rm) {
			for _, rest := range refs[i+1:] {
				n := rest.Ref()
				if rest.LocalPath != "" {
					n = rest.LocalPath
				}
				res = append(res, &installResult{Ref: n, Status: "not_tried"})
			}
			break
		}
	}
	switch {
	case len(failed) == 0:
		return res, nil
	case len(refs) == 1:
		return res, first
	}
	e := &ExitError{Code: ExitToolError, Err: fmt.Errorf("%d of %d failed to install: %s", len(failed), len(refs), strings.Join(failed, ", "))}
	if len(codes) == 1 {
		for c := range codes {
			e.Code = c
		}
		if len(reasons) == 1 {
			for r := range reasons {
				e.Reason = r
			}
		}
	}
	return res, e
}

// install resolves, verifies and installs a package, then records it in state.
func (a *App) install(ctx context.Context, ref pkgRef, native bool) (*state.Installed, error) {
	var raw []byte
	var m *manifest.Manifest
	var doc any
	var err error
	opt := runner.InstallOptions{Native: native}

	if ref.LocalPath != "" && a.AgentMode {
		return nil, &ExitError{Code: ExitTrust, Reason: "trust_refused", Err: fmt.Errorf("agents may only install published packages, not a local manifest (%s); use `ot validate --smoke` in a terminal to test one", ref.LocalPath)}
	}
	if ref.LocalPath != "" {
		raw, err = os.ReadFile(ref.LocalPath)
		if err != nil {
			return nil, err
		}
		if doc, m, err = manifest.Parse(raw); err != nil {
			return nil, err
		}
		// State stores manifests as JSON, the same shape the registry serves.
		if raw, err = json.Marshal(doc); err != nil {
			return nil, err
		}
		fmt.Fprintf(a.Err, "note: installing from a local manifest; signatures are not checked\n")
	} else {
		resp, err := a.API.Manifest(ctx, ref.NS, ref.Name, ref.Version)
		if err != nil {
			if ae, ok := isRemoved(err); ok {
				return nil, exitErr(ExitTrust, "%s", ae.Message)
			}
			var ae *api.Error
			if errors.As(err, &ae) && ae.Status == 404 {
				return nil, exitErr(ExitUsage, "%s not found in the registry", ref.Ref())
			}
			return nil, err
		}
		if resp.Status == "removed" {
			return nil, exitErr(ExitTrust, "%s@%s was removed from the registry: %s", ref.Ref(), resp.Version, resp.RemovedReason)
		}
		if resp.MovedTo != "" {
			fmt.Fprintf(a.Err, "note: %s has moved to %s\n", ref.Ref(), resp.MovedTo)
		}
		if doc, m, raw, err = registryManifest(resp); err != nil {
			return nil, err
		}
		opt.SignerIdentity, opt.SignerIssuer = resp.SignerIdentity, resp.SignerIssuer
		opt.MirrorImage, opt.WheelBackupURL = resp.MirrorImage, resp.WheelURL
		// An agent gets no "warning:" it can scroll past: what a person would be warned about, it is refused.
		if a.AgentMode {
			opt.RequireSignature = true
			switch {
			case resp.Status == "yanked":
				return nil, &ExitError{Code: ExitTrust, Reason: "trust_refused", Err: fmt.Errorf("%s@%s is yanked; agents may only install current versions", ref.Ref(), resp.Version)}
			case resp.ScanStatus == "fail":
				return nil, &ExitError{Code: ExitTrust, Reason: "trust_refused", Err: fmt.Errorf("%s@%s failed its security scan", ref.Ref(), resp.Version)}
			case resp.Health == "broken":
				return nil, &ExitError{Code: ExitTrust, Reason: "trust_refused", Err: fmt.Errorf("%s is marked possibly broken by recent health checks", ref.Ref())}
			}
		}
		for _, w := range trustWarnings(resp) {
			fmt.Fprintln(a.Err, "warning:", w)
		}
	}
	if ps := manifest.Validate(doc, m, manifest.Options{}); len(ps) > 0 {
		return nil, exitErr(ExitTrust, "manifest for %s is invalid: %s", m.Ref(), ps[0].Error())
	}
	fmt.Fprintf(a.Err, "Installing %s %s (%s)…\n", m.Ref(), m.Version, describeKind(m))
	inst, err := a.Runner.Install(ctx, m, raw, opt)
	if err != nil {
		return nil, err
	}
	st, err := state.Load()
	if err != nil {
		return nil, err
	}
	st.Installed[inst.Ref] = inst
	if err := st.Save(); err != nil {
		return nil, err
	}
	if ref.LocalPath == "" && a.Config.TelemetryEnabled() {
		pctx, cancel := context.WithTimeout(ctx, 3*time.Second)
		_ = a.API.InstallPing(pctx, inst.Ref, inst.Version, a.clientKind())
		cancel()
	}
	fmt.Fprintf(a.Err, "Installed %s %s.\n", inst.Ref, inst.Version)
	return inst, nil
}

func trustWarnings(r *api.ManifestResponse) []string {
	var w []string
	if r.SignerIdentity == "" {
		w = append(w, r.Ref+" is not signed")
	}
	if r.ScanStatus == "warn" {
		w = append(w, r.Ref+" has scan warnings (see its security page)")
	}
	if r.Health == "broken" {
		w = append(w, r.Ref+" is marked possibly broken by recent health checks")
	}
	if !r.Verified {
		w = append(w, "the publisher of "+r.Ref+" is not verified")
	}
	if r.SourceGone {
		w = append(w, "the source repository of "+r.Ref+" is no longer available; it will get no new versions")
	}
	return w
}

func (a *App) listCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "list",
		Short: "List installed packages",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := state.Load()
			if err != nil {
				return err
			}
			if a.jsonMode() {
				recs := []installRecord{}
				for _, i := range st.Sorted() {
					recs = append(recs, recordOf(i))
				}
				return writeJSON(a.Out, recs)
			}
			if len(st.Installed) == 0 {
				fmt.Fprintln(a.Out, "Nothing installed yet. Try `ot search`.")
				return nil
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "PACKAGE\tVERSION\tRUNTIME\tINSTALLED")
			for _, i := range st.Sorted() {
				rt := i.Runtime
				if i.Native {
					rt += " (native)"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", i.Ref, i.Version, rt, i.InstalledAt.Format("2006-01-02"))
			}
			return tw.Flush()
		},
	}
}

func (a *App) uninstallCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "uninstall <namespace/name>",
		Short: "Remove an installed package",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			st, err := state.Load()
			if err != nil {
				return err
			}
			inst, ok := st.Installed[args[0]]
			if !ok {
				return exitErr(ExitUsage, "%s is not installed", args[0])
			}
			_ = a.Runner.Uninstall(cmd.Context(), inst)
			delete(st.Installed, args[0])
			if err := st.Save(); err != nil {
				return err
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"ref": inst.Ref, "version": inst.Version, "uninstalled": true})
			}
			fmt.Fprintf(a.Out, "Uninstalled %s.\n", args[0])
			return nil
		},
	}
}

// installRecord is an installed package in `ot install --json` and `ot list --json`.
type installRecord struct {
	Ref         string    `json:"ref"`
	Version     string    `json:"version"`
	Runtime     string    `json:"runtime"`
	Native      bool      `json:"native"`
	Artifact    string    `json:"artifact"`
	Signer      string    `json:"signer,omitempty"`
	FromBackup  bool      `json:"from_backup"`
	InstalledAt time.Time `json:"installed_at"`
}

func recordOf(i *state.Installed) installRecord {
	return installRecord{i.Ref, i.Version, i.Runtime, i.Native, i.Artifact, i.Signer, i.FromBackup, i.InstalledAt}
}

func writeJSON(w io.Writer, v any) error {
	enc := newJSONEncoder(w)
	return enc.Encode(v)
}

// registryManifest picks the manifest to install from a registry answer: the full one when this ot's schema accepts
// it, else the one limited to the fields every ot since v0.12 knows. The registry adds optional fields over time
// (examples, output attributes, notifies_target), and an older ot refuses a manifest with fields it doesn't know.
func registryManifest(resp *api.ManifestResponse) (any, *manifest.Manifest, json.RawMessage, error) {
	if len(resp.ManifestFull) > 0 && string(resp.ManifestFull) != "null" {
		if doc, m, err := manifest.ParseJSON(resp.ManifestFull); err == nil && len(manifest.Validate(doc, m, manifest.Options{})) == 0 {
			return doc, m, resp.ManifestFull, nil
		}
	}
	doc, m, err := manifest.ParseJSON(resp.Manifest)
	return doc, m, resp.Manifest, err
}
