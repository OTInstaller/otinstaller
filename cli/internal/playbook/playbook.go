// Package playbook loads playbooks: named lists of tools that `ot playbook` runs against the same
// typed inputs, as otinstaller's playbooks did.
//
// Playbooks come from three places, later ones winning on a name clash: the ones bundled with ot,
// <ot home>/playbooks, and ./playbooks.
package playbook

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/otinstaller/otinstaller/cli/internal/runner"
)

//go:embed bundled/*.yaml
var bundled embed.FS

// Playbook is one playbook file.
type Playbook struct {
	Name        string   `yaml:"name" json:"name"`
	Description string   `yaml:"description" json:"description"`
	Tools       []string `yaml:"tools" json:"tools"`
	// Inputs are the input types it is meant for (username, email, domain, phone, ip, url), the first being the main
	// one. They are shown in lists and pick the starter playbook for a type; ot runs a playbook with any typed inputs.
	Inputs []string `yaml:"inputs" json:"inputs"`
	// Case is the results case its runs are saved under; default playbook-<name>.
	Case string `yaml:"case" json:"case"`
	// RequiresTarget is otinstaller's field; ot always needs a typed input, so it is ignored.
	RequiresTarget *bool `yaml:"requires_target" json:"-"`
	// Source is where it was loaded from: "bundled" or a file path.
	Source string `yaml:"-" json:"source"`
}

var (
	slug = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`)
	ref  = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]/[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`)
)

// Parse reads and checks one playbook. name is the file's stem, used when the file names none.
func Parse(data []byte, name, source string) (*Playbook, error) {
	var p Playbook
	if err := yaml.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("playbook %s: %w", source, err)
	}
	if p.Name == "" {
		p.Name = name
	}
	p.Source = source
	if !slug.MatchString(p.Name) {
		return nil, fmt.Errorf("playbook %s: name %q must be lowercase letters, digits and hyphens", source, p.Name)
	}
	if len(p.Tools) == 0 {
		return nil, fmt.Errorf("playbook %s: lists no tools", p.Name)
	}
	seen := map[string]bool{}
	for _, t := range p.Tools {
		if !strings.Contains(t, "/") && slug.MatchString(t) {
			// otinstaller playbooks name tools without a namespace.
			return nil, fmt.Errorf("playbook %s: tool %q needs its namespace, such as osintverse-community/%s", p.Name, t, t)
		}
		if !ref.MatchString(t) {
			return nil, fmt.Errorf("playbook %s: %q is not a package; use namespace/name", p.Name, t)
		}
		if seen[t] {
			return nil, fmt.Errorf("playbook %s: lists %s twice", p.Name, t)
		}
		seen[t] = true
	}
	types := map[string]bool{}
	for _, t := range runner.TypedPrefixes {
		types[t] = true
	}
	for i, t := range p.Inputs {
		if !types[t] {
			return nil, fmt.Errorf("playbook %s: input %q must be username, email, domain, phone, ip or url", p.Name, t)
		}
		for _, earlier := range p.Inputs[:i] {
			if earlier == t {
				return nil, fmt.Errorf("playbook %s: lists the input %s twice", p.Name, t)
			}
		}
	}
	if p.Inputs == nil {
		p.Inputs = []string{}
	}
	if p.Case == "" {
		p.Case = "playbook-" + p.Name
	}
	return &p, nil
}

// Dirs are the folders searched after the bundled playbooks, in order.
func Dirs(home string) []string {
	return []string{filepath.Join(home, "playbooks"), "playbooks"}
}

// bundledPlaybooks are the playbooks shipped with ot, sorted by name.
func bundledPlaybooks() ([]*Playbook, error) {
	var out []*Playbook
	entries, _ := fs.ReadDir(bundled, "bundled")
	for _, e := range entries {
		data, err := bundled.ReadFile("bundled/" + e.Name())
		if err != nil {
			return nil, err
		}
		p, err := Parse(data, stem(e.Name()), "bundled")
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// Starter is the playbook ot offers to install when no installed tool takes an input type, as on a fresh machine:
// the first bundled one whose main input is that type, or nil. Only bundled playbooks are offered, never one from
// <ot home>/playbooks or ./playbooks, which could have come with any folder someone downloaded.
func Starter(typ string) *Playbook {
	all, _ := bundledPlaybooks()
	for _, p := range all {
		if len(p.Inputs) > 0 && p.Inputs[0] == typ {
			return p
		}
	}
	return nil
}

// All loads every playbook, sorted by name. A broken file is an error, so a typo never silently
// falls back to a bundled playbook of the same name.
func All(dirs []string) ([]*Playbook, error) {
	found := map[string]*Playbook{}
	shipped, err := bundledPlaybooks()
	if err != nil {
		return nil, err
	}
	for _, p := range shipped {
		found[p.Name] = p
	}
	for _, dir := range dirs {
		var files []string
		for _, pattern := range []string{"*.yaml", "*.yml"} {
			m, _ := filepath.Glob(filepath.Join(dir, pattern))
			files = append(files, m...)
		}
		sort.Strings(files)
		for _, f := range files {
			data, err := os.ReadFile(f)
			if err != nil {
				return nil, err
			}
			p, err := Parse(data, stem(filepath.Base(f)), f)
			if err != nil {
				return nil, err
			}
			found[p.Name] = p
		}
	}
	out := make([]*Playbook, 0, len(found))
	for _, p := range found {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Find returns the playbook with this name.
func Find(dirs []string, name string) (*Playbook, error) {
	all, err := All(dirs)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, p := range all {
		if p.Name == name {
			return p, nil
		}
		names = append(names, p.Name)
	}
	return nil, fmt.Errorf("no playbook %q; there are: %s", name, strings.Join(names, ", "))
}

func stem(file string) string {
	return strings.TrimSuffix(strings.TrimSuffix(file, ".yaml"), ".yml")
}
