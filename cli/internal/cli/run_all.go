package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"text/tabwriter"

	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// allResult is one row of the `ot run --all` summary.
type allResult struct {
	Tool     string `json:"tool"`
	Version  string `json:"version"`
	Status   string `json:"status"` // a results status, "skipped" or "error"
	ExitCode *int   `json:"exit_code,omitempty"`
	Entities int    `json:"entities"`
	// TopEntities are the first entities found, without duplicates; all of them are in the sidecar.
	TopEntities []envelope.Entity `json:"top_entities,omitempty"`
	RunID       string            `json:"run_id,omitempty"`
	OutputPath  string            `json:"output_path,omitempty"`
	MetaPath    string            `json:"meta_path,omitempty"`
	Reason      string            `json:"reason,omitempty"`
}

// topEntities is how many entities each summary row carries.
const topEntities = 20

func firstDistinct(ents []envelope.Entity, n int) []envelope.Entity {
	var out []envelope.Entity
	seen := map[string]bool{}
	for _, e := range ents {
		k := e.Type + "\x00" + e.Value
		if seen[k] {
			continue
		}
		seen[k] = true
		if out = append(out, e); len(out) == n {
			break
		}
	}
	return out
}

type allJob struct {
	inst    *state.Installed
	values  map[string]string
	secrets map[string]string
	target  string
	row     *allResult
}

// runAll runs every installed tool that has an input of one of the given types, in parallel.
// With a selection (a playbook's tools, which must be installed) only those run, and the ones
// with no input of the given types are listed as skipped instead of left out. what names the
// command in messages: "--all" or "a playbook".
func (a *App) runAll(ctx context.Context, ra *runArgs, what string, selection []*state.Installed) error {
	if len(ra.Typed) == 0 {
		return exitErr(ExitUsage, "%s needs at least one typed input, such as u:johndoe or d:example.com", what)
	}
	if len(ra.Inputs) > 0 || ra.Output != "" || ra.OutDir != "" {
		return exitErr(ExitUsage, "%s takes only typed inputs (u:, d:, e:, p:, ip:, url:), not --<input>, -o or --out-dir", what)
	}
	if ra.NoSave {
		return exitErr(ExitUsage, "%s always saves its runs; the summary only points at the saved files", what)
	}
	format := ra.Format
	if format == "" {
		format = map[bool]string{true: "json", false: "table"}[a.jsonMode()]
	}
	if format != "table" && format != "json" && format != "jsonl" {
		return exitErr(ExitUsage, "%s prints a summary as table, json or jsonl, not %q", what, format)
	}
	candidates := selection
	if selection == nil {
		st, err := state.Load()
		if err != nil {
			return err
		}
		candidates = st.Sorted()
	}

	var rows []*allResult
	var jobs []allJob
	for _, inst := range candidates {
		m := inst.Manifest
		row := &allResult{Tool: inst.Ref, Version: inst.Version}
		if m == nil || m.IsGuide() || m.Runtime == nil {
			if selection != nil {
				row.Status, row.Reason = "skipped", "not a tool"
				rows = append(rows, row)
			}
			continue
		}
		// Only the typed inputs this tool has an input for apply; a tool with none is not listed.
		var typed []runner.TypedInput
		var ambiguous error
		for _, t := range ra.Typed {
			switch names := runner.InputsOfType(m, runner.TypedPrefixes[t.Prefix]); len(names) {
			case 0:
			case 1:
				typed = append(typed, t)
			default:
				_, ambiguous = runner.InputForType(m, runner.TypedPrefixes[t.Prefix])
			}
		}
		if len(typed) == 0 && ambiguous == nil {
			if selection != nil {
				row.Status, row.Reason = "skipped", "has no "+typedTypes(ra.Typed)+" input"
				rows = append(rows, row)
			}
			continue
		}
		skip := func(err error) {
			row.Status, row.Reason = "skipped", err.Error()
			rows = append(rows, row)
		}
		if ambiguous != nil {
			skip(ambiguous)
			continue
		}
		given, target, err := runner.ApplyTyped(m, nil, typed)
		if err != nil {
			skip(err)
			continue
		}
		values, err := runner.ResolveInputs(m, given)
		if err != nil {
			skip(err)
			continue
		}
		secrets, err := loadSecrets(m)
		if err != nil {
			skip(err)
			continue
		}
		rows = append(rows, row)
		jobs = append(jobs, allJob{inst, values, secrets, target, row})
	}
	if len(rows) == 0 {
		return exitErr(ExitUsage, "no installed tool has a %s input; find some with `ot search`", typedTypes(ra.Typed))
	}
	if len(jobs) == 0 && selection != nil {
		for _, r := range rows {
			fmt.Fprintf(a.Err, "%s: %s\n", r.Tool, r.Reason)
		}
		return exitErr(ExitUsage, "none of the playbook's tools can run with a %s input", typedTypes(ra.Typed))
	}

	if ra.DryRun {
		for _, j := range jobs {
			j.row.Status = "would run"
		}
		if format == "jsonl" {
			for _, r := range rows {
				a.writeLine(r)
			}
			return a.writeSummary(rows, nil)
		}
		return a.printAllRows(rows, format)
	}
	// jsonl streams: rows that won't run first, then each run as it finishes, then the summary.
	if format == "jsonl" {
		for _, r := range rows {
			if r.Status != "" {
				a.writeLine(r)
			}
		}
	}
	if format == "table" {
		fmt.Fprintf(a.Err, "Running %d tools, %d at a time...\n", len(jobs), ra.Parallel)
	}
	sem := make(chan struct{}, ra.Parallel)
	var wg sync.WaitGroup
	// Progress on stderr as each tool finishes, so a long batch shows it is moving (otinstaller's
	// --live table). Only with the table summary; JSON callers read the summary.
	var progressMu sync.Mutex
	done := 0
	progress := func(row *allResult) {
		if format == "jsonl" {
			progressMu.Lock()
			defer progressMu.Unlock()
			a.writeLine(row)
			return
		}
		if format != "table" {
			return
		}
		progressMu.Lock()
		defer progressMu.Unlock()
		done++
		status := row.Status
		if row.ExitCode != nil && *row.ExitCode != 0 {
			status = fmt.Sprintf("%s (exit %d)", status, *row.ExitCode)
		}
		fmt.Fprintf(a.Err, "[%d/%d] %s %s\n", done, len(jobs), row.Tool, status)
	}
	for _, j := range jobs {
		wg.Add(1)
		go func(j allJob) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			defer progress(j.row)
			if ctx.Err() != nil {
				j.row.Status, j.row.Reason = results.StatusInterrupted, "not started"
				return
			}
			// Parallel runs would interleave on the terminal, so stderr only goes to the saved file.
			env, meta, err := a.execute(ctx, j.inst, j.values, j.secrets, j.target, ra, io.Discard)
			if meta != nil {
				j.row.Status, j.row.Entities = meta.Status, len(meta.Entities)
				j.row.TopEntities, j.row.RunID = firstDistinct(meta.Entities, topEntities), meta.RunID
				j.row.OutputPath = meta.OutputPath
				j.row.MetaPath = meta.MetaPath
				if meta.ExitCode >= 0 {
					code := meta.ExitCode
					j.row.ExitCode = &code
				}
			} else if env != nil {
				// Saving failed after the run; execute already warned.
				code := env.ExitCode
				j.row.Status, j.row.ExitCode, j.row.Entities = results.StatusComplete, &code, len(env.Entities)
				j.row.TopEntities, j.row.RunID = firstDistinct(env.Entities, topEntities), env.RunID
				if code != 0 {
					j.row.Status = results.StatusFailed
				}
			}
			if err != nil {
				var ee *ExitError
				if j.row.Status == "" || !errors.As(err, &ee) {
					j.row.Reason = err.Error()
				}
				if j.row.Status == "" {
					j.row.Status = "error"
				}
			}
		}(j)
	}
	wg.Wait()

	err := allOutcome(ctx, rows)
	if format == "jsonl" {
		if werr := a.writeSummary(rows, err); werr != nil {
			return werr
		}
		return err
	}
	if perr := a.printAllRows(rows, format); perr != nil {
		return perr
	}
	return err
}

// allOutcome is the error (and so the exit code) for a batch: interrupted, or a tool error when any
// run didn't complete.
func allOutcome(ctx context.Context, rows []*allResult) error {
	if ctx.Err() != nil {
		return &ExitError{Code: ExitInterrupted}
	}
	for _, r := range rows {
		if r.Status != results.StatusComplete && r.Status != "skipped" && r.Status != "would run" {
			return &ExitError{Code: ExitToolError}
		}
	}
	return nil
}

// writeLine prints one compact JSON line, for -f jsonl.
func (a *App) writeLine(v any) {
	b, _ := json.Marshal(v)
	fmt.Fprintln(a.Out, string(b))
}

// writeSummary ends a jsonl stream with the counts by status and the exit code ot returns.
func (a *App) writeSummary(rows []*allResult, outcome error) error {
	sum := map[string]int{"total": len(rows), "exit_code": ExitOK}
	for _, r := range rows {
		sum[r.Status]++
	}
	if outcome != nil {
		sum["exit_code"] = ExitCodeFor(outcome)
	}
	a.writeLine(map[string]any{"summary": sum})
	return nil
}

// printAllRows prints the summary of --all, a playbook or auto.
func (a *App) printAllRows(rows []*allResult, format string) error {
	if format == "json" {
		return newJSONEncoder(a.Out).Encode(rows)
	}
	tw := tabwriter.NewWriter(a.Out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(tw, "TOOL\tSTATUS\tENTITIES\tSAVED")
	for _, r := range rows {
		saved := r.OutputPath
		if r.Reason != "" {
			saved = r.Reason
		}
		status := r.Status
		if r.ExitCode != nil && *r.ExitCode != 0 {
			status = fmt.Sprintf("%s (exit %d)", status, *r.ExitCode)
		}
		fmt.Fprintf(tw, "%s\t%s\t%d\t%s\n", r.Tool, status, r.Entities, saved)
	}
	return tw.Flush()
}

// typedTypes names the input types of typed inputs: "username or email".
func typedTypes(typed []runner.TypedInput) string {
	var types []string
	for _, t := range typed {
		types = append(types, runner.TypedPrefixes[t.Prefix])
	}
	return strings.Join(types, " or ")
}
