package runner

import (
	"errors"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

func TestParseTypedInput(t *testing.T) {
	for arg, want := range map[string]TypedInput{
		"u:johndoe":               {"u", "johndoe"},
		"d:example.com":           {"d", "example.com"},
		"e:a@b.com":               {"e", "a@b.com"},
		"p:+14155550100":          {"p", "+14155550100"},
		"url:https://example.com": {"url", "https://example.com"},
	} {
		got, ok, err := ParseTypedInput(arg)
		if err != nil || !ok || got != want {
			t.Errorf("%s: got %+v %v %v", arg, got, ok, err)
		}
	}
	// Not typed inputs: no prefix, an unknown prefix, a Windows drive.
	for _, arg := range []string{"johndoe", "x:1", `C:\tools\otinstaller.yaml`} {
		if _, ok, err := ParseTypedInput(arg); ok || err != nil {
			t.Errorf("%s: read as a typed input", arg)
		}
	}
	var ue *UsageError
	if _, _, err := ParseTypedInput("u:"); !errors.As(err, &ue) {
		t.Errorf("u: with no value: %v", err)
	}
}

func TestApplyTyped(t *testing.T) {
	m := load(t, "docker-tool.yaml") // one email input
	got, target, err := ApplyTyped(m, map[string]string{"timeout": "5"}, []TypedInput{{"e", "a@b.com"}})
	if err != nil || got["email"] != "a@b.com" || got["timeout"] != "5" || target != "a@b.com" {
		t.Fatalf("got %v %q %v", got, target, err)
	}
	var ue *UsageError
	if _, _, err := ApplyTyped(m, nil, []TypedInput{{"u", "johndoe"}}); !errors.As(err, &ue) || !strings.Contains(err.Error(), "no username input") {
		t.Errorf("no input of the type: %v", err)
	}
	if _, _, err := ApplyTyped(m, map[string]string{"email": "x@y.z"}, []TypedInput{{"e", "a@b.com"}}); !errors.As(err, &ue) {
		t.Errorf("input given twice: %v", err)
	}
	two := *m
	two.Inputs = append([]manifest.Input{{Name: "from", Type: "email"}}, m.Inputs...)
	if _, _, err := ApplyTyped(&two, nil, []TypedInput{{"e", "a@b.com"}}); !errors.As(err, &ue) || !strings.Contains(err.Error(), "several") {
		t.Errorf("two email inputs: %v", err)
	}
}
