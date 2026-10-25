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
	for _, e := range TextEntities(out, map[string]string{"email": "johndoe@example.com"}, nil) {
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
	if got := TextEntities("", nil, nil); got == nil || len(got) != 0 {
		t.Errorf("got %#v, want an empty, non-nil list", got)
	}
}

func TestTextEntitiesIsCapped(t *testing.T) {
	var b strings.Builder
	for i := 0; i < MaxTextEntities+50; i++ {
		fmt.Fprintf(&b, "user%d@example.com\n", i)
	}
	if n := len(TextEntities(b.String(), nil, nil)); n != MaxTextEntities {
		t.Errorf("got %d entities, want the cap %d", n, MaxTextEntities)
	}
}

func TestTextEntitiesReadOnlyFindingLines(t *testing.T) {
	// Shaped like sherlock's and user-scanner's output: a found account, a sponsor link, an update notice whose
	// version looks like an IP address, a site that was skipped, and a detail line under a found account.
	out := "[!] New version available: 1.5.2 -> 1.5.2.3\n" +
		"\r[+] GitHub: https://www.github.com/github\n" +
		"  \x1b[32m[✔] Chess.com (ada@example.com): Registered\x1b[0m\n" +
		"  [~] Jobs.cz (ada@example.com): Skipped\n" +
		"      └── avatar: https://i.etsystatic.com/avatar.png\n" +
		"Try OSINTSearch: https://osintsearch.org\n"
	values := func(prefixes []string) map[string]bool {
		got := map[string]bool{}
		for _, e := range TextEntities(out, map[string]string{"email": "ada@example.com"}, prefixes) {
			got[e.Type+" "+e.Value] = true
		}
		return got
	}
	got := values([]string{"[+]", "[✔]", "└─"})
	for _, want := range []string{"url https://www.github.com/github", "domain Chess.com", "url https://i.etsystatic.com/avatar.png"} {
		if !got[want] {
			t.Errorf("missing %s; got %v", want, got)
		}
	}
	for _, not := range []string{"ip 1.5.2.3", "domain Jobs.cz", "url https://osintsearch.org", "domain osintsearch.org"} {
		if got[not] {
			t.Errorf("%s is not on a finding line; got %v", not, got)
		}
	}
	// Without prefixes every line is read, as before.
	if all := values(nil); !all["ip 1.5.2.3"] || !all["domain osintsearch.org"] {
		t.Errorf("without prefixes every line should be read; got %v", all)
	}
}
