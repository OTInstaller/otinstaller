package playbook

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	for _, want := range []string{"domain-recon", "username-investigation"} {
		p := names[want]
		if p == nil || p.Source != "bundled" || len(p.Tools) == 0 || p.Case != "playbook-"+want {
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
		"tools: []\n":                         "lists no tools",
		"tools: [sherlock]\n":                 "osintverse-community/sherlock",
		"tools: [a-ns/xx1, a-ns/xx1]\n":       "twice",
		"tools: [Not/A/Ref]\n":                "not a package",
		"name: Bad Name\ntools: [a-ns/xx1]\n": "lowercase",
		"tools: {a: b}\n":                     "playbook",
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
