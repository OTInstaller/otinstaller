package playbook

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

func TestBundled(t *testing.T) {
	all, err := All(nil)
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]*Playbook{}
	for _, p := range all {
		names[p.Name] = p
	}
	for _, want := range []string{"domain-recon", "username-investigation", "email-investigation", "phone-investigation", "ip-investigation"} {
		p := names[want]
		if p == nil || p.Source != "bundled" || len(p.Tools) == 0 || p.Case != "playbook-"+want || len(p.Inputs) == 0 {
			t.Errorf("%s: %+v", want, p)
		}
	}
}

// Every bundled playbook names packages that are in the launch seed.
func TestBundledToolsAreSeeded(t *testing.T) {
	all, _ := All(nil)
	for _, p := range all {
		for _, ref := range p.Tools {
			_, name, _ := strings.Cut(ref, "/")
			// First-party tools are published in osintverse-community too.
			_, errCommunity := os.Stat(filepath.Join("../../../seed/community", name, "otinstaller.yaml"))
			_, errFirst := os.Stat(filepath.Join("../../../seed/first-party", name, "otinstaller.yaml"))
			if errCommunity != nil && errFirst != nil {
				t.Errorf("%s: %s is not in seed/", p.Name, ref)
			}
		}
	}
}

// Every tool of a bundled playbook is in the launch seed under the same name, takes one of the playbook's input types,
// and needs no key, so the playbook works on a fresh machine with nothing set up.
func TestBundledPlaybooksFitSeed(t *testing.T) {
	all, err := All(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range all {
		if len(p.Inputs) == 0 {
			t.Errorf("%s: declares no inputs", p.Name)
		}
		takesMain := false
		for _, ref := range p.Tools {
			_, name, _ := strings.Cut(ref, "/")
			path := filepath.Join("../../../seed/community", name, "otinstaller.yaml")
			if _, err := os.Stat(path); err != nil {
				path = filepath.Join("../../../seed/first-party", name, "otinstaller.yaml")
			}
			_, m, err := manifest.LoadFile(path)
			if err != nil {
				t.Errorf("%s: %s: %v", p.Name, ref, err)
				continue
			}
			if m.Ref() != ref {
				t.Errorf("%s: %s is published as %s", p.Name, ref, m.Ref())
			}
			fits := false
			for _, in := range m.Inputs {
				for i, typ := range p.Inputs {
					if in.Type == typ {
						fits, takesMain = true, takesMain || i == 0
					}
				}
			}
			if !fits {
				t.Errorf("%s: %s has no %s input", p.Name, ref, strings.Join(p.Inputs, " or "))
			}
			for _, s := range m.Secrets {
				if s.Required {
					t.Errorf("%s: %s needs the key %s", p.Name, ref, s.Name)
				}
			}
		}
		if len(p.Inputs) > 0 && !takesMain {
			t.Errorf("%s: no tool takes its main input, %s", p.Name, p.Inputs[0])
		}
	}
}

func TestLaterDirsWin(t *testing.T) {
	home, local := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(home, "domain-recon.yaml"), []byte("tools: [a-ns/home-tool]\n"), 0o644)
	os.WriteFile(filepath.Join(local, "domain-recon.yml"), []byte("description: mine\ntools: [a-ns/local-tool]\ncase: my-case\n"), 0o644)
	os.WriteFile(filepath.Join(home, "extra.yaml"), []byte("name: extra\ntools: [a-ns/xx1]\n"), 0o644)
	p, err := Find([]string{home, local}, "domain-recon")
	if err != nil {
		t.Fatal(err)
	}
	if p.Tools[0] != "a-ns/local-tool" || p.Case != "my-case" || p.Source != filepath.Join(local, "domain-recon.yml") {
		t.Fatalf("local playbook should win: %+v", p)
	}
	if _, err := Find([]string{home, local}, "extra"); err != nil {
		t.Fatal(err)
	}
	if _, err := Find([]string{home, local}, "nope"); err == nil || !strings.Contains(err.Error(), "domain-recon") {
		t.Fatalf("unknown playbook should list the known ones: %v", err)
	}
}

func TestParseErrors(t *testing.T) {
	for doc, want := range map[string]string{
		"tools: []\n":                             "lists no tools",
		"tools: [sherlock]\n":                     "osintverse-community/sherlock",
		"tools: [a-ns/xx1, a-ns/xx1]\n":           "twice",
		"tools: [Not/A/Ref]\n":                    "not a package",
		"name: Bad Name\ntools: [a-ns/xx1]\n":     "lowercase",
		"inputs: [hostname]\ntools: [a-ns/xx1]\n": "must be username, email",
		"inputs: [ip, ip]\ntools: [a-ns/xx1]\n":   "input ip twice",
		"tools: {a: b}\n":                         "playbook",
	} {
		if _, err := Parse([]byte(doc), "pb", "pb.yaml"); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: want %q, got %v", doc, want, err)
		}
	}
	// otinstaller's requires_target is accepted and ignored.
	if _, err := Parse([]byte("requires_target: true\ntools: [a-ns/xx1]\n"), "pb", "pb.yaml"); err != nil {
		t.Error(err)
	}
}

// A broken local file is an error rather than a silent fallback to the bundled playbook.
func TestBrokenFile(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "domain-recon.yaml"), []byte("tools: [dnstwist]\n"), 0o644)
	if _, err := Find([]string{dir}, "domain-recon"); err == nil {
		t.Fatal("want an error")
	}
}
