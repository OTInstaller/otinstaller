package cli

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/share"
)

// `ot share` puts saved runs on a link that works for 24 hours (<site>/r/<id>); `ot shares` lists and deletes them.
// The upload is built by the share package; the registry's side is api/src/shares.ts.

func (a *App) shareCmd() *cobra.Command {
	var caseName string
	var anonymous, yes, dryRun bool
	cmd := &cobra.Command{
		Use:   "share [run-id | saved file]...",
		Short: "Share saved runs as a link that works for 24 hours",
		Long: "Uploads saved runs to the registry and prints a link on otinstaller.com that anyone who has it can open for 24\n" +
			"hours. The page shows each run's inputs and everything the tool found, as saved; it never shows who shared it.\n" +
			"File paths, the case name, the command line and the run id stay on this machine.\n\n" +
			"Name runs by id (`ot runs` lists them) or saved file, or share a whole case with --case. When ot is signed in\n" +
			"the share is linked to your account, which only you can see, so `ot shares` and otinstaller.com/settings/shares\n" +
			"list it; --anonymous leaves your account out. Either way `ot shares rm` deletes it before the 24 hours are up.",
		Example: "  ot share 3f9a1c2e\n  ot share --case acme --yes\n  ot share 3f9a1c2e 77b0e1d4 --anonymous\n  ot share 3f9a1c2e --dry-run",
		RunE: func(cmd *cobra.Command, args []string) error {
			runs, err := collectSaved(args, caseName, true)
			if err != nil {
				return usageFromTool(err)
			}
			p, err := buildShare(runs)
			if err != nil {
				return err
			}
			body, err := share.Encode(p)
			if err != nil {
				return &ExitError{Code: ExitUsage, Reason: "share_too_large", Err: err}
			}
			if dryRun {
				return writeJSON(a.Out, p)
			}
			owned := a.API.Token != "" && !anonymous
			if !yes {
				if !a.interactive() {
					return needsInput("sharing results puts them on the web, so it asks first", "--yes")
				}
				fmt.Fprintf(a.Err, "%s\n  - %s\nShare? [y/N] ", shareQuestion(p), strings.Join(shareDetails(owned), "\n  - "))
				line, _ := bufio.NewReader(a.In).ReadString('\n')
				if ans := strings.ToLower(strings.TrimSpace(line)); ans != "y" && ans != "yes" {
					fmt.Fprintln(a.Err, "Nothing was shared.")
					return nil
				}
			}
			made, err := a.API.CreateShare(cmd.Context(), body, !owned)
			if err != nil {
				return a.requestError(err)
			}
			a.rememberShare(made)
			if a.jsonMode() {
				return writeJSON(a.Out, made)
			}
			fmt.Fprintf(a.Out, "Shared %s: %s\n", plural(made.Runs, "run", "runs"), made.URL)
			fmt.Fprintf(a.Out, "The link works until %s. Delete it sooner with `ot shares rm %s`.\n", whenLocal(made.ExpiresAt), made.ID)
			return nil
		},
	}
	fl := cmd.Flags()
	fl.StringVar(&caseName, "case", "", "share every saved run in this case")
	fl.BoolVar(&anonymous, "anonymous", false, "don't link the share to your account, even when signed in")
	fl.BoolVarP(&yes, "yes", "y", false, "share without asking (needed without a terminal)")
	fl.BoolVar(&dryRun, "dry-run", false, "print what would be uploaded, and upload nothing")
	return cmd
}

func (a *App) sharesCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "shares",
		Short: "List your shared links that still work",
		Long: "Lists the links `ot share` made on this machine that still work, and, when ot is signed in, every share linked\n" +
			"to your account. `ot shares rm` deletes one before its 24 hours are up.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			list, err := a.listShares(cmd)
			if err != nil {
				return err
			}
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"shares": list})
			}
			if len(list) == 0 {
				fmt.Fprintln(a.Out, "No shared links that still work. `ot share <run-id>` makes one.")
				return nil
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "ID\tEXPIRES\tTOOLS\tURL")
			for _, s := range list {
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", s.ID, "in "+left(s.ExpiresAt), truncate(strings.Join(s.Tools, ", "), 40), s.URL)
			}
			return tw.Flush()
		},
	}
	cmd.AddCommand(&cobra.Command{
		Use:   "rm <id | link>",
		Short: "Delete a shared link before it expires",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			id := shareID(args[0])
			token := ""
			if saved, _ := share.Load(); saved != nil {
				for _, s := range saved {
					if s.ID == id {
						token = s.DeleteToken
					}
				}
			}
			if token == "" && a.API.Token == "" {
				return &ExitError{Code: ExitUsage, Reason: "share_forbidden", Err: fmt.Errorf("no delete token for %s on this machine", id),
					Hint: "sign in as the account that shared it (`ot login`), or run this where it was shared"}
			}
			err := a.API.DeleteShare(cmd.Context(), id, token)
			var ae *api.Error
			gone := errors.As(err, &ae) && ae.Code == "share_not_found"
			if err != nil && !gone {
				return a.requestError(err)
			}
			_ = share.Forget(id)
			if a.jsonMode() {
				return writeJSON(a.Out, map[string]any{"id": id, "deleted": !gone})
			}
			if gone {
				fmt.Fprintf(a.Out, "%s was already deleted or has expired.\n", id)
			} else {
				fmt.Fprintf(a.Out, "Deleted %s; the link no longer works.\n", id)
			}
			return nil
		},
	})
	return cmd
}

// listedShare is a row of `ot shares`: delete tokens are never printed.
type listedShare struct {
	ID        string   `json:"id"`
	URL       string   `json:"url"`
	CreatedAt int64    `json:"created_at"`
	ExpiresAt int64    `json:"expires_at"`
	Tools     []string `json:"tools"`
	// Owned shares are linked to the signed-in account; Here ones can be deleted from this machine without it.
	Owned bool `json:"owned"`
	Here  bool `json:"here"`
}

// listShares merges this machine's record with the signed-in account's shares, newest first.
func (a *App) listShares(cmd *cobra.Command) ([]listedShare, error) {
	saved, err := share.Load()
	if err != nil {
		return nil, err
	}
	list := []listedShare{}
	seen := map[string]int{}
	for _, s := range saved {
		seen[s.ID] = len(list)
		list = append(list, listedShare{ID: s.ID, URL: s.URL, CreatedAt: s.CreatedAt, ExpiresAt: s.ExpiresAt, Tools: shortTools(s.Tools), Owned: s.Owned, Here: true})
	}
	if a.API.Token != "" {
		mine, err := a.API.MyShares(cmd.Context())
		if err != nil {
			fmt.Fprintf(a.Err, "warning: could not list your account's shares: %v\n", err)
		}
		for _, m := range mine {
			if i, ok := seen[m.ID]; ok {
				list[i].Owned = true
				continue
			}
			list = append(list, listedShare{ID: m.ID, URL: m.URL, CreatedAt: m.CreatedAt, ExpiresAt: m.ExpiresAt, Tools: shortTools(m.Tools), Owned: true})
		}
	}
	for i := 1; i < len(list); i++ {
		for j := i; j > 0 && list[j].CreatedAt > list[j-1].CreatedAt; j-- {
			list[j], list[j-1] = list[j-1], list[j]
		}
	}
	return list, nil
}

func (a *App) rememberShare(made *api.ShareCreated) {
	err := share.Remember(share.Saved{ID: made.ID, URL: made.URL, DeleteToken: made.DeleteToken, CreatedAt: made.CreatedAt, ExpiresAt: made.ExpiresAt,
		Tools: made.Tools, Owned: made.Owned})
	if err != nil {
		fmt.Fprintf(a.Err, "warning: could not record the share's delete token (%v); delete it with `ot shares rm %s` while signed in, or wait for it to expire\n", err, made.ID)
	}
}

// collectSaved finds the saved runs to share: by run id, by saved file (only when paths is set, which `ot mcp`
// doesn't), and every run in a case. Each run is taken once, in the order named.
func collectSaved(refs []string, caseName string, paths bool) ([]*savedRun, error) {
	var out []*savedRun
	seen := map[string]bool{}
	add := func(r *savedRun) {
		if !seen[r.output] {
			seen[r.output] = true
			out = append(out, r)
		}
	}
	for _, ref := range refs {
		ref = strings.TrimSpace(ref)
		if paths {
			if _, err := os.Stat(ref); err == nil {
				r := savedFile(ref)
				if r == nil {
					return nil, &toolError{Code: "run_not_found", Message: ref + " is not a saved run with a .meta.json sidecar"}
				}
				add(r)
				continue
			}
		}
		r, err := findSavedRun(ref)
		if err != nil {
			return nil, err
		}
		add(r)
	}
	if caseName != "" {
		n := len(out)
		var looked []string
		for _, dir := range resultDirs() {
			folder := filepath.Join(dir, "cases", results.Sanitize(caseName))
			looked = append(looked, folder)
			files, _ := results.Outputs(folder)
			for _, f := range files {
				if m := results.MetaFor(f); m != nil {
					add(&savedRun{f, m})
				}
			}
		}
		if len(out) == n {
			return nil, &toolError{Code: "run_not_found", Message: "no saved runs in case " + caseName + " (looked in " + strings.Join(looked, " and ") + ")"}
		}
	}
	if len(out) == 0 {
		return nil, &toolError{Code: "usage", Message: "name the runs to share: run ids, saved files or --case"}
	}
	return out, nil
}

// savedFile is the saved run a path names: its output file or its .meta.json sidecar.
func savedFile(path string) *savedRun {
	if strings.HasSuffix(path, ".meta.json") {
		files, _ := results.Outputs(filepath.Dir(path))
		stem := strings.TrimSuffix(path, ".meta.json")
		for _, f := range files {
			if strings.TrimSuffix(f, filepath.Ext(f)) == stem {
				path = f
				break
			}
		}
	}
	if m := results.MetaFor(path); m != nil {
		return &savedRun{path, m}
	}
	return nil
}

func buildShare(runs []*savedRun) (share.Payload, error) {
	p := share.Payload{Share: 1, Source: "ot"}
	for _, r := range runs {
		run, err := share.FromSaved(r.output, r.meta)
		if err != nil {
			return p, &ExitError{Code: ExitToolError, Err: fmt.Errorf("can't read %s: %w", r.output, err)}
		}
		p.Runs = append(p.Runs, run)
	}
	return p, nil
}

// shareQuestion is what a person is asked before a share: what goes, about whom.
func shareQuestion(p share.Payload) string {
	q := fmt.Sprintf("Share %s (%s)", plural(len(p.Runs), "run", "runs"), strings.Join(share.Tools(p), ", "))
	if in := share.Inputs(p); len(in) > 3 {
		q += fmt.Sprintf(" on %s and %d more", strings.Join(in[:3], ", "), len(in)-3)
	} else if len(in) > 0 {
		q += " on " + strings.Join(in, ", ")
	}
	return q + " for 24 hours?"
}

// shareDetails says what sharing does, one line each.
func shareDetails(owned bool) []string {
	d := []string{
		"Anyone with the link can see the inputs and everything the tools found, until it expires in 24 hours.",
		"File paths, the case name and the command line stay on this machine.",
	}
	if owned {
		return append(d, "It is linked to your OTInstaller account, which only you can see; you can delete it with `ot shares rm` or on otinstaller.com/settings/shares.")
	}
	return append(d, "It is not linked to any account; `ot shares rm` on this machine deletes it early.")
}

// usageFromTool turns the run lookup's errors into exit 2 with their code.
func usageFromTool(err error) error {
	var te *toolError
	if errors.As(err, &te) {
		return &ExitError{Code: ExitUsage, Reason: te.Code, Err: errors.New(te.Message), Hint: "`ot runs` lists saved runs and their ids"}
	}
	return err
}

// shareID takes a share's id, or the id out of its link.
func shareID(s string) string {
	s = strings.TrimRight(strings.TrimSpace(s), "/")
	if i := strings.LastIndex(s, "/r/"); i >= 0 {
		return s[i+3:]
	}
	return s
}

// shortTools drops namespaces and versions: sherlock, not osintverse-community/sherlock@0.15.0.
func shortTools(tools []string) []string {
	out := make([]string, len(tools))
	for i, t := range tools {
		t = strings.SplitN(t, "@", 2)[0]
		out[i] = t[strings.LastIndexByte(t, '/')+1:]
	}
	return out
}

func whenLocal(ms int64) string {
	return time.UnixMilli(ms).Local().Format("2 Jan 15:04") + " (in " + left(ms) + ")"
}

// left is how long until a time in milliseconds, roughly.
func left(ms int64) string {
	d := time.Until(time.UnixMilli(ms))
	switch {
	case d <= 0:
		return "0 min"
	case d < time.Hour:
		return fmt.Sprintf("%d min", int(d.Minutes()))
	}
	return fmt.Sprintf("%d h", int(d.Hours()+0.5))
}
