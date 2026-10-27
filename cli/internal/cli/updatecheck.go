package cli

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/selfupdate"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// ---------- the registry's latest versions ----------

// latestCache is <ot home>/cache/latest.json: every package's latest version (GET /latest), when it was last asked
// for, when an answer last arrived, and when the daily note last said something.
type latestCache struct {
	CheckedAt time.Time           `json:"checked_at"`
	FetchedAt time.Time           `json:"fetched_at"`
	NotedAt   time.Time           `json:"noted_at"`
	Packages  []api.LatestPackage `json:"packages"`
	Moved     []api.Move          `json:"moved"`
}

func readLatestCache() *latestCache {
	c := &latestCache{}
	if b, err := os.ReadFile(state.Path("cache", "latest.json")); err == nil {
		_ = json.Unmarshal(b, c)
	}
	return c
}

// save writes the cache atomically, so two ot processes never leave it half-written.
func (c *latestCache) save() {
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	path := state.Path("cache", "latest.json")
	_ = os.MkdirAll(filepath.Dir(path), 0o755)
	tmp := path + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, path)
	}
}

// noUpdateCheck is OT_NO_UPDATE_CHECK=1, or DO_NOT_TRACK, which asks for no requests a command doesn't need: no daily
// lookup of the latest versions or of a newer ot. The daily check for removed versions stays on, for safety.
func noUpdateCheck() bool { return os.Getenv("OT_NO_UPDATE_CHECK") == "1" || state.DoNotTrack() }

// latestList returns the registry's latest versions, asking at most once per maxAge. Every attempt counts, so an
// offline machine waits on the registry once a day, not on every command; only an answer replaces what was cached.
// noUpdateCheck never asks. The list is the same for everyone, so asking says nothing about what is installed.
func (a *App) latestList(ctx context.Context, maxAge time.Duration) *latestCache {
	c := readLatestCache()
	if noUpdateCheck() || time.Since(c.CheckedAt) < maxAge {
		return c
	}
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c.CheckedAt = time.Now()
	if l, err := a.API.Latest(ctx); err == nil {
		c.FetchedAt, c.Packages, c.Moved = c.CheckedAt, l.Packages, l.Moved
	}
	c.save()
	return c
}

// find is a package's entry, or nil when the list doesn't have it (a local manifest, or no list yet).
func (c *latestCache) find(ref string) *api.LatestPackage {
	for i := range c.Packages {
		if c.Packages[i].Ref == ref {
			return &c.Packages[i]
		}
	}
	return nil
}

// movedTo is where a package that moved lives now, or "".
func (c *latestCache) movedTo(ref string) string {
	for _, m := range c.Moved {
		if m.From == ref {
			return m.To
		}
	}
	return ""
}

// hasUpdate says whether an installed package has something newer: a later version, or a new address.
func (c *latestCache) hasUpdate(inst *state.Installed) bool {
	if c.movedTo(inst.Ref) != "" {
		return true
	}
	p := c.find(inst.Ref)
	return p != nil && semverLess(inst.Version, p.Latest)
}

// updateCounts is how many installed packages have an update, and how many of those are held.
func updateCounts(st *state.State, c *latestCache) (updates, held int) {
	for _, inst := range st.Installed {
		if c.hasUpdate(inst) {
			updates++
			if inst.Held {
				held++
			}
		}
	}
	return updates, held
}

// ---------- the daily note ----------

// quietCommands never get the daily note: it would repeat what they say, get in the way of a machine reading their
// output, or (completion) run on every Tab.
var quietCommands = map[string]bool{
	"help": true, "completion": true, cobra.ShellCompRequestCmd: true, cobra.ShellCompNoDescRequestCmd: true,
	"uninstall": true, "outdated": true, "update": true, "self-update": true, "mcp": true, "start": true, "telemetry": true,
}

// topLevel is the name of the root's child that cmd belongs to, or "" for the root itself.
func topLevel(cmd *cobra.Command) string {
	for cmd.HasParent() && cmd.Parent().HasParent() {
		cmd = cmd.Parent()
	}
	if !cmd.HasParent() {
		return ""
	}
	return cmd.Name()
}

// dailyNote is the once-a-day note about updates: the lookups start before a command runs, and the note is printed
// after its output.
type dailyNote struct {
	done     chan struct{}
	list     *latestCache
	otLatest string
}

// startDailyNote starts the day's lookups when a person at a terminal hasn't been told about updates today. Never in
// CI, under `ot mcp`, with JSON output, or with OT_NO_UPDATE_CHECK=1 or DO_NOT_TRACK.
func (a *App) startDailyNote(cmd *cobra.Command, args []string) {
	if !a.CheckUpdates || quietCommands[topLevel(cmd)] || topLevel(cmd) == "" || a.AgentMode ||
		os.Getenv("CI") != "" || noUpdateCheck() ||
		!a.interactive() || a.jsonMode() || jsonRequested(args) {
		return
	}
	if time.Since(readLatestCache().NotedAt) < 24*time.Hour {
		return
	}
	n := &dailyNote{done: make(chan struct{})}
	a.note = n
	ctx := cmd.Context()
	go func() {
		defer close(n.done)
		ot := make(chan string, 1)
		go func() { ot <- a.latestOT(ctx) }()
		n.list = a.latestList(ctx, 24*time.Hour)
		n.otLatest = <-ot
	}()
}

// finishDailyNote prints the note, at most two lines on stderr, and remembers that it did.
func (a *App) finishDailyNote() {
	n := a.note
	if n == nil {
		return
	}
	a.note = nil
	<-n.done
	said := false
	if st, err := state.Load(); err == nil && n.list != nil {
		if updates, held := updateCounts(st, n.list); updates > 0 {
			fmt.Fprintln(a.Err, "note:", updatesNote(updates, held))
			said = true
		}
	}
	if n.otLatest != "" && selfupdate.Newer(n.otLatest, Version) {
		fmt.Fprintf(a.Err, "note: ot %s is out (you have %s); `ot self-update` installs it\n", n.otLatest, Version)
		said = true
	}
	if said {
		c := readLatestCache()
		c.NotedAt = time.Now()
		c.save()
	}
}

// updatesNote is the daily note's sentence about installed packages.
func updatesNote(updates, held int) string {
	s, them := fmt.Sprintf("%d installed packages have newer versions", updates), "them"
	if updates == 1 {
		s, them = "1 installed package has a newer version", "it"
	}
	switch {
	case held == 0:
		return fmt.Sprintf("%s; `ot outdated` lists %s, `ot update --all` installs %s", s, them, them)
	case held == updates:
		return fmt.Sprintf("%s (held at the version you chose); `ot outdated` lists %s, `ot update <name>` moves one", s, them)
	default:
		return fmt.Sprintf("%s (%d held); `ot outdated` lists them, `ot update --all` installs the rest", s, held)
	}
}
