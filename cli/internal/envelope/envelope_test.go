package envelope

import (
	"bytes"
	"strings"
	"testing"
)

func TestParseOutput(t *testing.T) {
	_, ents, _ := ParseOutput("json", []byte(`{"entities":[{"type":"account","value":"x"},{"type":"","value":"skipped"}]}`))
	if len(ents) != 1 || ents[0].Value != "x" {
		t.Fatalf("json: %v", ents)
	}
	_, ents, warns := ParseOutput("jsonl", []byte("{\"type\":\"email\",\"value\":\"a@b.com\"}\nnot json\n{\"type\":\"domain\",\"value\":\"b.com\"}\n"))
	if len(ents) != 2 || len(warns) != 1 {
		t.Fatalf("jsonl: %v %v", ents, warns)
	}
	raw, ents, _ := ParseOutput("csv", []byte("site,exists\ngithub,true\n"))
	if recs := raw.([]map[string]string); len(recs) != 1 || recs[0]["site"] != "github" || len(ents) != 0 {
		t.Fatalf("csv: %v", raw)
	}
	raw, _, warns = ParseOutput("json", []byte("oops"))
	if raw != "oops" || len(warns) != 1 {
		t.Fatalf("invalid json should be kept as text with a warning")
	}
}

func TestWriteFormats(t *testing.T) {
	e := &Envelope{Envelope: Version, Tool: "a/b@1.0.0", Entities: []Entity{{Type: "account", Value: "x", Source: "github"}}, Raw: "raw text", Warnings: []string{}}
	for format, want := range map[string]string{
		"json":  `"envelope": 1`,
		"table": "TYPE",
		"csv":   "type,value,source,confidence\naccount,x,github,",
		"raw":   "raw text",
	} {
		var b bytes.Buffer
		if err := e.Write(&b, format); err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(b.String(), want) {
			t.Errorf("%s output %q does not contain %q", format, b.String(), want)
		}
	}
	if err := e.Write(&bytes.Buffer{}, "xml"); err == nil {
		t.Error("expected an error for an unknown format")
	}
}
