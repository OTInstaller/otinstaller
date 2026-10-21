package manifest

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

// Error codes. Each one is documented at https://otinstaller.com/docs/errors#<code>.
const (
	CodeYAMLInvalid        = "manifest_yaml_invalid"
	CodeTooLarge           = "manifest_too_large"
	CodeSchema             = "manifest_schema"
	CodeSchemaVersion      = "manifest_schema_version"
	CodeNameInvalid        = "manifest_name_invalid"
	CodeVersionInvalid     = "manifest_version_invalid"
	CodeLicenseInvalid     = "manifest_license_invalid"
	CodeImageNotPinned     = "manifest_image_not_pinned"
	CodePlatformMissing    = "manifest_platform_missing"
	CodePlaceholderUnknown = "manifest_placeholder_unknown"
	CodeInputDuplicate     = "manifest_input_duplicate"
	CodeSecretDuplicate    = "manifest_secret_duplicate"
	CodeTestInputUnknown   = "manifest_test_input_unknown"
	CodeTestInputMissing   = "manifest_test_input_missing"
	CodeTagMismatch        = "manifest_tag_mismatch"
	CodeFileMissing        = "manifest_file_missing"
)

// Problem is one validation failure.
type Problem struct {
	Code    string `json:"code"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

func (p *Problem) Error() string {
	s := p.Code + ": " + p.Message
	if p.Path != "" {
		s = p.Code + " at " + p.Path + ": " + p.Message
	}
	return s
}

// DocsURL links to the error's documentation.
func (p *Problem) DocsURL() string { return "https://otinstaller.com/docs/errors#" + p.Code }

//go:generate go run sync_schema.go
//go:embed schema/v1.json
var schemaJSON []byte

var compiled = mustCompile()

func mustCompile() *jsonschema.Schema {
	doc, err := decodeJSON(schemaJSON)
	if err != nil {
		panic(err)
	}
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	if err := c.AddResource("https://otinstaller.com/schema/v1.json", doc); err != nil {
		panic(err)
	}
	s, err := c.Compile("https://otinstaller.com/schema/v1.json")
	if err != nil {
		panic(err)
	}
	return s
}

func decodeJSON(js []byte) (any, error) {
	return jsonschema.UnmarshalJSON(bytes.NewReader(js))
}

// Options control the checks that need context beyond the manifest itself.
type Options struct {
	// Tag is the git tag being published (e.g. "v1.2.0"); empty skips the check.
	Tag string
	// Dir is the repository root; empty skips the file checks.
	Dir string
}

// Validate runs the schema and then the semantic checks. Semantic checks only run once the
// schema passes, so every problem refers to a well-formed manifest.
func Validate(doc any, m *Manifest, opt Options) []*Problem {
	if err := compiled.Validate(doc); err != nil {
		var ve *jsonschema.ValidationError
		if errors.As(err, &ve) {
			return schemaProblems(ve)
		}
		return []*Problem{{Code: CodeSchema, Message: err.Error()}}
	}
	var ps []*Problem
	ps = append(ps, checkInputs(m)...)
	ps = append(ps, checkSecrets(m)...)
	ps = append(ps, checkPlaceholders(m)...)
	ps = append(ps, checkTest(m)...)
	if opt.Tag != "" {
		if strings.TrimPrefix(opt.Tag, "v") != m.Version {
			ps = append(ps, &Problem{Code: CodeTagMismatch, Path: "/version",
				Message: fmt.Sprintf("tag %s does not match version %s", opt.Tag, m.Version),
				Hint:    "tag releases as v<version>"})
		}
	}
	if opt.Dir != "" {
		ps = append(ps, checkFiles(m, opt.Dir)...)
	}
	return ps
}

// codeFor maps a schema failure's location to the most specific error code.
func codeFor(loc string) string {
	switch {
	case loc == "/schema":
		return CodeSchemaVersion
	case loc == "/name" || loc == "/namespace":
		return CodeNameInvalid
	case loc == "/version":
		return CodeVersionInvalid
	case loc == "/license":
		return CodeLicenseInvalid
	case loc == "/runtime/image":
		return CodeImageNotPinned
	case strings.HasPrefix(loc, "/runtime/platforms"):
		return CodePlatformMissing
	}
	return CodeSchema
}

var printer = message.NewPrinter(language.English)

// schemaProblems flattens the validator's error tree into its leaves, which name the exact field.
var hints = map[string]string{
	CodeSchemaVersion:   "this CLI understands schema: 1",
	CodeNameInvalid:     "use 3-40 lowercase letters, digits and hyphens, not starting or ending with a hyphen",
	CodeVersionInvalid:  "use semver without a leading v, e.g. 1.2.0",
	CodeLicenseInvalid:  "use an SPDX identifier such as MIT or Apache-2.0",
	CodeImageNotPinned:  "pin the image by digest (image@sha256:...); the release workflow from `ot init` does this",
	CodePlatformMissing: "every image must include linux/amd64",
}

func schemaProblems(ve *jsonschema.ValidationError) []*Problem {
	var leaves []*jsonschema.ValidationError
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			leaves = append(leaves, e)
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	seen := map[string]bool{}
	var ps []*Problem
	for _, l := range leaves {
		loc := ""
		if len(l.InstanceLocation) > 0 {
			loc = "/" + strings.Join(l.InstanceLocation, "/")
		}
		msg := l.ErrorKind.LocalizedString(printer)
		if key := loc + "|" + msg; !seen[key] {
			seen[key] = true
			code := codeFor(loc)
			ps = append(ps, &Problem{Code: code, Path: loc, Message: msg, Hint: hints[code]})
		}
	}
	if len(ps) == 0 {
		ps = append(ps, &Problem{Code: CodeSchema, Message: ve.Error()})
	}
	// Most specific codes first, then deepest location, so the first problem is the most useful.
	sort.SliceStable(ps, func(i, j int) bool {
		gi, gj := ps[i].Code == CodeSchema, ps[j].Code == CodeSchema
		if gi != gj {
			return !gi
		}
		return len(ps[i].Path) > len(ps[j].Path)
	})
	return ps
}

func checkInputs(m *Manifest) []*Problem {
	var ps []*Problem
	seen := map[string]bool{}
	for i, in := range m.Inputs {
		if seen[in.Name] {
			ps = append(ps, &Problem{Code: CodeInputDuplicate, Path: fmt.Sprintf("/inputs/%d/name", i),
				Message: fmt.Sprintf("input %q is declared more than once", in.Name)})
		}
		seen[in.Name] = true
	}
	return ps
}

func checkSecrets(m *Manifest) []*Problem {
	var ps []*Problem
	seen := map[string]bool{}
	for i, s := range m.Secrets {
		if seen[s.Name] {
			ps = append(ps, &Problem{Code: CodeSecretDuplicate, Path: fmt.Sprintf("/secrets/%d/name", i),
				Message: fmt.Sprintf("secret %q is declared more than once", s.Name)})
		}
		seen[s.Name] = true
	}
	return ps
}

var placeholderRe = regexp.MustCompile(`\{([^{}]*)\}`)

// Placeholders returns the input names a command argument refers to.
func Placeholders(arg string) []string {
	var names []string
	for _, m := range placeholderRe.FindAllStringSubmatch(arg, -1) {
		names = append(names, m[1])
	}
	return names
}

func checkPlaceholders(m *Manifest) []*Problem {
	if m.Runtime == nil {
		return nil
	}
	var ps []*Problem
	for i, arg := range m.Runtime.Command {
		for _, name := range Placeholders(arg) {
			if m.Input(name) == nil {
				ps = append(ps, &Problem{Code: CodePlaceholderUnknown, Path: fmt.Sprintf("/runtime/command/%d", i),
					Message: fmt.Sprintf("command uses {%s} but no input is named %s", name, name),
					Hint:    "rename the input or the placeholder"})
			}
		}
	}
	return ps
}

func checkTest(m *Manifest) []*Problem {
	if m.Test == nil {
		return nil
	}
	var ps []*Problem
	keys := make([]string, 0, len(m.Test.Input))
	for k := range m.Test.Input {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if m.Input(k) == nil {
			ps = append(ps, &Problem{Code: CodeTestInputUnknown, Path: "/test/input/" + k,
				Message: fmt.Sprintf("test input %q is not a declared input", k)})
		}
	}
	for _, in := range m.Inputs {
		if _, ok := m.Test.Input[in.Name]; in.Required && !ok {
			ps = append(ps, &Problem{Code: CodeTestInputMissing, Path: "/test/input",
				Message: fmt.Sprintf("required input %q has no test value", in.Name)})
		}
	}
	return ps
}

func checkFiles(m *Manifest, dir string) []*Problem {
	var ps []*Problem
	exists := func(rel string) bool {
		_, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel)))
		return err == nil
	}
	if m.Readme != "" && !exists(m.Readme) {
		ps = append(ps, &Problem{Code: CodeFileMissing, Path: "/readme", Message: m.Readme + " does not exist"})
	}
	for _, pg := range []struct {
		field string
		p     *Pages
	}{{"/docs", m.Docs}, {"/content", m.Content}} {
		if pg.p == nil {
			continue
		}
		for i, page := range pg.p.Nav {
			if rel := pg.p.Root + page; !exists(rel) {
				ps = append(ps, &Problem{Code: CodeFileMissing, Path: fmt.Sprintf("%s/nav/%d", pg.field, i),
					Message: rel + " does not exist"})
			} else {
				ps = append(ps, checkContent(dir, rel)...)
			}
		}
	}
	return ps
}

// Types lists the input types and the output (entity) types the schema allows, in schema order.
func Types() (inputs, outputs []string) {
	var doc struct {
		Defs struct {
			InputType  struct{ Enum []string } `json:"inputType"`
			EntityType struct{ Enum []string } `json:"entityType"`
		} `json:"$defs"`
	}
	_ = json.Unmarshal(schemaJSON, &doc)
	return doc.Defs.InputType.Enum, doc.Defs.EntityType.Enum
}

// SchemaJSON is the embedded manifest schema, spec/schema/v1.json.
func SchemaJSON() []byte { return schemaJSON }
