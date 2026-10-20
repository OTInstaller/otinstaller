package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"text/tabwriter"

	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/runner"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// allResult is one row of the `ot run --all` summary.
type allResult struct {
	Tool       string `json:"tool"`
	Version    string `json:"version"`
	Status     string `json:"status"` // a results status, "skipped" or "error"
	ExitCode   *int   `json:"exit_code,omitempty"`
	Entities   int    `json:"entities"`
	OutputPath string `json:"output_path,omitempty"`
	MetaPath   string `json:"meta_path,omitempty"`
	Reason     string `json:"reason,omitempty"`
}

type allJob struct {
	inst    *state.Installed
	values  map[string]string
	secrets map[string]string
	target  string
	row     *allResult
}

// runAll runs every installed tool that has an input of one of the given types, in parallel.
func (a *App) runAll(ctx context.Context, ra *runArgs) error {
	if len(ra.Typed) == 0 {
		return exitErr(ExitUsage, "--all needs at least one typed input, such as u:johndoe or d:example.com")
	}
	if len(ra.Inputs) > 0 || ra.Output != "" || ra.OutDir != "" {
		return exitErr(ExitUsage, "--all takes only typed inputs (u:, d:, e:, p:, url:), not --<input>, -o or --out-dir")
	}
	if ra.NoSave {
		return exitErr(ExitUsage, "--all always saves its runs; the summary only points at the saved files")
	}
	format := orDefault(ra.Format, "table")
	if format != "table" && format != "json" {
		return exitErr(ExitUsage, "--all prints a summary as table or json, not %q", format)
	}
	st, err := state.Load()
	if err != nil {
		return err
	}

	var rows []*allResult
	var jobs []allJob
	for _, inst := range st.Sorted() {
		m := inst.Manifest
		if m == nil || m.IsGuide() || m.Runtime == nil {
			continue
		}
		row := &allResult{Tool: m.Ref(), Version: inst.Version}
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
		var types []string
		for _, t := range ra.Typed {
			types = append(types, runner.TypedPrefixes[t.Prefix])
		}
		return exitErr(ExitUsage, "no installed tool has a %s input; find some with `ot search`", strings.Join(types, " or "))
	}

	if format == "table" {
		fmt.Fprintf(a.Err, "Running %d tools, %d at a time...\n", len(jobs), ra.Parallel)
	}
	sem := make(chan struct{}, ra.Parallel)
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func(j allJob) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if ctx.Err() != nil {
				j.row.Status, j.row.Reason = results.StatusInterrupted, "not started"
				return
			}
			// Parallel runs would interleave on the terminal, so stderr only goes to the saved file.
			env, meta, err := a.execute(ctx, j.inst, j.values, j.secrets, j.target, ra, io.Discard)
			if meta != nil {
				j.row.Status, j.row.Entities = meta.Status, len(meta.Entities)
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

	if format == "json" {
		if err := newJSONEncoder(a.Out).Encode(rows); err != nil {
			return err
		}
	} else {
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
		tw.Flush()
	}
	if ctx.Err() != nil {
		return &ExitError{Code: ExitInterrupted}
	}
	for _, r := range rows {
		if r.Status != results.StatusComplete && r.Status != "skipped" {
			return &ExitError{Code: ExitToolError}
		}
	}
	return nil
}
