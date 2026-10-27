// Package share builds what `ot share` uploads (spec/schema/share-v1.json) from saved runs, and keeps the local
// record of the shares made from this machine, with the delete token each one came with.
package share

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/envelope"
	"github.com/otinstaller/otinstaller/cli/internal/results"
	"github.com/otinstaller/otinstaller/cli/internal/state"
)

// Limits the registry enforces (api/src/shares.ts), checked here first so a share that is too big fails before the
// upload.
const (
	MaxRuns  = 50
	MaxBytes = 5 << 20
	// MaxRaw is the most of one run's output a share carries as raw; larger outputs are left out (raw_omitted), and
	// the run's entities still go.
	MaxRaw = 1 << 20
	// TTL is how long a link works.
	TTL = 24 * time.Hour
)

// Payload is one share: share-v1.
type Payload struct {
	Share  int    `json:"share"`
	Source string `json:"source"`
	Runs   []Run  `json:"runs"`
}

// Run is a saved run's envelope without what only means something on this machine: the run id, the case name, the
// command line and the file paths.
type Run struct {
	Envelope   int                `json:"envelope"`
	Tool       string             `json:"tool"`
	Runtime    string             `json:"runtime"`
	Input      map[string]string  `json:"input"`
	StartedAt  time.Time          `json:"started_at"`
	EndedAt    time.Time          `json:"ended_at"`
	DurationMS int64              `json:"duration_ms"`
	ExitCode   int                `json:"exit_code"`
	Status     string             `json:"status,omitempty"`
	Entities   []envelope.Entity  `json:"entities"`
	Raw        any                `json:"raw"`
	Warnings   []string           `json:"warnings"`
	OTVersion  string             `json:"ot_version,omitempty"`
	Client     string             `json:"client,omitempty"`
	Artifact   *envelope.Artifact `json:"artifact,omitempty"`
	Output     *Output            `json:"output,omitempty"`
}

// Output describes the tool's stdout, without where it was saved.
type Output struct {
	SHA256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	RawOmitted bool   `json:"raw_omitted,omitempty"`
}

// FromSaved is the share of one saved run: output is the saved output file, meta its sidecar.
func FromSaved(output string, meta *results.Meta) (Run, error) {
	tool := meta.Ref
	if tool == "" {
		tool = meta.Tool
	}
	if meta.ToolVersion != "" {
		tool += "@" + meta.ToolVersion
	}
	r := Run{
		Envelope: envelope.Version, Tool: tool, Runtime: meta.Runtime, Input: meta.Input,
		StartedAt: meta.StartedAt, EndedAt: meta.EndedAt, DurationMS: int64(meta.DurationSeconds * 1000), ExitCode: meta.ExitCode,
		Status: meta.Status, Entities: meta.Entities, Warnings: append([]string{}, meta.Warnings...),
		OTVersion: meta.OTVersion, Client: meta.Client, Artifact: meta.Artifact,
		Output: &Output{SHA256: meta.SHA256, Bytes: meta.Bytes},
	}
	if r.Input == nil {
		r.Input = map[string]string{}
	}
	if r.Entities == nil {
		r.Entities = []envelope.Entity{}
	}
	info, err := os.Stat(output)
	if err != nil {
		return r, err
	}
	if info.Size() > MaxRaw {
		r.Output.RawOmitted = true
		r.Warnings = append(r.Warnings, fmt.Sprintf("raw left out of the share: the output is %d bytes, over %d", info.Size(), MaxRaw))
		return r, nil
	}
	b, err := os.ReadFile(output)
	if err != nil {
		return r, err
	}
	raw, _, _ := envelope.ParseOutput(formatOf(output), b)
	r.Raw = raw
	return r, nil
}

// formatOf is the output_format a saved file was written in, from its extension (results.Ext).
func formatOf(path string) string {
	switch ext := strings.TrimPrefix(filepath.Ext(path), "."); ext {
	case "json", "jsonl", "csv":
		return ext
	}
	return "text"
}

// Encode is the upload's body, refused when it is over the registry's limits.
func Encode(p Payload) ([]byte, error) {
	if len(p.Runs) == 0 {
		return nil, errors.New("nothing to share")
	}
	if len(p.Runs) > MaxRuns {
		return nil, fmt.Errorf("%d runs is more than one share takes (%d); share them in parts", len(p.Runs), MaxRuns)
	}
	b, err := json.Marshal(p)
	if err != nil {
		return nil, err
	}
	if len(b) > MaxBytes {
		return nil, fmt.Errorf("the share would be %.1f MB, over the %d MB limit; share fewer runs at once", float64(len(b))/(1<<20), MaxBytes>>20)
	}
	return b, nil
}

// Tools are the distinct tool names in a payload, in order, without namespaces or versions: what a person reads.
func Tools(p Payload) []string {
	var out []string
	seen := map[string]bool{}
	for _, r := range p.Runs {
		name := strings.SplitN(r.Tool, "@", 2)[0]
		if i := strings.LastIndexByte(name, '/'); i >= 0 {
			name = name[i+1:]
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

// Inputs are the distinct input values in a payload, sorted: the targets the share names.
func Inputs(p Payload) []string {
	seen := map[string]bool{}
	var out []string
	for _, r := range p.Runs {
		for _, v := range r.Input {
			if v != "" && !seen[v] {
				seen[v] = true
				out = append(out, v)
			}
		}
	}
	sort.Strings(out)
	return out
}

// ---------- the local record ----------

// Saved is a share made from this machine. DeleteToken deletes it without signing in.
type Saved struct {
	ID          string   `json:"id"`
	URL         string   `json:"url"`
	DeleteToken string   `json:"delete_token"`
	CreatedAt   int64    `json:"created_at"`
	ExpiresAt   int64    `json:"expires_at"`
	Tools       []string `json:"tools"`
	Owned       bool     `json:"owned"`
}

func recordPath() string { return state.Path("shares.json") }

// Load lists the shares made from this machine that still work, newest first. Expired ones are dropped from the file.
func Load() ([]Saved, error) {
	b, err := os.ReadFile(recordPath())
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var all []Saved
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, fmt.Errorf("%s is not valid JSON: %w", recordPath(), err)
	}
	now := time.Now().UnixMilli()
	live := all[:0]
	for _, s := range all {
		if s.ExpiresAt > now {
			live = append(live, s)
		}
	}
	if len(live) != len(all) {
		_ = save(live)
	}
	sort.SliceStable(live, func(i, j int) bool { return live[i].CreatedAt > live[j].CreatedAt })
	return live, nil
}

// Remember adds a share to the record.
func Remember(s Saved) error {
	list, err := Load()
	if err != nil {
		return err
	}
	return save(append(list, s))
}

// Forget removes a share from the record.
func Forget(id string) error {
	list, err := Load()
	if err != nil {
		return err
	}
	keep := list[:0]
	for _, s := range list {
		if s.ID != id {
			keep = append(keep, s)
		}
	}
	return save(keep)
}

// save writes the record atomically, readable only by its owner: the delete tokens are credentials.
func save(list []Saved) error {
	if err := os.MkdirAll(state.Home(), 0o700); err != nil {
		return err
	}
	if list == nil {
		list = []Saved{}
	}
	b, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	tmp := recordPath() + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, recordPath())
}
