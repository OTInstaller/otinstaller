package runner

import (
	_ "embed"
	"net/netip"
	"regexp"
	"strings"
)

// tlds.txt is IANA's list of top-level domains, the same file otinstaller used.
//
//go:embed tlds.txt
var tldList string

var (
	tlds        = loadTLDs(tldList)
	emailRe     = regexp.MustCompile(`^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$`)
	domainLabel = regexp.MustCompile(`^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)
	phoneRe     = regexp.MustCompile(`^\+[0-9][0-9 ().-]{6,20}$`)
)

func loadTLDs(list string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(list, "\n") {
		if t := strings.TrimSpace(strings.ToLower(line)); t != "" && !strings.HasPrefix(t, "#") {
			out[t] = true
		}
	}
	return out
}

// DetectType guesses the typed-input prefix for a bare target, as `otinstaller auto` did. First
// match wins: url (http:// or https://), ip (IPv4 or IPv6), email, phone (an international number
// starting with +), domain (ending in an IANA top-level domain), and otherwise username.
func DetectType(target string) string {
	t := strings.TrimSpace(target)
	lower := strings.ToLower(t)
	switch {
	case strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://"):
		return "url"
	case isIP(t):
		return "ip"
	case emailRe.MatchString(t):
		return "e"
	case phoneRe.MatchString(t) && digits(t) >= 7 && digits(t) <= 15:
		return "p"
	case isDomain(t):
		return "d"
	}
	return "u"
}

// DetectTyped turns a bare target into a typed input.
func DetectTyped(target string) TypedInput {
	return TypedInput{Prefix: DetectType(target), Value: strings.TrimSpace(target)}
}

func isIP(s string) bool {
	_, err := netip.ParseAddr(s)
	return err == nil && !strings.Contains(s, "%")
}

func isDomain(s string) bool {
	labels := strings.Split(strings.TrimSuffix(s, "."), ".")
	if len(labels) < 2 || !tlds[strings.ToLower(labels[len(labels)-1])] {
		return false
	}
	for _, l := range labels {
		if !domainLabel.MatchString(l) {
			return false
		}
	}
	return true
}

func digits(s string) int {
	n := 0
	for _, r := range s {
		if r >= '0' && r <= '9' {
			n++
		}
	}
	return n
}
