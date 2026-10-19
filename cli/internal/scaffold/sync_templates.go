//go:build ignore

// Copies the spec's release workflow templates into the CLI so they can be embedded. Run with `go generate ./...`.
package main

import (
	"os"
	"path/filepath"
)

func main() {
	files, err := filepath.Glob("../../../spec/templates/*.yml")
	if err != nil || len(files) == 0 {
		panic("no templates in spec/templates")
	}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile(filepath.Join("templates", filepath.Base(f)), b, 0o644); err != nil {
			panic(err)
		}
	}
}
