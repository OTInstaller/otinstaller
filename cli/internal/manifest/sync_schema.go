//go:build ignore

// Copies the spec's schema into the CLI so it can be embedded. Run with `go generate ./...`.
package main

import "os"

func main() {
	b, err := os.ReadFile("../../../spec/schema/v1.json")
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile("schema/v1.json", b, 0o644); err != nil {
		panic(err)
	}
}
