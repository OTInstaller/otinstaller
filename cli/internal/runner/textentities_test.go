package runner

import (
	"fmt"
	"strings"
	"testing"
)

func TestTextEntities(t *testing.T) {
	out := `[+] Found: https://github.com/johndoe
contact: jane.doe@example.org (also on mail.example.org)
resolved 93.184.216.34 via 1.1.1.1
see notes.md and run.py; version 1.2.3
target johndoe@example.com`
	got := map[string]bool{}
	for _, e := range TextEntities(out, map[string]string{"email": "johndoe@example.com"}) {
		if e.Confidence != "low" || e.Attrs["found_in"] != "text output" {
			t.Errorf("%v: not marked as found in text", e)
		}
		got[e.Type+" "+e.Value] = true
	}
	for _, want := range []string{"url https://github.com/johndoe", "email jane.doe@example.org", "domain mail.example.org",
		"ip 93.184.216.34", "ip 1.1.1.1", "domain github.com"} {
		if !got[want] {
			t.Errorf("missing %s; got %v", want, got)
		}
	}
	for _, not := range []string{"email johndoe@example.com", "domain example.org", "domain notes.md", "domain run.py", "domain example.com"} {
		if got[not] {
			t.Errorf("%s should be left out (an input, an email's own domain, or a file name)", not)
		}
	}
}

func TestTextEntitiesOfNothingIsAnEmptyList(t *testing.T) {
	if got := TextEntities("", nil); got == nil || len(got) != 0 {
		t.Errorf("got %#v, want an empty, non-nil list", got)
	}
}

func TestTextEntitiesIsCapped(t *testing.T) {
	var b strings.Builder
	for i := 0; i < MaxTextEntities+50; i++ {
		fmt.Fprintf(&b, "user%d@example.com\n", i)
	}
	if n := len(TextEntities(b.String(), nil)); n != MaxTextEntities {
		t.Errorf("got %d entities, want the cap %d", n, MaxTextEntities)
	}
}
