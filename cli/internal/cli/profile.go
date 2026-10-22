package cli

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
)

// profileKeys maps what `ot profile --set` accepts to the API's field names. Fields are profile overrides; about,
// pins and hide are the profile's own settings.
var profileKeys = map[string]string{
	"name": "display_name", "display_name": "display_name", "bio": "bio", "location": "location", "website": "website",
	"company": "company", "avatar": "avatar_url", "avatar_url": "avatar_url", "socials": "socials",
	"about": "about", "pins": "pins", "hide": "hide_details", "hide_details": "hide_details",
}

// profileBody turns --set key=value and --unset key into the PATCH body. Values of about may be @file (or @- for
// stdin); socials and pins are comma-separated.
func (a *App) profileBody(sets, unsets []string) (map[string]any, error) {
	body := map[string]any{}
	custom := map[string]any{}
	put := func(key string, value any, unset bool) error {
		field, ok := profileKeys[key]
		if !ok {
			return exitErr(ExitUsage, "unknown profile key %q; use name, bio, location, website, company, avatar, socials, about, pins or hide", key)
		}
		switch field {
		case "about":
			body["about"] = value
		case "pins":
			if unset {
				body["pins"] = []string{}
			} else {
				body["pins"] = splitList(value.(string))
			}
		case "hide_details":
			if unset {
				body["hide_details"] = false
				return nil
			}
			b, err := strconv.ParseBool(value.(string))
			if err != nil {
				return exitErr(ExitUsage, "hide is true or false")
			}
			body["hide_details"] = b
		case "socials":
			if unset {
				custom[field] = nil
			} else {
				custom[field] = splitList(value.(string))
			}
		default:
			custom[field] = value
		}
		return nil
	}
	for _, s := range sets {
		key, value, ok := strings.Cut(s, "=")
		if !ok {
			return nil, exitErr(ExitUsage, "--set takes key=value, e.g. --set bio=\"OSINT tools for journalists\"")
		}
		key = strings.ToLower(strings.TrimSpace(key))
		if profileKeys[key] == "about" && strings.HasPrefix(value, "@") {
			text, err := a.readArgFile(value[1:])
			if err != nil {
				return nil, exitErr(ExitUsage, "reading %s: %v", value[1:], err)
			}
			value = text
		}
		if err := put(key, value, false); err != nil {
			return nil, err
		}
	}
	for _, key := range unsets {
		if err := put(strings.ToLower(strings.TrimSpace(key)), nil, true); err != nil {
			return nil, err
		}
	}
	if len(custom) > 0 {
		body["custom"] = custom
	}
	return body, nil
}

// readArgFile reads a file, or stdin for "-".
func (a *App) readArgFile(path string) (string, error) {
	if path == "-" {
		b, err := io.ReadAll(a.In)
		return string(b), err
	}
	b, err := os.ReadFile(path)
	return string(b), err
}

func splitList(s string) []string {
	out := []string{}
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func (a *App) profileCmd() *cobra.Command {
	var sync bool
	var sets, unsets []string
	cmd := &cobra.Command{
		Use:   "profile [namespace]",
		Short: "Show a publisher's profile, or sync and edit your own",
		Long: "Shows a publisher's profile on otinstaller.com: who they are, their GitHub and GitLab accounts and their numbers.\n" +
			"Without a namespace it shows yours (when you own exactly one).\n\n" +
			"Owners can refresh the profile from GitHub and GitLab with --sync, override a field with --set key=value\n" +
			"(name, bio, location, website, company, avatar, socials, about, pins, hide), and go back to the host value\n" +
			"with --unset key. socials and pins are comma-separated; --set about=@README-profile.md reads a file.",
		Example: "  ot profile osintverse-community\n" +
			"  ot profile --sync\n" +
			"  ot profile acme --set bio=\"OSINT tools for newsrooms\" --set pins=whois-plus,dns-records\n" +
			"  ot profile acme --set about=@about.md --unset location",
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			editing := sync || len(sets) > 0 || len(unsets) > 0
			ns := ""
			if len(args) == 1 {
				ns = strings.TrimPrefix(strings.TrimSpace(args[0]), "@")
			}
			if (editing || ns == "") && a.API.Token == "" {
				if editing {
					return errNotSignedIn("sign in first with `ot login` to change a profile")
				}
				return exitErr(ExitUsage, "give a namespace, e.g. `ot profile osintverse-community`, or sign in to see yours")
			}
			if ns == "" {
				me, err := a.API.Me(ctx)
				if err != nil {
					return a.requestError(err)
				}
				var owned []string
				for _, n := range me.Namespaces {
					if n.Role == "owner" {
						owned = append(owned, n.Name)
					}
				}
				if len(owned) != 1 {
					if len(owned) == 0 {
						return exitErr(ExitUsage, "you own no namespace yet; give one, e.g. `ot profile osintverse-community`")
					}
					return exitErr(ExitUsage, "you own %d namespaces (%s); say which one: `ot profile %s`", len(owned), strings.Join(owned, ", "), owned[0])
				}
				ns = owned[0]
			}
			if editing {
				body, err := a.profileBody(sets, unsets)
				if err != nil {
					return err
				}
				if len(body) > 0 {
					if _, err := a.API.UpdateProfile(ctx, ns, body); err != nil {
						return a.requestError(err)
					}
					if !a.jsonMode() {
						fmt.Fprintf(a.Err, "Saved %s's profile. The public page updates within 5 minutes.\n", ns)
					}
				}
				if sync {
					s, err := a.API.SyncProfile(ctx, ns)
					if err != nil {
						return a.requestError(err)
					}
					if a.jsonMode() {
						return writeJSON(a.Out, s)
					}
					if s.Sync.Status == "error" {
						fmt.Fprintf(a.Err, "warning: the sync finished with an error: %s\n", s.Sync.Error)
					} else {
						fmt.Fprintf(a.Err, "Synced %s from %s at %s.\n", ns, hostList(s.Hosts), when(s.Sync.SyncedAt))
					}
				}
				if a.jsonMode() {
					s, err := a.API.ProfileSettings(ctx, ns)
					if err != nil {
						return a.requestError(err)
					}
					return writeJSON(a.Out, s)
				}
			}
			n, err := a.API.Namespace(ctx, ns)
			if err != nil {
				return a.requestError(err)
			}
			if a.jsonMode() {
				return writeJSON(a.Out, n)
			}
			a.printProfile(n)
			return nil
		},
	}
	cmd.Flags().BoolVar(&sync, "sync", false, "refresh the profile from GitHub and GitLab now (owners; at most 10 an hour)")
	cmd.Flags().StringArrayVar(&sets, "set", nil, "override a field: key=value (repeatable)")
	cmd.Flags().StringArrayVar(&unsets, "unset", nil, "go back to the host value for a field, or clear about, pins or hide (repeatable)")
	return cmd
}

func hostList(hosts []api.ProfileHost) string {
	if len(hosts) == 0 {
		return "no host"
	}
	var parts []string
	for _, h := range hosts {
		parts = append(parts, hostName(h.Provider)+" ("+h.Login+")")
	}
	return strings.Join(parts, " and ")
}

func hostName(p string) string {
	switch p {
	case "github":
		return "GitHub"
	case "gitlab":
		return "GitLab"
	}
	return p
}

func (a *App) printProfile(n *api.Namespace) {
	name := n.DisplayName
	if name == "" {
		name = n.Name
	}
	head := name
	if name != n.Name {
		head += " (" + n.Name + ")"
	}
	kind := map[string]string{"user": "User", "org": "Organization", "group": "Group"}[n.Kind]
	if kind == "" {
		kind = n.Kind
	}
	if n.Verified {
		kind += ", verified publisher"
	}
	fmt.Fprintf(a.Out, "%s\n%s\n", head, kind)
	if n.Status == "pending_review" {
		fmt.Fprintln(a.Out, "\nNew publisher: the first release is waiting for review, so nothing is published yet.")
	}
	p := n.Profile
	if p != nil && p.Bio != "" {
		fmt.Fprintf(a.Out, "\n%s\n", p.Bio)
	}
	fmt.Fprintln(a.Out)
	tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
	row := func(k, v string) {
		if v != "" {
			fmt.Fprintf(tw, "%s:\t%s\n", k, v)
		}
	}
	if p != nil {
		row("Company", p.Company)
		row("Location", p.Location)
		row("Website", p.Website)
		for _, s := range p.Socials {
			row(socialName(s.Provider), s.URL)
		}
		for _, h := range p.Hosts {
			row(hostName(h.Provider), h.URL)
		}
	}
	if s := n.Stats; s != nil && s.Packages > 0 {
		row("Packages", fmt.Sprintf("%d (%d tools, %d guides)", s.Packages, s.Tools, s.Guides))
		row("Installs", fmt.Sprintf("%d in 30 days, %d in all", s.Installs30d, s.InstallsTotal))
		row("Stars", strconv.Itoa(s.Stars))
		if s.Tools > 0 {
			row("Health", fmt.Sprintf("%d passing, %d possibly broken", s.Healthy, s.Broken))
		}
		if s.LastPublishedAt > 0 {
			row("Last published", when(s.LastPublishedAt))
		}
	}
	if p != nil && len(p.Pins) > 0 {
		row("Pinned", strings.Join(p.Pins, ", "))
	}
	row("Publishing since", when(n.CreatedAt))
	row("Profile", strings.TrimRight(a.Config.SiteURL, "/")+"/"+n.Name)
	tw.Flush()
	if len(n.Tools) > 0 {
		fmt.Fprintln(a.Out)
		tw = tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "PACKAGE\tKIND\tVERSION\tINSTALLS (30D)\tSUMMARY")
		for _, t := range n.Tools {
			fmt.Fprintf(tw, "%s/%s\t%s\t%s\t%d\t%s\n", t.Namespace, t.Name, t.Kind, t.LatestVersion, t.Installs30d, truncate(t.Summary, 60))
		}
		tw.Flush()
	}
}

func socialName(p string) string {
	names := map[string]string{"x": "X", "linkedin": "LinkedIn", "mastodon": "Mastodon", "bluesky": "Bluesky", "youtube": "YouTube", "github": "GitHub", "gitlab": "GitLab"}
	if n, ok := names[p]; ok {
		return n
	}
	return "Link"
}
