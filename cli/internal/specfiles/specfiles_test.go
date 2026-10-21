package specfiles

import (
	"bytes"
	"os"
	"testing"
)

func TestCopiesMatchSpec(t *testing.T) {
	norm := func(b []byte) []byte { return bytes.ReplaceAll(b, []byte("\r\n"), []byte("\n")) }
	for _, f := range []string{"schema/envelope-v1.json", "schema/run-all-v1.json", "schema/error-v1.json", "pivots.json"} {
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
