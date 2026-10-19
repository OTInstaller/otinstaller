package manifest

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const fixtures = "../../../spec/fixtures"

func TestValidFixtures(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(fixtures, "valid", "*.yaml"))
	if len(files) == 0 {
		t.Fatal("no valid fixtures found")
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			doc, m, err := LoadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			if ps := Validate(doc, m, Options{Tag: "v" + m.Version}); len(ps) > 0 {
				for _, p := range ps {
					t.Error(p)
				}
			}
		})
	}
}

// Each invalid fixture starts with "# expect: <code>"; the first problem reported must carry that code.
func TestInvalidFixtures(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(fixtures, "invalid", "*.yaml"))
	if len(files) < 20 {
		t.Fatalf("expected at least 20 invalid fixtures, found %d", len(files))
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			data, err := os.ReadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			first, _, _ := strings.Cut(string(data), "\n")
			want := strings.TrimSpace(strings.TrimPrefix(first, "# expect:"))
			doc, m, err := Parse(data)
			var ps []*Problem
			if err != nil {
				p, ok := err.(*Problem)
				if !ok {
					t.Fatal(err)
				}
				ps = []*Problem{p}
			} else {
				ps = Validate(doc, m, Options{})
			}
			if len(ps) == 0 {
				t.Fatalf("expected %s, got no problems", want)
			}
			if ps[0].Code != want {
				t.Errorf("expected %s, got %s", want, ps[0].Code)
				for _, p := range ps {
					t.Log(p)
				}
			}
		})
	}
}

func TestTagMismatch(t *testing.T) {
	doc, m, err := LoadFile(filepath.Join(fixtures, "valid", "docker-tool.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	ps := Validate(doc, m, Options{Tag: "v9.9.9"})
	if len(ps) != 1 || ps[0].Code != CodeTagMismatch {
		t.Fatalf("expected one %s, got %v", CodeTagMismatch, ps)
	}
}

func TestFileChecks(t *testing.T) {
	dir := t.TempDir()
	src, _ := os.ReadFile(filepath.Join(fixtures, "valid", "pipx-tool.yaml"))
	doc, m, err := Parse(src)
	if err != nil {
		t.Fatal(err)
	}
	ps := Validate(doc, m, Options{Dir: dir})
	if len(ps) != 3 { // README.md + two docs pages
		t.Fatalf("expected 3 missing files, got %v", ps)
	}
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("# x"), 0o644)
	os.MkdirAll(filepath.Join(dir, "docs"), 0o755)
	for _, p := range []string{"usage.md", "output-fields.md"} {
		os.WriteFile(filepath.Join(dir, "docs", p), []byte("# x"), 0o644)
	}
	if ps := Validate(doc, m, Options{Dir: dir}); len(ps) != 0 {
		t.Fatalf("expected no problems, got %v", ps)
	}
}

// The CLI embeds a copy of the spec's schema; they must not drift.
func TestEmbeddedSchemaMatchesSpec(t *testing.T) {
	spec, err := os.ReadFile("../../../spec/schema/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	norm := func(b []byte) []byte { return bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n")) }
	if !bytes.Equal(norm(spec), norm(schemaJSON)) {
		t.Fatal("cli/internal/manifest/schema/v1.json is out of date; run `go generate ./...` in cli/")
	}
}
