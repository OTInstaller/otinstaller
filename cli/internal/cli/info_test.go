package cli

import (
	"bytes"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

// `ot info` ends with a command that runs as printed, and says how to set a key.
func TestPrintInfoShowsRunnableCommandAndKeyHint(t *testing.T) {
	_, m, err := manifest.LoadFile("../../../spec/fixtures/valid/docker-tool.yaml")
	if err != nil {
		t.Fatal(err)
	}
	m.Secrets = append(m.Secrets, manifest.Secret{Name: "EXAMPLE_KEY", Required: true, URL: "https://example.com/keys"})
	var out bytes.Buffer
	printInfo(&out, m, nil)
	s := out.String()
	if !strings.Contains(s, "Run:     ot run "+m.Ref()+" e:") {
		t.Fatalf("expected a typed example run, got:\n%s", s)
	}
	if !strings.Contains(s, "set it with `ot keys set EXAMPLE_KEY` (get one at https://example.com/keys)") {
		t.Fatalf("expected the keys hint, got:\n%s", s)
	}
}
