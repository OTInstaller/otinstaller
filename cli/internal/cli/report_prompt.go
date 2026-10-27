package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/api"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// promptEvery is how long ot waits before asking again about the same tool and version.
const promptEvery = 7 * 24 * time.Hour

// failedRun is what the failure prompt knows about a run that went wrong.
type failedRun struct {
	ref      pkgRef
	version  string
	native   bool
	exitCode int
	timedOut bool
	entities int
}

// offerFailureReport asks, at a terminal, whether to report a run that looks like the tool's own failure, and
// sends only the tool, version, exit code, OS and ot version when the person says yes. It never asks agents,
// scripts, CI or JSON callers, never for local manifests, and never when telemetry is off (`ot telemetry off`,
// OT_NO_TELEMETRY, DO_NOT_TRACK or "telemetry": false), and at most once a week per tool and version. It never changes
// the run's exit code.
func (a *App) offerFailureReport(ctx context.Context, ra *runArgs, f failedRun) {
	if !a.mayAskToReport(ra, f) {
		return
	}
	key := f.ref.Ref() + "@" + f.version
	if !promptDue(key) {
		return
	}
	what := fmt.Sprintf("failed (exit %d)", f.exitCode)
	if f.timedOut {
		what = "timed out"
	}
	fmt.Fprintf(a.Err, "\n%s %s %s. Report it as broken? This sends the tool, version, exit code, OS and ot version, never your inputs or output. [y/N] ",
		f.ref.Ref(), f.version, what)
	answer, _ := bufio.NewReader(a.In).ReadString('\n')
	markPrompted(key)
	if ans := strings.ToLower(strings.TrimSpace(answer)); ans != "y" && ans != "yes" {
		return
	}
	res, err := a.sendRunReport(ctx, f)
	if err != nil {
		fmt.Fprintf(a.Err, "warning: the report was not sent: %v\n", err)
		return
	}
	fmt.Fprintln(a.Err, reportOutcome(a, f, res))
}

// mayAskToReport is every condition for the prompt except the weekly limit.
func (a *App) mayAskToReport(ra *runArgs, f failedRun) bool {
	if f.ref.LocalPath != "" || f.version == "" || !a.interactive() || a.jsonMode() || ra.Machine || os.Getenv("CI") != "" {
		return false
	}
	if !a.Config.TelemetryEnabled() {
		return false
	}
	// A run that found something mostly worked; a timeout always counts.
	return f.timedOut || (f.exitCode != 0 && f.entities == 0)
}

// sendRunReport sends the report, signed in when there is a token (so it can join or open an issue).
func (a *App) sendRunReport(ctx context.Context, f failedRun) (*api.RunReportResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	r := api.RunReport{Version: f.version, TimedOut: f.timedOut, OS: runtime.GOOS, Arch: runtime.GOARCH, Engine: a.engineName(f.native), OTVersion: Version}
	if !f.timedOut {
		code := f.exitCode
		r.ExitCode = &code
	}
	res, err := a.API.ReportRun(ctx, f.ref.NS, f.ref.Name, r, a.API.Token == "")
	var ae *api.Error
	if err != nil && a.API.Token != "" && errors.As(err, &ae) && ae.Status == 403 {
		// A token without the feedback scope: count it anonymously instead.
		return a.API.ReportRun(ctx, f.ref.NS, f.ref.Name, r, true)
	}
	return res, err
}

func reportOutcome(a *App, f failedRun, res *api.RunReportResult) string {
	issues := strings.TrimRight(a.Config.SiteURL, "/") + "/" + f.ref.Ref() + "/issues"
	switch {
	case res.Issue != 0 && res.Moderation == "held":
		return fmt.Sprintf("Thanks. Your report waits for a moderator before it shows on %s.", issues)
	case res.Issue != 0 && res.Created:
		return fmt.Sprintf("Thanks. Opened %s/%d; add how to reproduce it with the tool's test input if you can.", issues, res.Issue)
	case res.Issue != 0:
		return fmt.Sprintf("Thanks. Added you to %s/%d.", issues, res.Issue)
	default:
		return fmt.Sprintf("Thanks, counted. Sign in with `ot login` to follow it on %s.", issues)
	}
}

// engineName is what a run uses: native for pipx tools run without a container, else docker or podman; "" when
// neither is installed.
func (a *App) engineName(native bool) string {
	if native {
		return "native"
	}
	if a.Runner != nil && a.Runner.Engine != "" {
		return a.Runner.Engine
	}
	return ""
}

// promptsFile is ~/.ot/cache/report-prompts.json: when ot last asked about each tool@version.
func promptsFile() string { return state.Path("cache", "report-prompts.json") }

func loadPrompts() map[string]time.Time {
	m := map[string]time.Time{}
	if b, err := os.ReadFile(promptsFile()); err == nil {
		_ = json.Unmarshal(b, &m)
	}
	return m
}

func promptDue(key string) bool {
	last, ok := loadPrompts()[key]
	return !ok || time.Since(last) > promptEvery
}

func markPrompted(key string) {
	m := loadPrompts()
	m[key] = time.Now()
	for k, t := range m {
		if time.Since(t) > promptEvery {
			delete(m, k)
		}
	}
	if b, err := json.Marshal(m); err == nil {
		_ = os.MkdirAll(filepath.Dir(promptsFile()), 0o755)
		_ = os.WriteFile(promptsFile(), b, 0o644)
	}
}
