package runner

import (
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

func TestExampleCommandUsesTypedInputAndTestValues(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	got := ExampleCommand(m)
	if !strings.HasPrefix(got, "ot run "+m.Ref()+" e:") {
		t.Fatalf("one required email input should become a typed e: value, got %q", got)
	}
	if m.Test != nil {
		if want, ok := m.Test.Input["email"]; ok && !strings.Contains(got, "e:"+want.(string)) {
			t.Fatalf("the test input should be the example value, got %q", got)
		}
	}
	// Two required inputs fall back to --name value for each.
	two := &manifest.Manifest{Name: "x", Namespace: "ns", Inputs: []manifest.Input{{Name: "domain", Type: "domain", Required: true}, {Name: "port", Type: "integer", Required: true}}}
	if got := ExampleCommand(two); got != "ot run ns/x --domain example.com --port 10" {
		t.Fatalf("got %q", got)
	}
	// A value with spaces is quoted; an unknown type keeps a placeholder.
	odd := &manifest.Manifest{Name: "x", Namespace: "ns", Inputs: []manifest.Input{{Name: "who", Type: "name", Required: true}, {Name: "blob", Type: "enum", Required: true}}}
	if got := ExampleCommand(odd); got != `ot run ns/x --who "Jane Doe" --blob <enum>` {
		t.Fatalf("got %q", got)
	}
}

func TestMissingInputSuggestsTheCommand(t *testing.T) {
	m := load(t, "docker-tool.yaml")
	_, err := ResolveInputs(m, map[string]string{})
	if err == nil || !strings.Contains(err.Error(), "for example: ot run "+m.Ref()+" e:") {
		t.Fatalf("expected the example command in the error, got %v", err)
	}
}

func TestPrefixFor(t *testing.T) {
	for typ, want := range map[string]string{"domain": "d", "email": "e", "username": "u", "phone": "p", "ip": "ip", "url": "url", "hash": ""} {
		if got := PrefixFor(typ); got != want {
			t.Errorf("PrefixFor(%q) = %q, want %q", typ, got, want)
		}
	}
}
