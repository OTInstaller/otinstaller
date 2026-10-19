package scaffold

import (
	"strings"
	"testing"

	"github.com/osintverse/otinstaller/cli/internal/manifest"
)

func TestFilesPerHost(t *testing.T) {
	cases := []struct {
		kind, host, workflow string
	}{
		{"docker", "github", ".github/workflows/otinstaller-release.yml"},
		{"docker", "gitlab", ".gitlab-ci.yml"},
		{"pipx", "github", ".github/workflows/otinstaller-release.yml"},
		{"pipx", "gitlab", ".gitlab-ci.yml"},
	}
	for _, c := range cases {
		files, err := Files(Params{Kind: c.kind, Host: c.host, Name: "demo-tool", Namespace: "dheeraj", Summary: "Demo package for tests",
			License: "MIT", Category: "utilities", Input: "domain", Package: "demo-tool"})
		if err != nil {
			t.Fatal(err)
		}
		wf, ok := files[c.workflow]
		if !ok {
			t.Fatalf("%s/%s: missing %s", c.kind, c.host, c.workflow)
		}
		// Release workflows must sign (Docker) or use trusted publishing (pipx), and tag after pinning.
		want := map[string]string{"docker": "cosign sign", "pipx": "pypi"}[c.kind]
		if !strings.Contains(strings.ToLower(wf), want) || !strings.Contains(wf, "git tag") {
			t.Errorf("%s/%s workflow lacks %q or tagging", c.kind, c.host, want)
		}
		doc, m, err := manifest.Parse([]byte(files["otinstaller.yaml"]))
		if err != nil {
			t.Fatal(err)
		}
		if ps := manifest.Validate(doc, m, manifest.Options{}); len(ps) > 0 {
			t.Errorf("%s/%s manifest invalid: %v", c.kind, c.host, ps)
		}
	}
}
