// Package envelope defines the normalized result format every `ot run` produces.
package envelope

import (
	"bufio"
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
)

// Version is the envelope format version.
const Version = 1

type Envelope struct {
	Envelope   int               `json:"envelope"`
	Tool       string            `json:"tool"`
	Runtime    string            `json:"runtime"`
	Input      map[string]string `json:"input"`
	StartedAt  time.Time         `json:"started_at"`
	DurationMS int64             `json:"duration_ms"`
	ExitCode   int               `json:"exit_code"`
	Entities   []Entity          `json:"entities"`
	Raw        any               `json:"raw"`
	Warnings   []string          `json:"warnings"`
	// Provenance, added within version 1 (readers ignore keys they don't know).
	EndedAt   time.Time `json:"ended_at"`
	RunID     string    `json:"run_id,omitempty"`
	OTVersion string    `json:"ot_version,omitempty"`
	Client    string    `json:"client,omitempty"` // cli, ci or mcp
	Artifact  *Artifact `json:"artifact,omitempty"`
	Output    *Output   `json:"output,omitempty"`
}

// Artifact is what exactly ran.
type Artifact struct {
	Kind       string `json:"kind"` // image or wheel
	Ref        string `json:"ref"`  // the image pinned by digest, or the wheel's sha256
	Signer     string `json:"signer,omitempty"`
	FromBackup bool   `json:"from_backup,omitempty"`
}

// Output describes the tool's stdout as produced, before parsing.
type Output struct {
	SHA256     string `json:"sha256"`
	Bytes      int64  `json:"bytes"`
	Path       string `json:"path,omitempty"`
	MetaPath   string `json:"meta_path,omitempty"`
	RawOmitted bool   `json:"raw_omitted,omitempty"`
}

type Entity struct {
	Type       string         `json:"type"`
	Value      string         `json:"value"`
	Source     string         `json:"source,omitempty"`
	Confidence string         `json:"confidence,omitempty"`
	Attrs      map[string]any `json:"attrs,omitempty"`
}

// ParseOutput turns a tool's stdout into the raw payload and, when the tool already emits
// envelope-shaped output (an object or JSON lines carrying "entities"), its entities.
func ParseOutput(format string, stdout []byte) (raw any, entities []Entity, warnings []string) {
	entities = []Entity{}
	switch format {
	case "json":
		var v any
		if err := json.Unmarshal(stdout, &v); err != nil {
			return string(stdout), entities, []string{"output was not valid JSON; kept as text"}
		}
		if found := extract(v); found != nil {
			entities = found
		}
		return v, entities, nil
	case "jsonl":
		var items []any
		sc := bufio.NewScanner(bytes.NewReader(stdout))
		sc.Buffer(make([]byte, 1024*1024), 16*1024*1024)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			var v any
			if err := json.Unmarshal([]byte(line), &v); err != nil {
				warnings = append(warnings, "skipped a line that was not valid JSON")
				continue
			}
			items = append(items, v)
			entities = append(entities, extract(v)...)
		}
		return items, entities, warnings
	case "csv":
		rows, err := csv.NewReader(bytes.NewReader(stdout)).ReadAll()
		if err != nil || len(rows) == 0 {
			return string(stdout), entities, []string{"output was not valid CSV; kept as text"}
		}
		header, recs := rows[0], []map[string]string{}
		for _, r := range rows[1:] {
			rec := map[string]string{}
			for i, h := range header {
				if i < len(r) {
					rec[h] = r[i]
				}
			}
			recs = append(recs, rec)
		}
		return recs, entities, nil
	default:
		return string(stdout), entities, nil
	}
}

// extract reads entities from tool output that follows the envelope convention.
func extract(v any) []Entity {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	list, ok := obj["entities"].([]any)
	if !ok {
		// A single entity per JSON line is also allowed.
		if _, hasType := obj["type"].(string); hasType {
			if _, hasValue := obj["value"].(string); hasValue {
				list = []any{obj}
			}
		}
	}
	var out []Entity
	for _, item := range list {
		b, _ := json.Marshal(item)
		var e Entity
		if json.Unmarshal(b, &e) == nil && e.Type != "" && e.Value != "" {
			out = append(out, e)
		}
	}
	return out
}

// Write renders the envelope in the requested format: json, table, csv or raw.
func (e *Envelope) Write(w io.Writer, format string) error {
	switch format {
	case "", "json":
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(e)
	case "raw":
		if s, ok := e.Raw.(string); ok {
			_, err := io.WriteString(w, s)
			return err
		}
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		return enc.Encode(e.Raw)
	case "csv":
		cw := csv.NewWriter(w)
		cw.Write([]string{"type", "value", "source", "confidence"})
		for _, en := range e.Entities {
			cw.Write([]string{en.Type, en.Value, en.Source, en.Confidence})
		}
		cw.Flush()
		return cw.Error()
	case "table":
		if len(e.Entities) == 0 {
			fmt.Fprintf(w, "%s returned no structured entities; use --format raw to see its output.\n", e.Tool)
			return nil
		}
		tw := tabwriter.NewWriter(w, 0, 4, 2, ' ', 0)
		fmt.Fprintln(tw, "TYPE\tVALUE\tSOURCE\tCONFIDENCE")
		ents := append([]Entity(nil), e.Entities...)
		sort.SliceStable(ents, func(i, j int) bool { return ents[i].Type < ents[j].Type })
		for _, en := range ents {
			fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", en.Type, en.Value, en.Source, en.Confidence)
		}
		return tw.Flush()
	}
	return fmt.Errorf("unknown format %q (use json, table, csv or raw)", format)
}
