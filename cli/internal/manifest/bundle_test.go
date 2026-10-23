package manifest

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBundleFiles(t *testing.T) {
	dir := t.TempDir()
	write := func(rel string, size int) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(strings.Repeat("x", size)), 0o644)
	}
	os.WriteFile(filepath.Join(dir, "custom.yaml"), []byte("schema: 1\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("![a](docs/a.png)\n<img src='/b.webp'>\n"), 0o644)
	write("docs/index.md", 10)
	write("docs/a.png", 10)
	write("b.webp", 10)
	write("unused.jpg", 10)
	write("huge.png", MaxImageSize+1)
	write(".git/x.png", 10)
	write("build/y.png", 10)
	m := &Manifest{Readme: "README.md", Docs: &Pages{Root: "docs/", Nav: []string{"index.md"}}}

	files, err := BundleFiles(m, filepath.Join(dir, "custom.yaml"), dir)
	if err != nil {
		t.Fatal(err)
	}
	var paths []string
	for _, f := range files {
		paths = append(paths, f.Path)
	}
	// The manifest goes up as otinstaller.yaml, with every image small enough to copy.
	if got := strings.Join(paths, ","); got != "README.md,b.webp,docs/a.png,docs/index.md,otinstaller.yaml,unused.jpg" {
		t.Errorf("files %s", got)
	}

	// Over the limit, only the images the pages show are kept.
	for i := 0; i < 13; i++ {
		write(filepath.ToSlash(filepath.Join("shots", string(rune('a'+i))+".png")), MaxImageSize)
	}
	files, err = BundleFiles(m, filepath.Join(dir, "custom.yaml"), dir)
	if err != nil {
		t.Fatal(err)
	}
	paths = nil
	for _, f := range files {
		paths = append(paths, f.Path)
	}
	if got := strings.Join(paths, ","); got != "README.md,b.webp,docs/a.png,docs/index.md,otinstaller.yaml" {
		t.Errorf("over the limit: files %s", got)
	}

	m.Readme = "MISSING.md"
	if _, err := BundleFiles(m, filepath.Join(dir, "custom.yaml"), dir); err == nil || !strings.Contains(err.Error(), "MISSING.md does not exist") {
		t.Errorf("missing README: %v", err)
	}
}
