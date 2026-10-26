//go:build ignore

// Copies spec/tlds.txt, the top-level domain list ot and otlite share, next to detect.go. Run with `go generate ./...`.
package main

import "os"

func main() {
	b, err := os.ReadFile("../../../spec/tlds.txt")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile("tlds.txt", b, 0o644); err != nil {
		panic(err)
	}
}
