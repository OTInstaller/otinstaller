package specfiles

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

func TestCopiesMatchSpec(t *testing.T) {
	norm := func(b []byte) []byte { return bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n")) }
	for _, f := range []string{"schema/envelope-v1.json", "schema/run-all-v1.json", "schema/error-v1.json", "pivots.json", "types.json"} {
		spec, err := os.ReadFile("../../../spec/" + f)
		if err != nil {
			t.Fatal(err)
		}
		got, err := files.ReadFile("files/" + f[bytes.LastIndexByte([]byte(f), '/')+1:])
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(norm(spec), norm(got)) {
			t.Errorf("cli/internal/specfiles/files copy of %s is out of date; run `go generate ./...` in cli/", f)
		}
	}
}

func TestPivotsCoverEveryEntityType(t *testing.T) {
	for _, typ := range []string{"account", "email", "username", "phone", "domain", "subdomain", "ip", "url", "person", "organization",
		"location", "breach", "certificate", "dns_record", "image", "document", "crypto_address", "transaction", "other"} {
		if _, ok := Pivots[typ]; !ok {
			t.Errorf("spec/pivots.json has no entry for %s", typ)
		}
	}
}

// Every type and category the manifest schema allows has a description in spec/types.json, and nothing else does.
func TestTypesDescribeEverySchemaValue(t *testing.T) {
	var doc struct {
		Defs map[string]struct{ Enum []string } `json:"$defs"`
	}
	if err := json.Unmarshal(manifest.SchemaJSON(), &doc); err != nil {
		t.Fatal(err)
	}
	for def, got := range map[string]map[string]string{"inputType": Types.Inputs, "entityType": Types.Entities, "category": Types.Categories} {
		want := doc.Defs[def].Enum
		if len(want) == 0 || len(got) != len(want) {
			t.Errorf("spec/types.json has %d entries for %s; the schema has %d", len(got), def, len(want))
		}
		for _, v := range want {
			if got[v] == "" {
				t.Errorf("spec/types.json has no description for %s %q", def, v)
			}
		}
	}
}
