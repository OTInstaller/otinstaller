package scaffold

import (
	"os"
	"strings"
	"testing"

	"github.com/otinstaller/otinstaller/cli/internal/manifest"
)

func TestFilesPerHost(t *testing.T) {
	cases := []struct {
		kind, host, workflow string
	}{
		{"docker", "github", ".github/workflows/otinstaller-release.yml"},
		{"docker", "gitlab", ".gitlab-ci.yml"},
		{"pipx", "github", ".github/workflows/otinstaller-release.yml"},
		{"pipx", "gitlab", ".gitlab-ci.yml"},
		{"guide", "github", ".github/workflows/otinstaller-release.yml"},
		{"guide", "gitlab", ".gitlab-ci.yml"},
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
		want := map[string]string{"docker": "cosign sign", "pipx": "pypi", "guide": "version: "}[c.kind]
		if !strings.Contains(strings.ToLower(wf), want) || !strings.Contains(wf, "git tag") {
			t.Errorf("%s/%s workflow lacks %q or tagging", c.kind, c.host, want)
		}
		if !strings.Contains(files["README.md"], "Demo package for tests") {
			t.Errorf("%s/%s: README.md missing or without the summary", c.kind, c.host)
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

// The CLI embeds copies of the spec's release templates, which the registry's import wizard also uses.
func TestTemplatesMatchSpec(t *testing.T) {
	for _, name := range []string{"github-docker.yml", "github-pipx.yml", "github-guide.yml", "gitlab-docker.yml", "gitlab-pipx.yml", "gitlab-guide.yml"} {
		spec, err := os.ReadFile("../../../spec/templates/" + name)
		if err != nil {
			t.Fatal(err)
		}
		local, err := os.ReadFile("templates/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if string(spec) != string(local) {
			t.Errorf("templates/%s differs from spec/templates; run `go generate ./...`", name)
		}
	}
	if ReleaseTemplate("gitlab", "pipx") != gitlabPipxTmpl || ReleaseTemplate("github", "docker") != githubDockerTmpl || ReleaseTemplate("gitlab", "guide") != gitlabGuideTmpl {
		t.Error("ReleaseTemplate picks the wrong template")
	}
}

// The example Dockerfile builds in a fresh repository: without a Python project it installs a starter
// script under the package name, which the registry uses as the entrypoint.
func TestExampleDockerfile(t *testing.T) {
	p := Params{Kind: "docker", Name: "demo-tool", Namespace: "dheeraj", Summary: "Demo package for tests", License: "MIT", Category: "utilities", Input: "domain"}
	files, err := Files(p)
	if err != nil {
		t.Fatal(err)
	}
	df := files["Dockerfile.otinstaller-example"]
	if strings.Contains(df, "pip install") || !strings.Contains(df, "COPY tool.py /usr/local/bin/demo-tool") {
		t.Errorf("starter Dockerfile:\n%s", df)
	}
	if !strings.Contains(files["tool.py.otinstaller-example"], `prog="demo-tool"`) {
		t.Error("no starter script")
	}
	p.PythonProject = true
	files, _ = Files(p)
	if !strings.Contains(files["Dockerfile.otinstaller-example"], "pip install --no-cache-dir .") || files["tool.py.otinstaller-example"] != "" {
		t.Error("a Python project should be installed with pip, without a starter script")
	}
}
