// Package specfiles embeds the spec files ot serves or reads at run time: the result, run-summary and error JSON
// Schemas (MCP resources), the pivot map and the type descriptions. The copies come from spec/ with `go generate ./...`; a test checks they
// match.
package specfiles

import (
	"embed"
	"encoding/json"
	"strings"
)

//go:generate go run sync_spec.go
//go:embed files/*.json
var files embed.FS

// Schema returns one of the published schemas by file name: envelope-v1.json, run-all-v1.json or error-v1.json.
func Schema(name string) ([]byte, bool) {
	if !strings.HasSuffix(name, "-v1.json") {
		return nil, false
	}
	b, err := files.ReadFile("files/" + name)
	return b, err == nil
}

// SchemaNames are the schemas Schema serves.
var SchemaNames = []string{"envelope-v1.json", "run-all-v1.json", "error-v1.json"}

// PivotTarget is one input an entity can feed.
type PivotTarget struct {
	Input     string `json:"input"`
	Attr      string `json:"attr,omitempty"`
	Transform string `json:"transform,omitempty"`
}

// TypeDescriptions says what each input type, entity type and category means (spec/types.json).
type TypeDescriptions struct {
	Inputs     map[string]string `json:"inputs"`
	Entities   map[string]string `json:"entities"`
	Categories map[string]string `json:"categories"`
}

// Types is spec/types.json.
var Types = func() TypeDescriptions {
	var t TypeDescriptions
	b, err := files.ReadFile("files/types.json")
	if err == nil {
		err = json.Unmarshal(b, &t)
	}
	if err != nil {
		panic("specfiles: types.json: " + err.Error())
	}
	return t
}()

// Pivots maps entity types to the inputs they can feed (spec/pivots.json).
var Pivots = mustPivots()

func mustPivots() map[string][]PivotTarget {
	b, err := files.ReadFile("files/pivots.json")
	if err != nil {
		panic(err)
	}
	var doc struct {
		Pivots map[string][]PivotTarget `json:"pivots"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		panic(err)
	}
	return doc.Pivots
}

// PivotsJSON is the pivot map as published.
func PivotsJSON() []byte {
	b, _ := files.ReadFile("files/pivots.json")
	return b
}
