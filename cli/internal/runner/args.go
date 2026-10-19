// Package runner installs and runs packages with Docker or pipx.
package runner

import (
	"fmt"
	"net/mail"
	"regexp"
	"strconv"
	"strings"

	"github.com/osintverse/otinstaller/cli/internal/manifest"
)

var placeholderRe = regexp.MustCompile(`\{[^{}]*\}`)

// UsageError is a problem with what the user passed on the command line (exit code 2).
type UsageError struct{ Msg string }

func (e *UsageError) Error() string { return e.Msg }

// ResolveInputs checks user values against the manifest and fills defaults.
func ResolveInputs(m *manifest.Manifest, given map[string]string) (map[string]string, error) {
	out := map[string]string{}
	for name := range given {
		if m.Input(name) == nil {
			return nil, &UsageError{fmt.Sprintf("%s has no input named --%s (inputs: %s)", m.Ref(), name, inputList(m))}
		}
	}
	for _, in := range m.Inputs {
		v, ok := given[in.Name]
		if !ok {
			if in.Default != nil {
				out[in.Name] = fmt.Sprint(in.Default)
			} else if in.Required {
				return nil, &UsageError{fmt.Sprintf("missing required input --%s (%s)", in.Name, in.Type)}
			}
			continue
		}
		if err := checkType(in, v); err != nil {
			return nil, &UsageError{fmt.Sprintf("--%s: %v", in.Name, err)}
		}
		out[in.Name] = v
	}
	return out, nil
}

func inputList(m *manifest.Manifest) string {
	var names []string
	for _, in := range m.Inputs {
		names = append(names, "--"+in.Name)
	}
	return strings.Join(names, ", ")
}

func checkType(in manifest.Input, v string) error {
	switch in.Type {
	case "email":
		if a, err := mail.ParseAddress(v); err != nil || a.Address != v {
			return fmt.Errorf("%q is not an email address", v)
		}
	case "integer":
		if _, err := strconv.Atoi(v); err != nil {
			return fmt.Errorf("%q is not an integer", v)
		}
	case "boolean":
		if _, err := strconv.ParseBool(v); err != nil {
			return fmt.Errorf("%q is not true or false", v)
		}
	case "enum":
		for _, allowed := range in.Values {
			if v == allowed {
				return nil
			}
		}
		return fmt.Errorf("%q is not one of %s", v, strings.Join(in.Values, ", "))
	}
	if strings.ContainsRune(v, 0) {
		return fmt.Errorf("value contains a NUL byte")
	}
	return nil
}

// BuildCommand substitutes input values into the manifest's command. Each value becomes part of
// a single argv element and is never passed through a shell, so values cannot inject commands.
//
// An argument that refers to an optional input the user left out (and that has no default) is
// dropped. When that argument is exactly the placeholder, the flag right before it is dropped too,
// so ["--region", "{region}"] disappears as a pair.
func BuildCommand(m *manifest.Manifest, values map[string]string) []string {
	cmd := m.Runtime.Command
	drop := make([]bool, len(cmd))
	for i, arg := range cmd {
		for _, name := range manifest.Placeholders(arg) {
			if _, ok := values[name]; !ok {
				drop[i] = true
				if arg == "{"+name+"}" && i > 0 && strings.HasPrefix(cmd[i-1], "-") && len(manifest.Placeholders(cmd[i-1])) == 0 {
					drop[i-1] = true
				}
			}
		}
	}
	var out []string
	for i, arg := range cmd {
		if drop[i] {
			continue
		}
		// One pass, so a value that itself contains "{other}" is never expanded again.
		arg = placeholderRe.ReplaceAllStringFunc(arg, func(ph string) string {
			if v, ok := values[ph[1:len(ph)-1]]; ok {
				return v
			}
			return ph
		})
		out = append(out, arg)
	}
	return out
}
