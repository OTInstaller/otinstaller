// Package results saves each run's raw output with a .meta.json sidecar, in the layout the Python
// otinstaller used (see docs/typed-inputs-and-results.md).
package results

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/envelope"
)

// Dir is where results go: flag, then $OT_RESULTS_DIR, then $OTINSTALLER_RESULTS_DIR, then ./results.
func Dir(flag string) string {
	for _, v := range []string{flag, os.Getenv("OT_RESULTS_DIR"), os.Getenv("OTINSTALLER_RESULTS_DIR")} {
		if v != "" {
			return expandHome(v)
		}
	}
	return "results"
}

func expandHome(p string) string {
	if p == "~" || strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, p[1:])
		}
	}
	return p
}

var (
	unsafeRe     = regexp.MustCompile(`[^a-z0-9._-]`)
	underscoreRe = regexp.MustCompile(`_+`)
)

// Sanitize makes a value safe as one path component: lowercased, anything outside [a-z0-9._-]
// becomes _, runs of _ collapse, leading/trailing _ . - are stripped, at most 80 characters.
func Sanitize(v string) string {
	v = unsafeRe.ReplaceAllString(strings.ToLower(v), "_")
	v = strings.Trim(underscoreRe.ReplaceAllString(v, "_"), "_.-")
	if len(v) > 80 {
		v = v[:80]
	}
	if v == "" {
		return "target"
	}
	return v
}

// Ext is the output file extension for a manifest output_format.
func Ext(format string) string {
	switch format {
	case "json", "jsonl", "csv":
		return format
	}
	return "txt"
}

// Meta is the .meta.json sidecar.
type Meta struct {
	Command         []string          `json:"command"`
	Tool            string            `json:"tool"`
	Ref             string            `json:"ref"`
	ToolVersion     string            `json:"tool_version"`
	Runtime         string            `json:"runtime"`
	Target          string            `json:"target"`
	Case            *string           `json:"case"`
	Input           map[string]string `json:"input"`
	StartedAt       time.Time         `json:"started_at"`
	EndedAt         time.Time         `json:"ended_at"`
	DurationSeconds float64           `json:"duration_seconds"`
	ExitCode        int               `json:"exit_code"`
	Status          string            `json:"status"`
	OutputPath      string            `json:"output_path"`
	SHA256          string            `json:"sha256"`
	Bytes           int64             `json:"bytes"`
	StderrPath      string            `json:"stderr_path,omitempty"`
	MetaPath        string            `json:"-"`
	Envelope        int               `json:"envelope"`
	Entities        []envelope.Entity `json:"entities"`
	Warnings        []string          `json:"warnings"`
}

// Statuses a run can end with.
const (
	StatusComplete    = "complete"
	StatusFailed      = "failed"
	StatusTimeout     = "timeout"
	StatusInterrupted = "interrupted"
)

// Run is one run being saved. Write the tool's stdout to Stdout and its stderr to Stderr, then
// call Finish.
type Run struct {
	OutputPath, MetaPath, StderrPath string

	out     *os.File
	werr    error // first write error; the tool keeps running and Finish reports it
	hash    hash.Hash
	n       int64
	stderr  *lazyFile
	started time.Time
}

// Start creates the output file for a run of tool (the package name) against target.
func Start(dir, tool, target, caseName, format string) (*Run, error) {
	base := dir
	if caseName != "" {
		base = filepath.Join(base, "cases", Sanitize(caseName))
	}
	tool, target = Sanitize(tool), Sanitize(target)
	folder := filepath.Join(base, tool, target)
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return nil, fmt.Errorf("can't save results in %s (%v); choose another folder with --results-dir or OT_RESULTS_DIR, or pass --no-save", dir, unwrapPathErr(err))
	}
	now := time.Now().UTC()
	stem := filepath.Join(folder, fmt.Sprintf("%s_%s_%s_%s", now.Format("20060102-150405"), tool, target, runID()))
	f, err := os.OpenFile(stem+"."+Ext(format), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, err
	}
	return &Run{
		OutputPath: f.Name(),
		MetaPath:   stem + ".meta.json",
		StderrPath: stem + ".stderr.txt",
		out:        f,
		hash:       sha256.New(),
		stderr:     &lazyFile{path: stem + ".stderr.txt"},
		started:    now,
	}, nil
}

func unwrapPathErr(err error) error {
	if pe, ok := err.(*os.PathError); ok {
		return pe.Err
	}
	return err
}

func runID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Stdout receives the tool's output; it is written to disk and hashed as it arrives.
func (r *Run) Stdout() io.Writer { return stdoutWriter{r} }

// Stderr receives the tool's stderr; the file is only created if something is written.
func (r *Run) Stderr() io.Writer { return r.stderr }

type stdoutWriter struct{ r *Run }

// Write never fails, so a full disk can't break the run itself; Finish returns the error.
func (w stdoutWriter) Write(p []byte) (int, error) {
	if w.r.werr == nil {
		n, err := w.r.out.Write(p)
		w.r.hash.Write(p[:n])
		w.r.n += int64(n)
		w.r.werr = err
	}
	return len(p), nil
}

// Finish closes the files and writes the sidecar. meta's Status, ExitCode, Command and the
// envelope fields are filled by the caller; paths, hash, size and timing are filled here.
func (r *Run) Finish(meta *Meta) error {
	cerr := r.out.Close()
	r.stderr.Close()
	ended := time.Now().UTC()
	meta.StartedAt = r.started
	meta.EndedAt = ended
	meta.DurationSeconds = float64(ended.Sub(r.started).Milliseconds()) / 1000
	meta.OutputPath = filepath.ToSlash(r.OutputPath)
	meta.SHA256 = hex.EncodeToString(r.hash.Sum(nil))
	meta.Bytes = r.n
	meta.MetaPath = filepath.ToSlash(r.MetaPath)
	if r.stderr.f != nil {
		meta.StderrPath = filepath.ToSlash(r.StderrPath)
	}
	if meta.Entities == nil {
		meta.Entities = []envelope.Entity{}
	}
	if meta.Warnings == nil {
		meta.Warnings = []string{}
	}
	if meta.Input == nil {
		meta.Input = map[string]string{}
	}
	b, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(r.MetaPath, append(b, '\n'), 0o644); err != nil {
		return err
	}
	return cerr
}

// Discard closes and removes the run's files, for a tool that never started.
func (r *Run) Discard() {
	r.out.Close()
	r.stderr.Close()
	os.Remove(r.OutputPath)
	os.Remove(r.StderrPath)
}

// lazyFile creates its file on the first non-empty write.
type lazyFile struct {
	path string
	f    *os.File
	err  error
}

func (l *lazyFile) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if l.f == nil && l.err == nil {
		l.f, l.err = os.Create(l.path)
	}
	if l.err == nil {
		_, l.err = l.f.Write(p)
	}
	return len(p), nil
}

func (l *lazyFile) Close() {
	if l.f != nil {
		l.f.Close()
	}
}
