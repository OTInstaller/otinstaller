// Package manifest loads and validates otinstaller.yaml files.
package manifest

import (
	"encoding/json"
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

// FileName is the manifest file every package keeps at its repository root.
const FileName = "otinstaller.yaml"

// MaxSize is the largest manifest the registry accepts.
const MaxSize = 64 * 1024

type Manifest struct {
	Schema     int      `json:"schema"`
	Kind       string   `json:"kind,omitempty"`
	Name       string   `json:"name"`
	Namespace  string   `json:"namespace"`
	Version    string   `json:"version"`
	Summary    string   `json:"summary"`
	Readme     string   `json:"readme,omitempty"`
	License    string   `json:"license"`
	Homepage   string   `json:"homepage,omitempty"`
	Categories []string `json:"categories"`
	Tags       []string `json:"tags,omitempty"`

	// Tools.
	Inputs  []Input  `json:"inputs,omitempty"`
	Outputs []Output `json:"outputs,omitempty"`
	Runtime *Runtime `json:"runtime,omitempty"`
	Secrets []Secret `json:"secrets,omitempty"`
	Network *Network `json:"network,omitempty"`
	Ethics  *Ethics  `json:"ethics,omitempty"`
	Test    *Test    `json:"test,omitempty"`
	Docs    *Pages   `json:"docs,omitempty"`

	// Guides.
	Title        string   `json:"title,omitempty"`
	Level        string   `json:"level,omitempty"`
	Format       string   `json:"format,omitempty"`
	Language     string   `json:"language,omitempty"`
	Content      *Pages   `json:"content,omitempty"`
	RelatedTools []string `json:"related_tools,omitempty"`
	Topics       []string `json:"topics,omitempty"`
}

type Input struct {
	Name        string   `json:"name"`
	Type        string   `json:"type"`
	Required    bool     `json:"required"`
	Default     any      `json:"default,omitempty"`
	Description string   `json:"description,omitempty"`
	Values      []string `json:"values,omitempty"`
	// Example is a sample value, for docs and agents.
	Example any `json:"example,omitempty"`
}

type Output struct {
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
	// Attrs are the attributes the tool sets on entities of this type.
	Attrs []OutputAttr `json:"attrs,omitempty"`
}

// OutputAttr is one attribute a tool sets on the entities it outputs.
type OutputAttr struct {
	Name        string `json:"name"`
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
}

type Runtime struct {
	Kind           string   `json:"kind"`
	Command        []string `json:"command"`
	OutputFormat   string   `json:"output_format"`
	TimeoutSeconds int      `json:"timeout_seconds,omitempty"`
	// TypicalSeconds is how long a run usually takes.
	TypicalSeconds int `json:"typical_seconds,omitempty"`
	// FindingPrefixes, for text output, are how the lines that hold findings start; entities are read only from them.
	FindingPrefixes []string `json:"finding_prefixes,omitempty"`

	// Docker.
	Image     string   `json:"image,omitempty"`
	Platforms []string `json:"platforms,omitempty"`

	// pipx.
	Package        string `json:"package,omitempty"`
	PackageVersion string `json:"package_version,omitempty"`
	Index          string `json:"index,omitempty"`
	Python         string `json:"python,omitempty"`
	Entrypoint     string `json:"entrypoint,omitempty"`
	WheelSHA256    string `json:"wheel_sha256,omitempty"`
}

type Secret struct {
	Name        string `json:"name"`
	Required    bool   `json:"required"`
	Description string `json:"description,omitempty"`
	URL         string `json:"url,omitempty"`
	// Pricing is free, free_tier or paid.
	Pricing string `json:"pricing,omitempty"`
}

type Network struct {
	Egress  *bool    `json:"egress,omitempty"`
	Domains []string `json:"domains,omitempty"`
}

type Ethics struct {
	TouchesTarget        bool `json:"touches_target"`
	AuthRequired         bool `json:"auth_required"`
	CollectsPersonalData bool `json:"collects_personal_data"`
	// NotifiesTarget says whether a run can produce something the target sees. Unset is unknown: agents treat a tool
	// that touches the target as if it may.
	NotifiesTarget *bool  `json:"notifies_target,omitempty"`
	Notes          string `json:"notes,omitempty"`
}

type Test struct {
	Input          map[string]any `json:"input"`
	ExpectExitCode int            `json:"expect_exit_code,omitempty"`
}

type Pages struct {
	Root string   `json:"root"`
	Nav  []string `json:"nav"`
}

// Ref is the package's registry address, e.g. "dheeraj/holehe-lite".
func (m *Manifest) Ref() string { return m.Namespace + "/" + m.Name }

// IsGuide reports whether the manifest describes a guide rather than a tool.
func (m *Manifest) IsGuide() bool { return m.Kind == "guide" }

// Timeout returns the run timeout in seconds, applying the spec default.
func (m *Manifest) Timeout() int {
	if m.Runtime == nil || m.Runtime.TimeoutSeconds == 0 {
		return 300
	}
	return m.Runtime.TimeoutSeconds
}

// Input returns the named input, or nil.
func (m *Manifest) Input(name string) *Input {
	for i := range m.Inputs {
		if m.Inputs[i].Name == name {
			return &m.Inputs[i]
		}
	}
	return nil
}

// Parse decodes YAML into a generic JSON document (for schema validation) and a typed Manifest.
// The typed manifest is only meaningful once Validate reports no problems.
func Parse(data []byte) (doc any, m *Manifest, err error) {
	if len(data) > MaxSize {
		return nil, nil, &Problem{Code: CodeTooLarge, Message: fmt.Sprintf("manifest is %d bytes; the limit is %d", len(data), MaxSize)}
	}
	var raw any
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, nil, &Problem{Code: CodeYAMLInvalid, Message: err.Error(), Hint: "check indentation and quoting"}
	}
	if _, ok := raw.(map[string]any); !ok {
		return nil, nil, &Problem{Code: CodeYAMLInvalid, Message: "manifest must be a YAML mapping"}
	}
	// Round-trip through JSON so the schema validator and the typed struct see the same values.
	js, err := json.Marshal(raw)
	if err != nil {
		return nil, nil, &Problem{Code: CodeYAMLInvalid, Message: err.Error()}
	}
	doc, err = decodeJSON(js)
	if err != nil {
		return nil, nil, &Problem{Code: CodeYAMLInvalid, Message: err.Error()}
	}
	m = &Manifest{}
	// Type mismatches are reported by the schema, so a failed decode here is not fatal.
	_ = json.Unmarshal(js, m)
	if m.Kind == "" {
		m.Kind = "tool"
	}
	return doc, m, nil
}

// ParseJSON decodes a manifest the registry API returned.
func ParseJSON(js []byte) (doc any, m *Manifest, err error) {
	doc, err = decodeJSON(js)
	if err != nil {
		return nil, nil, err
	}
	m = &Manifest{}
	_ = json.Unmarshal(js, m)
	if m.Kind == "" {
		m.Kind = "tool"
	}
	return doc, m, nil
}

// LoadFile reads and parses a manifest from disk.
func LoadFile(path string) (doc any, m *Manifest, err error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, &Problem{Code: CodeFileMissing, Path: path, Message: err.Error(), Hint: "run `ot init` to create one"}
	}
	return Parse(data)
}
