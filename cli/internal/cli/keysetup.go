package cli

// Guided API key setup: `ot keys setup` walks a person through the keys their tools declare, and keyGuides gives the
// same facts (never values) to `ot mcp`'s key_setup tool. Agents may explain keys and hand the person the command;
// only the person, at a terminal, can store one.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/otinstaller/otinstaller/cli/internal/keys"
	"github.com/otinstaller/otinstaller/cli/internal/manifest"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// keyGuide is one API key a tool declares: what it is, where to get it, what it costs and whether it is set. The
// value is never read out.
type keyGuide struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	URL         string   `json:"url,omitempty" jsonschema:"where to get the key"`
	Pricing     string   `json:"pricing,omitempty" jsonschema:"free, free_tier or paid, when the publisher says"`
	RequiredBy  []string `json:"required_by,omitempty"`
	OptionalFor []string `json:"optional_for,omitempty"`
	Set         bool     `json:"set"`
	Source      string   `json:"source,omitempty" jsonschema:"env or keychain"`
	Command     string   `json:"command" jsonschema:"what the person runs in their own terminal to store this key; it asks for the value with typing hidden"`
}

// keyGuides lists the keys declared by refs (installed tools, else their latest registry release), or by every
// installed tool when refs is empty.
func (a *App) keyGuides(ctx context.Context, refs []string) ([]keyGuide, error) {
	var mans []*manifest.Manifest
	st, err := state.Load()
	if err != nil {
		return nil, err
	}
	if len(refs) == 0 {
		for _, inst := range st.Sorted() {
			if inst.Manifest != nil {
				mans = append(mans, inst.Manifest)
			}
		}
	}
	for _, r := range refs {
		ref, err := parseRef(r)
		if err != nil {
			return nil, err
		}
		if ref.LocalPath != "" {
			_, m, err := manifest.LoadFile(ref.LocalPath)
			if err != nil {
				return nil, err
			}
			mans = append(mans, m)
			continue
		}
		if inst := st.Installed[ref.Ref()]; inst != nil && inst.Manifest != nil && ref.Version == "" {
			mans = append(mans, inst.Manifest)
			continue
		}
		resp, err := a.API.Manifest(ctx, ref.NS, ref.Name, orDefault(ref.Version, "latest"))
		if err != nil {
			return nil, a.requestError(err)
		}
		_, m, _, err := registryManifest(resp)
		if err != nil {
			return nil, err
		}
		mans = append(mans, m)
	}
	byName := map[string]*keyGuide{}
	for _, m := range mans {
		for _, s := range m.Secrets {
			g := byName[s.Name]
			if g == nil {
				g = &keyGuide{Name: s.Name, Command: "ot keys set " + s.Name}
				byName[s.Name] = g
			}
			g.Description = orDefault(g.Description, s.Description)
			g.URL = orDefault(g.URL, s.URL)
			g.Pricing = orDefault(g.Pricing, s.Pricing)
			if s.Required {
				g.RequiredBy = append(g.RequiredBy, m.Ref())
			} else {
				g.OptionalFor = append(g.OptionalFor, m.Ref())
			}
		}
	}
	stored := map[string]bool{}
	for _, n := range keys.List() {
		stored[n] = true
	}
	out := []keyGuide{}
	for _, g := range byName {
		switch {
		case os.Getenv(g.Name) != "":
			g.Source = "env"
		case stored[g.Name]:
			g.Source = "keychain"
		}
		g.Set = g.Source != ""
		out = append(out, *g)
	}
	// Required keys first, then by name.
	sort.Slice(out, func(i, j int) bool {
		if (len(out[i].RequiredBy) > 0) != (len(out[j].RequiredBy) > 0) {
			return len(out[i].RequiredBy) > 0
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// errNeedsTerminal refuses key entry without a person at a terminal: scripts and agents can't store keys this way.
var errNeedsTerminal = &ExitError{Code: ExitUsage, Reason: "needs_terminal",
	Err: errors.New("`ot keys setup` needs a person at a terminal; run it in your own terminal (agents and scripts can't store keys with it; in CI, set the key as an environment variable)")}

// readSecret reads one value with typing hidden at a real terminal; elsewhere (tests) it reads a line from r.
func (a *App) readSecret(r *bufio.Reader, prompt string) (string, error) {
	fmt.Fprint(a.Err, prompt)
	if f, ok := a.In.(*os.File); ok && term.IsTerminal(int(f.Fd())) {
		b, err := term.ReadPassword(int(f.Fd()))
		fmt.Fprintln(a.Err)
		return strings.TrimSpace(string(b)), err
	}
	line, err := r.ReadString('\n')
	if err == io.EOF && line != "" {
		err = nil
	}
	return strings.TrimSpace(line), err
}

func (a *App) keysSetupCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "setup [tool...]",
		Short: "Walk through the API keys your tools need, and store them",
		Long: "For each API key the named tools declare (or every installed tool's, with no names), shows what it is, where to\n" +
			"get it and what it costs, offers to open the sign-up page, and asks for the value with typing hidden. Keys that\n" +
			"are already set are skipped unless --all is given. It needs a terminal: agents can hand you this command, but\n" +
			"only you can type a key into it.",
		RunE: func(cmd *cobra.Command, args []string) error {
			if !a.interactive() {
				return errNeedsTerminal
			}
			return a.setupKeys(cmd.Context(), args, all)
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "also ask for keys that are already set, to replace them")
	return cmd
}

// setupKeys walks a person at a terminal through the keys refs declare (every installed tool's when refs is empty),
// for `ot keys setup` and `ot start --keys`. With all, keys already set are asked for again.
func (a *App) setupKeys(ctx context.Context, refs []string, all bool) error {
	guides, err := a.keyGuides(ctx, refs)
	if err != nil {
		return err
	}
	if len(guides) == 0 {
		fmt.Fprintln(a.Out, "None of these tools needs an API key.")
		return nil
	}
	in := bufio.NewReader(a.In)
	saved, skipped := 0, 0
	for _, g := range guides {
		fmt.Fprintf(a.Out, "\n%s", g.Name)
		if len(g.RequiredBy) > 0 {
			fmt.Fprintf(a.Out, " (needed by %s)", strings.Join(g.RequiredBy, ", "))
		} else {
			fmt.Fprintf(a.Out, " (optional, used by %s)", strings.Join(g.OptionalFor, ", "))
		}
		fmt.Fprintln(a.Out)
		if g.Description != "" {
			fmt.Fprintf(a.Out, "  %s\n", g.Description)
		}
		if g.Pricing != "" {
			fmt.Fprintf(a.Out, "  Cost: %s\n", strings.ReplaceAll(g.Pricing, "_", " "))
		}
		if g.Set && !all {
			fmt.Fprintf(a.Out, "  Already set (%s); skipped.\n", g.Source)
			continue
		}
		if g.Source == "env" {
			fmt.Fprintf(a.Out, "  Note: %s is set in the environment, which wins over the keychain.\n", g.Name)
		}
		if g.URL != "" {
			fmt.Fprintf(a.Out, "  Get one at %s\n", g.URL)
			ans, err := a.readLine(in, "  Open it in your browser? [y/N] ")
			if err != nil {
				return err
			}
			if strings.EqualFold(ans, "y") || strings.EqualFold(ans, "yes") {
				if err := a.OpenURL(g.URL); err != nil {
					fmt.Fprintf(a.Err, "warning: couldn't open the browser: %v\n", err)
				}
			}
		}
		val, err := a.readSecret(in, "  Paste the key (typing is hidden; Enter to skip): ")
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if val == "" {
			skipped++
			fmt.Fprintln(a.Out, "  Skipped.")
			continue
		}
		if err := keys.Set(g.Name, val); err != nil {
			return fmt.Errorf("saving %s to the keychain failed: %w; without a keychain, set %s in the environment instead", g.Name, err, g.Name)
		}
		saved++
		fmt.Fprintf(a.Out, "  Saved %s to the keychain.\n", g.Name)
	}
	fmt.Fprintf(a.Out, "\nDone: %d saved, %d skipped. `ot keys list` shows what is set.\n", saved, skipped)
	return nil
}

// readLine prints prompt on stderr and reads one line from r.
func (a *App) readLine(r *bufio.Reader, prompt string) (string, error) {
	fmt.Fprint(a.Err, prompt)
	line, err := r.ReadString('\n')
	if err == io.EOF {
		err = nil
	}
	return strings.TrimSpace(line), err
}
