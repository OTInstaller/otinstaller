package runner

import (
	"regexp"
	"strings"

	"github.com/otinstaller/otinstaller/cli/internal/envelope"
)

// Indicators found in tool output that isn't structured. Kept in step with the ones `ot extract` uses
// (results/saved.go).
var (
	textEmail  = regexp.MustCompile(`\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b`)
	textDomain = regexp.MustCompile(`\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}\b`)
	textIPv4   = regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b`)
	textURL    = regexp.MustCompile(`\bhttps?://[a-zA-Z0-9._~!$&'()*+,;=:@%/?#-]+[a-zA-Z0-9/_#=-]`)
)

// fileTLDs are real TLDs that are far more often file extensions in tool output (script.py, notes.md).
var fileTLDs = map[string]bool{"py": true, "sh": true, "md": true, "zip": true, "mov": true, "rs": true, "pl": true, "cc": true}

// MaxTextEntities caps what TextEntities returns, so a chatty tool can't flood an agent.
const MaxTextEntities = 200

// lineStart is what may come before a line's first character: indentation and terminal colour codes.
var lineStart = regexp.MustCompile(`^(?:\s|\x1b\[[0-9;]*[A-Za-z])*`)

// FindingLines keeps the lines of text output that start with one of prefixes (the manifest's
// runtime.finding_prefixes), ignoring indentation and colour codes, so a tool's banner, sponsor links, donation
// lines and update notices aren't read as findings. With no prefixes it returns the text as it is.
func FindingLines(text string, prefixes []string) string {
	if len(prefixes) == 0 {
		return text
	}
	var keep []string
	for _, line := range strings.Split(text, "\n") {
		rest := lineStart.ReplaceAllString(line, "")
		for _, p := range prefixes {
			if strings.HasPrefix(rest, p) {
				keep = append(keep, line)
				break
			}
		}
	}
	return strings.Join(keep, "\n")
}

// TextEntities finds emails, URLs, IP addresses and domains in text output, for tools that print text or CSV
// rather than entities. They are marked confidence "low" and found_in "text output": a pattern match, not something
// the tool reported. Values equal to one of the run's inputs are left out, since they aren't findings. When the
// manifest names the prefixes of the lines that hold findings, only those lines are read (FindingLines).
func TextEntities(text string, inputs map[string]string, prefixes []string) []envelope.Entity {
	text = FindingLines(text, prefixes)
	skip := map[string]bool{}
	for _, v := range inputs {
		skip[strings.ToLower(strings.TrimSpace(v))] = true
	}
	out := []envelope.Entity{} // never nil: the envelope's entities is always an array
	seen := map[string]bool{}
	add := func(typ, v string) bool {
		key := typ + "\x00" + strings.ToLower(v)
		if seen[key] || skip[strings.ToLower(v)] {
			return true
		}
		if len(out) >= MaxTextEntities {
			return false
		}
		seen[key] = true
		out = append(out, envelope.Entity{Type: typ, Value: v, Confidence: "low", Attrs: map[string]any{"found_in": "text output"}})
		return true
	}
	emails := textEmail.FindAllString(text, -1)
	inEmail := map[string]bool{}
	for _, v := range emails {
		if !add("email", v) {
			return out
		}
		inEmail[strings.ToLower(v[strings.LastIndexByte(v, '@')+1:])] = true
	}
	for _, v := range textURL.FindAllString(text, -1) {
		if !add("url", v) {
			return out
		}
	}
	for _, v := range textIPv4.FindAllString(text, -1) {
		if !add("ip", v) {
			return out
		}
	}
	for _, v := range textDomain.FindAllString(text, -1) {
		labels := strings.Split(strings.ToLower(v), ".")
		tld := labels[len(labels)-1]
		// An email's domain is already in the email; file names aren't domains.
		if !KnownTLD(tld) || fileTLDs[tld] || inEmail[strings.ToLower(v)] {
			continue
		}
		if !add("domain", v) {
			return out
		}
	}
	return out
}
