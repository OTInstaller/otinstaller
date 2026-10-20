package cli

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// guideRepo makes a git repository holding the valid guide fixture, with a bare repository as its origin.
func guideRepo(t *testing.T, manifestFile string) (dir, remote string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not installed")
	}
	root := t.TempDir()
	dir, remote = filepath.Join(root, "guide"), filepath.Join(root, "origin.git")
	fixtures := filepath.Join("..", "..", "..", "spec", "fixtures", "valid")
	must := func(_ string, err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must("", os.MkdirAll(filepath.Join(dir, "docs"), 0o755))
	copyFile(t, filepath.Join(fixtures, manifestFile), filepath.Join(dir, "otinstaller.yaml"))
	for _, p := range []string{"index.md", "01-scope-and-legal.md", "02-passive-checks.md", "usage.md", "output-fields.md"} {
		copyFile(t, filepath.Join(fixtures, "docs", p), filepath.Join(dir, "docs", p))
	}
	copyFile(t, filepath.Join(fixtures, "README.md"), filepath.Join(dir, "README.md"))
	must(git(root, "init", "-q", "--bare", remote))
	for _, args := range [][]string{
		{"init", "-q", "-b", "main"}, {"config", "user.name", "Test"}, {"config", "user.email", "test@example.com"},
		{"config", "commit.gpgsign", "false"}, {"config", "tag.gpgsign", "false"},
		{"add", "-A"}, {"commit", "-q", "-m", "Guide"}, {"remote", "add", "origin", remote}, {"push", "-q", "origin", "main"},
	} {
		must(git(dir, args...))
	}
	return dir, remote
}

func copyFile(t *testing.T, from, to string) {
	t.Helper()
	b, err := os.ReadFile(from)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(to, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseGuide(t *testing.T) {
	dir, remote := guideRepo(t, "guide.yaml")
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	if code := run(a, "release", "v1.1.0", dir); code != 0 {
		t.Fatalf("release exit %d: %s %s", code, out, errb)
	}
	if !strings.Contains(out.String(), "pushed v1.1.0") {
		t.Fatalf("unexpected output: %s", out)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "otinstaller.yaml"))
	if !strings.Contains(string(b), "\nversion: 1.1.0\n") {
		t.Fatalf("version not bumped:\n%s", b)
	}
	// The commit and the tag both reached the remote.
	if tags, _ := git(remote, "tag"); tags != "v1.1.0" {
		t.Fatalf("remote tags: %q", tags)
	}
	if msg, _ := git(remote, "log", "-1", "--format=%s", "main"); msg != "Release 1.1.0" {
		t.Fatalf("remote main is at %q", msg)
	}

	// The same version again is refused, and nothing changes.
	out.Reset()
	if code := run(a, "release", "1.1.0", dir); code != ExitUsage {
		t.Fatalf("second release exit %d, want %d", code, ExitUsage)
	}
}

func TestReleaseRefusals(t *testing.T) {
	dir, _ := guideRepo(t, "guide.yaml")
	a, _, errb := newTestApp(t, &fakeExec{}, "")

	if code := run(a, "release", "one.two", dir); code != ExitUsage || !strings.Contains(errb.String(), "not a version") {
		t.Fatalf("bad version: exit %d, %s", code, errb)
	}

	// Uncommitted changes would not be in the tagged commit.
	errb.Reset()
	if err := os.WriteFile(filepath.Join(dir, "docs", "index.md"), []byte("# changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if code := run(a, "release", "1.2.0", dir); code != ExitUsage || !strings.Contains(errb.String(), "commit your changes first") {
		t.Fatalf("dirty tree: exit %d, %s", code, errb)
	}
	if _, err := git(dir, "checkout", "--", "docs/index.md"); err != nil {
		t.Fatal(err)
	}

	// A version that fails the registry's checks is not committed or tagged, and the manifest is restored.
	errb.Reset()
	if err := os.Remove(filepath.Join(dir, "docs", "02-passive-checks.md")); err != nil {
		t.Fatal(err)
	}
	if _, err := git(dir, "commit", "-qam", "Drop a page"); err != nil {
		t.Fatal(err)
	}
	a2, out2, _ := newTestApp(t, &fakeExec{}, "")
	if code := run(a2, "release", "1.2.0", dir); code != ExitUsage || !strings.Contains(out2.String(), "Not released") {
		t.Fatalf("invalid guide: exit %d, %s", code, out2)
	}
	if tags, _ := git(dir, "tag"); tags != "" {
		t.Fatalf("tagged anyway: %q", tags)
	}
	if status, _ := git(dir, "status", "--porcelain"); status != "" {
		t.Fatalf("left changes behind: %q", status)
	}
}

func TestReleaseRefusesTools(t *testing.T) {
	dir, _ := guideRepo(t, "pipx-tool.yaml")
	a, _, errb := newTestApp(t, &fakeExec{}, "")
	if code := run(a, "release", "1.0.0", dir); code != ExitUsage || !strings.Contains(errb.String(), "release workflow") {
		t.Fatalf("tool: exit %d, %s", code, errb)
	}
}

func TestReleaseNoPush(t *testing.T) {
	dir, remote := guideRepo(t, "guide.yaml")
	a, out, errb := newTestApp(t, &fakeExec{}, "")
	if code := run(a, "release", "2.0.0", dir, "--no-push"); code != 0 {
		t.Fatalf("exit %d: %s %s", code, out, errb)
	}
	if tags, _ := git(dir, "tag"); tags != "v2.0.0" {
		t.Fatalf("local tags: %q", tags)
	}
	if tags, _ := git(remote, "tag"); tags != "" {
		t.Fatalf("pushed anyway: %q", tags)
	}
}
