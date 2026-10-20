package manifest

import (
	"path/filepath"
	"testing"
)

// Every package in seed/ (including the wrappers converted from otinstaller's catalog) must
// validate, with its files present, before it can be published.
func TestSeedManifests(t *testing.T) {
	files, _ := filepath.Glob("../../../seed/*/*/otinstaller.yaml")
	if len(files) < 50 {
		t.Fatalf("expected at least 50 seed manifests, found %d", len(files))
	}
	for _, f := range files {
		dir := filepath.Dir(f)
		t.Run(filepath.Base(filepath.Dir(dir))+"/"+filepath.Base(dir), func(t *testing.T) {
			doc, m, err := LoadFile(f)
			if err != nil {
				t.Fatal(err)
			}
			for _, p := range Validate(doc, m, Options{Tag: "v" + m.Version, Dir: dir}) {
				t.Error(p)
			}
		})
	}
}
