package results

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/otinstaller/otinstaller/cli/internal/envelope"
)

func write(t *testing.T, path, body string, entities ...envelope.Entity) string {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	os.WriteFile(path, []byte(body), 0o644)
	if entities != nil {
		m := Meta{StartedAt: time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC), Entities: entities}
		b, _ := json.Marshal(m)
		os.WriteFile(path[:len(path)-len(filepath.Ext(path))]+".meta.json", b, 0o644)
	}
	return path
}

func TestOutputsAndExtract(t *testing.T) {
	dir := t.TempDir()
	write(t, filepath.Join(dir, "sherlock", "jd", "20261020-120001_sherlock_jd_bbbb.txt"),
		"found https://github.com/jd and jd@example.com\nalso EXAMPLE.com, 8.8.8.8 and notes.txt\n",
		envelope.Entity{Type: "account", Value: "github.com/jd"})
	write(t, filepath.Join(dir, "sherlock", "jd", "20261020-120000_sherlock_jd_aaaa.txt"), "jd@example.com at sub.example.org\n")
	write(t, filepath.Join(dir, "sherlock", "jd", "20261020-120000_sherlock_jd_aaaa.stderr.txt"), "warn@example.net\n")

	files, err := Outputs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || filepath.Base(files[0]) != "20261020-120000_sherlock_jd_aaaa.txt" {
		t.Fatalf("outputs, oldest first, without stderr: %v", files)
	}
	ind, err := Extract(files)
	if err != nil {
		t.Fatal(err)
	}
	want := &Indicators{
		Emails:   []string{"jd@example.com"},
		Domains:  []string{"example.com", "sub.example.org", "github.com"},
		IPs:      []string{"8.8.8.8"},
		URLs:     []string{"https://github.com/jd"},
		Entities: map[string][]string{"account": {"github.com/jd"}},
	}
	if !reflect.DeepEqual(ind, want) {
		t.Fatalf("got  %+v\nwant %+v", ind, want)
	}
}

func TestDiff(t *testing.T) {
	dir := t.TempDir()
	older := write(t, filepath.Join(dir, "a.txt"), "github\nreddit\nreddit\n", envelope.Entity{Type: "account", Value: "github/jd"})
	newer := write(t, filepath.Join(dir, "b.txt"), "reddit\ngitlab\r\ngithub\n\n", envelope.Entity{Type: "account", Value: "gitlab/jd"})
	c, err := Diff(older, newer)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(c.Added, []string{"gitlab"}) || !reflect.DeepEqual(c.Removed, []string{"reddit"}) ||
		!reflect.DeepEqual(c.AddedEntities, []string{"account: gitlab/jd"}) || !reflect.DeepEqual(c.RemovedEntities, []string{"account: github/jd"}) ||
		c.OlderDate != "2026-10-20T12:00:00Z" {
		t.Fatalf("%+v", c)
	}
	same, _ := Diff(older, older)
	if len(same.Added)+len(same.Removed)+len(same.AddedEntities)+len(same.RemovedEntities) != 0 {
		t.Fatalf("a run compared with itself: %+v", same)
	}
}
