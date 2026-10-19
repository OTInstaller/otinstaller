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
	var asJSON bool
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
				return err
			}
			if asJSON {
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
	f.BoolVar(&asJSON, "json", false, "print JSON")
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
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "info <namespace/name>",
		Short: "Show a package's inputs, keys, ethics flags and trust status",
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
					return err
				}
				if _, m, err = manifest.ParseJSON(t.Manifest); err != nil {
					return err
				}
			}
			if asJSON {
				return writeJSON(a.Out, map[string]any{"registry": t, "manifest": m})
			}
			printInfo(a.Out, m, t)
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
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
		fmt.Fprintf(w, "Key:     %s (%s) %s\n", s.Name, req, s.URL)
	}
	if e := m.Ethics; e != nil {
		fmt.Fprintf(w, "Ethics:  %s, %s, %s\n",
			yesNo(e.TouchesTarget, "contacts the target", "does not contact the target"),
			yesNo(e.AuthRequired, "logs in to accounts", "does not log in to accounts"),
			yesNo(e.CollectsPersonalData, "collects personal data", "no personal data"))
	}
	fmt.Fprintf(w, "\nRun:     ot run %s %s\n", m.Ref(), exampleArgs(m))
}

func yesNo(b bool, y, n string) string {
	if b {
		return y
	}
	return n
}

func exampleArgs(m *manifest.Manifest) string {
	var parts []string
	for _, in := range m.Inputs {
		if in.Required {
			parts = append(parts, "--"+in.Name+" <"+in.Type+">")
		}
	}
	return strings.Join(parts, " ")
}

func (a *App) installCmd() *cobra.Command {
	var native bool
	cmd := &cobra.Command{
		Use:   "install <namespace/name[@version]>",
		Short: "Install a tool (pulls its image or installs its Python package)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := parseRef(args[0])
			if err != nil {
				return err
			}
			_, err = a.install(cmd.Context(), ref, native)
			return err
		},
	}
	cmd.Flags().BoolVar(&native, "native", false, "install pipx tools on the host instead of in a container")
	return cmd
}

// install resolves, verifies and installs a package, then records it in state.
func (a *App) install(ctx context.Context, ref pkgRef, native bool) (*state.Installed, error) {
	var raw []byte
	var m *manifest.Manifest
	var doc any
	var err error
	opt := runner.InstallOptions{Native: native}

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
		raw = resp.Manifest
		if doc, m, err = manifest.ParseJSON(raw); err != nil {
			return nil, err
		}
		opt.SignerIdentity, opt.SignerIssuer = resp.SignerIdentity, resp.SignerIssuer
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
		_ = a.API.InstallPing(pctx, inst.Ref, inst.Version)
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
			fmt.Fprintf(a.Out, "Uninstalled %s.\n", args[0])
			return nil
		},
	}
}

func writeJSON(w io.Writer, v any) error {
	enc := newJSONEncoder(w)
	return enc.Encode(v)
}
