//go:build ignore

// Copies the spec files ot embeds (the result schemas and the pivot map) out of spec/. Run with `go generate ./...`.
package main

import "os"

func main() {
	for _, f := range []string{"schema/envelope-v1.json", "schema/run-all-v1.json", "schema/error-v1.json", "pivots.json"} {
		b, err := os.ReadFile("../../../spec/" + f)
		if err != nil {
			panic(err)
		}
		if err := os.WriteFile("files/"+lastPart(f), b, 0o644); err != nil {
			panic(err)
		}
	}
}

func lastPart(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}
