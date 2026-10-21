package results

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/runner"
)

// Outputs lists the saved output files under dir (not sidecars or stderr files), oldest first.
func Outputs(dir string) ([]string, error) {
	type file struct {
		path, stamp string
		mod         time.Time
	}
	var files []file
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || strings.HasSuffix(path, ".meta.json") || strings.HasSuffix(path, ".stderr.txt") {
			return nil
		}
		f := file{path: path, stamp: filepath.Base(path)}
		if stamp, _, ok := strings.Cut(f.stamp, "_"); ok {
			f.stamp = stamp
		}
		if info, err := d.Info(); err == nil {
			f.mod = info.ModTime()
		}
		files = append(files, f)
		return nil
	})
	// The timestamp has whole seconds and the run ID after it is random, so runs started in
	// the same second are ordered by when their output was last written.
	sort.SliceStable(files, func(i, j int) bool {
		if files[i].stamp != files[j].stamp {
			return files[i].stamp < files[j].stamp
		}
		return files[i].mod.Before(files[j].mod)
	})
	out := make([]string, len(files))
	for i, f := range files {
		out[i] = f.path
	}
	return out, err
}

// MetaFor reads the sidecar next to an output file; nil when there is none.
func MetaFor(output string) *Meta {
	b, err := os.ReadFile(strings.TrimSuffix(output, filepath.Ext(output)) + ".meta.json")
	if err != nil {
		return nil
	}
	var m Meta
	if json.Unmarshal(b, &m) != nil {
		return nil
	}
	return &m
}

// Indicators are what otinstaller's extract found in result files, plus the entities ot's
// sidecars already hold, grouped by type.
type Indicators struct {
	Emails   []string            `json:"emails"`
	Domains  []string            `json:"domains"`
	IPs      []string            `json:"ips"`
	URLs     []string            `json:"urls"`
	Entities map[string][]string `json:"entities"`
}

var (
	emailIn  = regexp.MustCompile(`\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b`)
	domainIn = regexp.MustCompile(`\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}\b`)
	ipv4In   = regexp.MustCompile(`\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b`)
	urlIn    = regexp.MustCompile(`\bhttps?://[a-zA-Z0-9._~!$&'()*+,;=:@%/?#-]+[a-zA-Z0-9/_#=-]`)
)

// Extract finds emails, domains, IPv4 addresses and URLs in the files, and collects the entities
// from their sidecars. Each list keeps first-seen order without duplicates (ignoring case).
func Extract(paths []string) (*Indicators, error) {
	ind := &Indicators{Entities: map[string][]string{}}
	seen := map[string]bool{}
	add := func(list *[]string, kind, v string) {
		key := kind + "\x00" + strings.ToLower(v)
		if !seen[key] {
			seen[key] = true
			*list = append(*list, v)
		}
	}
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			return nil, err
		}
		text := string(b)
		for _, v := range emailIn.FindAllString(text, -1) {
			add(&ind.Emails, "e", v)
		}
		for _, v := range urlIn.FindAllString(text, -1) {
			add(&ind.URLs, "url", v)
		}
		for _, v := range ipv4In.FindAllString(text, -1) {
			add(&ind.IPs, "ip", v)
		}
		for _, v := range domainIn.FindAllString(text, -1) {
			labels := strings.Split(v, ".")
			if runner.KnownTLD(labels[len(labels)-1]) {
				add(&ind.Domains, "d", v)
			}
		}
		if m := MetaFor(p); m != nil {
			for _, e := range m.Entities {
				list := ind.Entities[e.Type]
				add(&list, "entity:"+e.Type, e.Value)
				ind.Entities[e.Type] = list
			}
		}
	}
	for _, l := range []*[]string{&ind.Emails, &ind.Domains, &ind.IPs, &ind.URLs} {
		if *l == nil {
			*l = []string{}
		}
	}
	return ind, nil
}

// Change is what differs between two saved runs of the same tool against the same target.
type Change struct {
	Older           string   `json:"older_file"`
	Newer           string   `json:"newer_file"`
	OlderDate       string   `json:"older_date"`
	NewerDate       string   `json:"newer_date"`
	Added           []string `json:"added"`
	Removed         []string `json:"removed"`
	AddedEntities   []string `json:"added_entities"`
	RemovedEntities []string `json:"removed_entities"`
}

// Diff compares two output files line by line, ignoring line order (results are mostly lists
// whose order changes from run to run), and their sidecars' entities.
func Diff(older, newer string) (*Change, error) {
	a, err := os.ReadFile(older)
	if err != nil {
		return nil, err
	}
	b, err := os.ReadFile(newer)
	if err != nil {
		return nil, err
	}
	c := &Change{Older: older, Newer: newer}
	c.Added, c.Removed = multisetDiff(lines(string(a)), lines(string(b)))
	var ea, eb []string
	if m := MetaFor(older); m != nil {
		c.OlderDate = m.StartedAt.UTC().Format("2006-01-02T15:04:05Z")
		ea = entityKeys(m)
	}
	if m := MetaFor(newer); m != nil {
		c.NewerDate = m.StartedAt.UTC().Format("2006-01-02T15:04:05Z")
		eb = entityKeys(m)
	}
	c.AddedEntities, c.RemovedEntities = multisetDiff(ea, eb)
	return c, nil
}

func lines(s string) []string {
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(l) != "" {
			out = append(out, l)
		}
	}
	return out
}

func entityKeys(m *Meta) []string {
	var out []string
	for _, e := range m.Entities {
		out = append(out, fmt.Sprintf("%s: %s", e.Type, e.Value))
	}
	return out
}

// multisetDiff returns the items of b missing from a (added) and of a missing from b (removed),
// each in its own file's order.
func multisetDiff(a, b []string) (added, removed []string) {
	count := map[string]int{}
	for _, l := range a {
		count[l]++
	}
	for _, l := range b {
		if count[l] > 0 {
			count[l]--
		} else {
			added = append(added, l)
		}
	}
	for _, l := range a {
		if count[l] > 0 {
			count[l]--
			removed = append(removed, l)
		}
	}
	if added == nil {
		added = []string{}
	}
	if removed == nil {
		removed = []string{}
	}
	return added, removed
}
