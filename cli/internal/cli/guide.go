package cli

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/charmbracelet/glamour"
	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// guideCmd groups the commands for guides: versioned Markdown playbooks that link to the tools they use.
func (a *App) guideCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "guide",
		Short: "Search, read, save and install from guides",
		Long:  "Guides are investigation playbooks and references published on the registry. Read them in the terminal,\nsave an offline copy, or install every tool a guide uses.",
	}
	cmd.AddCommand(a.guideSearchCmd(), a.guideReadCmd(), a.guideOpenCmd(), a.guideGetCmd(), a.guideToolsCmd())
	return cmd
}

// guideArg parses namespace/name[@version]; guides have no local form.
func guideArg(s string) (pkgRef, error) {
	ref, err := parseRef(s)
	if err == nil && ref.LocalPath != "" {
		return pkgRef{}, exitErr(ExitUsage, "give a guide as namespace/name[@version]")
	}
	return ref, err
}

func (a *App) guideSearchCmd() *cobra.Command {
	var p api.SearchParams
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "search [query]",
		Short: "Search guides",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 1 {
				p.Query = args[0]
			}
			res, err := a.API.SearchGuides(cmd.Context(), p)
			if err != nil {
				return a.requestError(err)
			}
			if asJSON {
				return writeJSON(a.Out, res)
			}
			if len(res.Results) == 0 {
				fmt.Fprintln(a.Out, "No guides found.")
				return nil
			}
			tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
			fmt.Fprintln(tw, "GUIDE\tVERSION\tLEVEL\tTITLE")
			for _, g := range res.Results {
				title := orDefault(g.Title, g.Summary)
				if g.Format == "reference" {
					title += " (reference)"
				}
				if g.NeedsUpdate {
					title += " [needs update]"
				}
				fmt.Fprintf(tw, "%s/%s\t%s\t%s\t%s\n", g.Namespace, g.Name, g.LatestVersion, g.Level, truncate(title, 70))
			}
			return tw.Flush()
		},
	}
	f := cmd.Flags()
	f.StringVar(&p.Input, "input", "", "only guides about this input type (email, username, ...)")
	f.StringVar(&p.Category, "category", "", "only this category")
	f.StringVar(&p.Level, "level", "", "beginner, intermediate or advanced")
	f.StringVar(&p.Format, "format", "", "guide or reference")
	f.StringVar(&p.Lang, "lang", "", "language code, e.g. en")
	f.IntVar(&p.Limit, "limit", 25, "maximum results")
	f.BoolVar(&asJSON, "json", false, "print JSON")
	return cmd
}

func (a *App) guideReadCmd() *cobra.Command {
	var list, plain bool
	cmd := &cobra.Command{
		Use:   "read <namespace/name[@version]> [page]",
		Short: "Read a guide page in the terminal",
		Long: "Shows one page of a guide, the first by default. Give the page as its number or its path; --list shows the pages.\n" +
			"Saved copies (`ot guide get`) are used when the registry cannot be reached.",
		Args: cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := guideArg(args[0])
			if err != nil {
				return err
			}
			page := "1"
			if len(args) == 2 {
				page = args[1]
			}
			ctx := cmd.Context()
			if list {
				g, err := a.API.Guide(ctx, ref.NS, ref.Name, ref.Version)
				if err != nil {
					if nav, ok := offlineNav(ref); ok {
						printNav(a, ref, nav)
						return nil
					}
					return a.requestError(err)
				}
				printNav(a, ref, g.Nav)
				return nil
			}
			p, err := a.API.GuidePage(ctx, ref.NS, ref.Name, ref.Version, page, "md")
			if err != nil {
				var ae *api.Error
				off, offErr := offlinePage(ref, page)
				if errors.As(err, &ae) || offErr != nil {
					return a.requestError(err)
				}
				fmt.Fprintf(a.Err, "note: the registry is unreachable; showing the copy saved by `ot guide get`\n")
				p = off
			}
			fmt.Fprint(a.Out, a.renderMarkdown(p.Body, plain, p.Path, func() []api.NavEntry {
				if g, err := a.API.Guide(ctx, ref.NS, ref.Name, p.Version); err == nil {
					return g.Nav
				}
				nav, _ := offlineNav(pkgRef{NS: ref.NS, Name: ref.Name, Version: p.Version})
				return nav
			}))
			pin := ref.Ref()
			if ref.Version != "" {
				pin += "@" + p.Version
			}
			footer := fmt.Sprintf("Page %d of %d of %s %s", p.Position, p.Pages, p.Ref, p.Version)
			if p.Next != nil {
				footer += fmt.Sprintf(" · next: ot guide read %s %d (%s)", pin, p.Position+1, p.Next.Title)
			}
			fmt.Fprintln(a.Err, "\n"+footer)
			return nil
		},
	}
	cmd.Flags().BoolVar(&list, "list", false, "list the guide's pages instead")
	cmd.Flags().BoolVar(&plain, "plain", false, "print the Markdown as written, without formatting")
	return cmd
}

func printNav(a *App, ref pkgRef, nav []api.NavEntry) {
	fmt.Fprintf(a.Out, "%s has %d page(s):\n", ref.Ref(), len(nav))
	for i, n := range nav {
		line := fmt.Sprintf("%3d. %s (%s)", i+1, n.Title, n.Path)
		if n.DeadLinks > 0 {
			line += fmt.Sprintf(" [%d dead link(s)]", n.DeadLinks)
		}
		fmt.Fprintln(a.Out, line)
	}
}

// renderMarkdown formats a page for a terminal with Glamour; piped output stays as written. nav is
// only fetched for a terminal, to number links to other pages.
func (a *App) renderMarkdown(md string, plain bool, page string, nav func() []api.NavEntry) string {
	f, ok := a.Out.(*os.File)
	if plain || !ok || !term.IsTerminal(int(f.Fd())) {
		return md
	}
	width := 100
	if w, _, err := term.GetSize(int(f.Fd())); err == nil && w > 20 {
		width = min(w-2, 120)
	}
	var paths []string
	if mdLink.MatchString(md) {
		for _, n := range nav() {
			paths = append(paths, n.Path)
		}
	}
	return renderWith(forTerminal(md, page, paths), width, glamour.WithAutoStyle())
}

var (
	admonition = regexp.MustCompile(`(?m)^([ \t]*>[ \t]*)\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*`)
	mdImage    = regexp.MustCompile(`!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)`)
	mdLink     = regexp.MustCompile(`\[([^\]]+)\]\(\s*<?([^)\s>#]+\.md)(#[^)\s>]*)?>?\s*\)`)
)

// forTerminal rewrites what only makes sense on the website: admonitions become a bold label, links
// to other pages say which page number to read, and images (which a terminal cannot show) their alt text.
func forTerminal(md, page string, nav []string) string {
	md = admonition.ReplaceAllStringFunc(md, func(m string) string {
		s := admonition.FindStringSubmatch(m)
		return s[1] + "**" + s[2][:1] + strings.ToLower(s[2][1:]) + ":** "
	})
	md = mdImage.ReplaceAllStringFunc(md, func(m string) string {
		s := mdImage.FindStringSubmatch(m)
		if strings.Contains(s[2], "://") {
			return "[image: " + s[1] + "](" + s[2] + ")"
		}
		return "(image: " + s[1] + ")"
	})
	return mdLink.ReplaceAllStringFunc(md, func(m string) string {
		s := mdLink.FindStringSubmatch(m)
		if strings.Contains(s[2], "://") {
			return m
		}
		target := path.Clean(path.Join(path.Dir(page), s[2]))
		for i, p := range nav {
			if p == target {
				return fmt.Sprintf("%s (page %d)", s[1], i+1)
			}
		}
		return s[1]
	})
}

func renderWith(md string, width int, style glamour.TermRendererOption) string {
	r, err := glamour.NewTermRenderer(style, glamour.WithWordWrap(width))
	if err != nil {
		return md
	}
	out, err := r.Render(md)
	if err != nil {
		return md
	}
	return out
}

func (a *App) guideOpenCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "open <namespace/name[@version]> [page]",
		Short: "Open a guide on the website",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := guideArg(args[0])
			if err != nil {
				return err
			}
			// The site's guide reader: /guides/{ns}/{name}[/{page}], with ?v= for a pinned version.
			u := strings.TrimRight(a.Config.SiteURL, "/") + "/guides/" + ref.Ref()
			if len(args) == 2 {
				path := args[1]
				if n, err := strconv.Atoi(path); err == nil {
					g, err := a.API.Guide(cmd.Context(), ref.NS, ref.Name, ref.Version)
					if err != nil {
						return a.requestError(err)
					}
					if n < 1 || n > len(g.Nav) {
						return exitErr(ExitUsage, "%s has %d page(s)", ref.Ref(), len(g.Nav))
					}
					path = g.Nav[n-1].Path
				}
				u += "/" + strings.TrimSuffix(path, ".md")
			}
			if ref.Version != "" {
				u += "?v=" + url.QueryEscape(ref.Version)
			}
			fmt.Fprintf(a.Out, "Opening %s\n", u)
			if err := a.OpenURL(u); err != nil {
				fmt.Fprintf(a.Err, "could not open a browser (%v); open the link yourself\n", err)
			}
			return nil
		},
	}
}

// openInBrowser opens a URL with the desktop's default handler.
func openInBrowser(u string) error {
	switch runtime.GOOS {
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", u).Start()
	case "darwin":
		return exec.Command("open", u).Start()
	}
	return exec.Command("xdg-open", u).Start()
}

// guideDir is where `ot guide get` keeps a guide version: ~/.ot/guides/<namespace>/<name>/<version>.
func guideDir(ns, name, version string) string { return state.Path("guides", ns, name, version) }

func (a *App) guideGetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "get <namespace/name[@version]>",
		Short: "Save an offline copy of a guide",
		Long:  "Saves every page as Markdown under ~/.ot/guides (on Windows %APPDATA%\\ot\\guides). `ot guide read` uses the copy when offline.",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := guideArg(args[0])
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			g, err := a.API.Guide(ctx, ref.NS, ref.Name, ref.Version)
			if err != nil {
				return a.requestError(err)
			}
			dir := guideDir(ref.NS, ref.Name, g.Version)
			for _, n := range g.Nav {
				p, err := a.API.GuidePage(ctx, ref.NS, ref.Name, g.Version, n.Path, "md")
				if err != nil {
					return a.requestError(err)
				}
				full := filepath.Join(dir, filepath.FromSlash(n.Path))
				if !strings.HasPrefix(full, dir+string(filepath.Separator)) {
					return fmt.Errorf("refusing to save page %q outside %s", n.Path, dir)
				}
				if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
					return err
				}
				if err := os.WriteFile(full, []byte(p.Body), 0o644); err != nil {
					return err
				}
			}
			meta, _ := json.MarshalIndent(g, "", "  ")
			if err := os.WriteFile(filepath.Join(dir, "guide.json"), meta, 0o644); err != nil {
				return err
			}
			fmt.Fprintf(a.Out, "Saved %s %s (%d pages) to %s\n", ref.Ref(), g.Version, len(g.Nav), dir)
			return nil
		},
	}
}

// offlineGuide loads a saved copy: the requested version, or the newest one saved.
func offlineGuide(ref pkgRef) (*api.GuideDetail, string, bool) {
	version := ref.Version
	if version == "" {
		entries, _ := os.ReadDir(state.Path("guides", ref.NS, ref.Name))
		var vs []string
		for _, e := range entries {
			if e.IsDir() {
				vs = append(vs, e.Name())
			}
		}
		if len(vs) == 0 {
			return nil, "", false
		}
		sort.Slice(vs, func(i, j int) bool { return semverLess(vs[i], vs[j]) })
		version = vs[len(vs)-1]
	}
	dir := guideDir(ref.NS, ref.Name, version)
	b, err := os.ReadFile(filepath.Join(dir, "guide.json"))
	if err != nil {
		return nil, "", false
	}
	var g api.GuideDetail
	if json.Unmarshal(b, &g) != nil {
		return nil, "", false
	}
	return &g, dir, true
}

func offlineNav(ref pkgRef) ([]api.NavEntry, bool) {
	g, _, ok := offlineGuide(ref)
	if !ok {
		return nil, false
	}
	return g.Nav, true
}

func offlinePage(ref pkgRef, page string) (*api.Page, error) {
	g, dir, ok := offlineGuide(ref)
	if !ok {
		return nil, errors.New("no saved copy")
	}
	at := -1
	for i, n := range g.Nav {
		if n.Path == page || n.Path == page+".md" || strconv.Itoa(i+1) == page {
			at = i
		}
	}
	if at < 0 {
		return nil, errors.New("no such page")
	}
	body, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(g.Nav[at].Path)))
	if err != nil {
		return nil, err
	}
	p := &api.Page{Ref: g.Ref, Version: g.Version, Path: g.Nav[at].Path, Title: g.Nav[at].Title, Position: at + 1, Pages: len(g.Nav), Format: "md", Body: string(body)}
	if at+1 < len(g.Nav) {
		p.Next = &api.PageRef{Path: g.Nav[at+1].Path, Title: g.Nav[at+1].Title}
	}
	return p, nil
}

// semverLess orders versions numerically; a prerelease sorts before its release.
func semverLess(a, b string) bool {
	split := func(v string) ([3]int, string) {
		core, pre, _ := strings.Cut(v, "-")
		var n [3]int
		for i, s := range strings.SplitN(core, ".", 3) {
			n[i], _ = strconv.Atoi(s)
		}
		return n, pre
	}
	na, pa := split(a)
	nb, pb := split(b)
	if na != nb {
		for i := range na {
			if na[i] != nb[i] {
				return na[i] < nb[i]
			}
		}
	}
	if (pa == "") != (pb == "") {
		return pa != ""
	}
	return pa < pb
}

func (a *App) guideToolsCmd() *cobra.Command {
	var yes, native bool
	cmd := &cobra.Command{
		Use:   "tools <namespace/name[@version]>",
		Short: "Install every tool a guide uses, after one confirmation",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := guideArg(args[0])
			if err != nil {
				return err
			}
			ctx := cmd.Context()
			g, err := a.API.Guide(ctx, ref.NS, ref.Name, ref.Version)
			if err != nil {
				return a.requestError(err)
			}
			st, err := state.Load()
			if err != nil {
				return err
			}
			var todo []pkgRef
			for _, t := range g.RelatedTools {
				switch {
				case !t.Available:
					fmt.Fprintf(a.Out, "  %s: not in the registry any more, skipped\n", t.Ref)
				case st.Installed[t.Ref] != nil:
					fmt.Fprintf(a.Out, "  %s: already installed\n", t.Ref)
				default:
					fmt.Fprintf(a.Out, "  %s %s: %s\n", t.Ref, t.Version, t.Summary)
					r, _ := parseRef(t.Ref)
					todo = append(todo, r)
				}
			}
			if len(todo) == 0 {
				fmt.Fprintf(a.Out, "Nothing to install for %s.\n", ref.Ref())
				return nil
			}
			if !yes {
				fmt.Fprintf(a.Out, "Install %d tool(s)? [y/N]: ", len(todo))
				line, _ := bufio.NewReader(a.In).ReadString('\n')
				if ans := strings.ToLower(strings.TrimSpace(line)); ans != "y" && ans != "yes" {
					fmt.Fprintln(a.Out, "Nothing installed.")
					return nil
				}
			}
			var failed []string
			for _, r := range todo {
				if _, err := a.install(ctx, r, native); err != nil {
					fmt.Fprintf(a.Err, "error: %s: %v\n", r.Ref(), err)
					failed = append(failed, r.Ref())
				}
			}
			if len(failed) > 0 {
				return exitErr(ExitToolError, "%d of %d tool(s) failed to install: %s", len(failed), len(todo), strings.Join(failed, ", "))
			}
			fmt.Fprintf(a.Out, "Installed %d tool(s) from %s.\n", len(todo), ref.Ref())
			return nil
		},
	}
	cmd.Flags().BoolVarP(&yes, "yes", "y", false, "install without asking")
	cmd.Flags().BoolVar(&native, "native", false, "install pipx tools on the host instead of in a container")
	return cmd
}

// docsCmd reads a tool's own documentation, published with the docs: field of its manifest.
func (a *App) docsCmd() *cobra.Command {
	var list, plain bool
	cmd := &cobra.Command{
		Use:   "docs <namespace/tool> [page]",
		Short: "Read a tool's docs in the terminal",
		Args:  cobra.RangeArgs(1, 2),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := guideArg(args[0])
			if err != nil {
				return err
			}
			if ref.Version != "" {
				return exitErr(ExitUsage, "docs are always for the latest version; give the tool as namespace/name")
			}
			ctx := cmd.Context()
			if list {
				d, err := a.API.ToolDocs(ctx, ref.NS, ref.Name)
				if err != nil {
					return a.requestError(err)
				}
				printNav(a, ref, d.Nav)
				return nil
			}
			page := "1"
			if len(args) == 2 {
				page = args[1]
			}
			p, err := a.API.ToolDocPage(ctx, ref.NS, ref.Name, page, "md")
			if err != nil {
				return a.requestError(err)
			}
			fmt.Fprint(a.Out, a.renderMarkdown(p.Body, plain, p.Path, func() []api.NavEntry {
				d, err := a.API.ToolDocs(ctx, ref.NS, ref.Name)
				if err != nil {
					return nil
				}
				return d.Nav
			}))
			footer := fmt.Sprintf("Page %d of %d of the %s %s docs", p.Position, p.Pages, p.Ref, p.Version)
			if p.Next != nil {
				footer += fmt.Sprintf(" · next: ot docs %s %d (%s)", ref.Ref(), p.Position+1, p.Next.Title)
			}
			fmt.Fprintln(a.Err, "\n"+footer)
			return nil
		},
	}
	cmd.Flags().BoolVar(&list, "list", false, "list the docs pages instead")
	cmd.Flags().BoolVar(&plain, "plain", false, "print the Markdown as written, without formatting")
	return cmd
}
