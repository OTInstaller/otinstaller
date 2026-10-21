package runner

import "testing"

func TestDetectType(t *testing.T) {
	for target, want := range map[string]string{
		"https://example.com/a": "url",
		"HTTP://example.com":    "url",
		"8.8.8.8":               "ip",
		"2001:4860:4860::8888":  "ip",
		"john@example.com":      "e",
		"+1 415 555 2671":       "p",
		"+442071838750":         "p",
		"example.com":           "d",
		"sub.example.co.uk":     "d",
		"EXAMPLE.COM":           "d",
		"example.notatld":       "u",
		"johndoe":               "u",
		"john.doe":              "u", // "doe" is not a top-level domain
		"999.1.1.1":             "u",
		"+12":                   "u", // too short for a phone number
		"  example.com ":        "d",
	} {
		if got := DetectType(target); got != want {
			t.Errorf("DetectType(%q) = %s, want %s", target, got, want)
		}
	}
	if in := DetectTyped(" example.com "); in.Prefix != "d" || in.Value != "example.com" {
		t.Errorf("DetectTyped: %+v", in)
	}
}

// Every detected prefix must be one ot run accepts.
func TestDetectedPrefixesAreKnown(t *testing.T) {
	for _, target := range []string{"https://a.com", "1.1.1.1", "a@b.com", "+14155552671", "a.com", "x"} {
		if _, ok := TypedPrefixes[DetectType(target)]; !ok {
			t.Errorf("%s: unknown prefix %s", target, DetectType(target))
		}
	}
}
