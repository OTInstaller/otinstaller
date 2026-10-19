// Package scaffold generates the files `ot init` writes into a repository.
package scaffold

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"text/template"
)

type Params struct {
	Kind      string // docker | pipx | guide
	Name      string
	Namespace string
	Summary   string
	License   string
	Category  string
	Input     string // first input type, tools only
	Package   string // pipx only
	Repo      string // e.g. github.com/dheeraj/holehe-lite
	Host      string // github | gitlab
}

// Detect guesses the package kind from files already in the repo.
func Detect(dir string) string {
	has := func(p string) bool { _, err := os.Stat(filepath.Join(dir, p)); return err == nil }
	switch {
	case has("Dockerfile"):
		return "docker"
	case has("pyproject.toml") || has("setup.py"):
		return "pipx"
	case has("mkdocs.yml") || has("docs"):
		return "guide"
	}
	return ""
}

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Slug turns a directory or repo name into a valid package name.
func Slug(s string) string {
	s = strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 40 {
		s = strings.Trim(s[:40], "-")
	}
	return s
}

var remoteRe = regexp.MustCompile(`(github\.com|gitlab\.com)[:/]([^/]+)/([^/]+?)(\.git)?$`)

// GitRemote reads origin's host and owner, used as defaults for the namespace.
func GitRemote(dir string) (host, owner, repo string) {
	out, err := exec.Command("git", "-C", dir, "remote", "get-url", "origin").Output()
	if err != nil {
		return "", "", ""
	}
	m := remoteRe.FindStringSubmatch(strings.TrimSpace(string(out)))
	if m == nil {
		return "", "", ""
	}
	return strings.TrimSuffix(m[1], ".com"), m[2], m[3]
}

// Release workflows are shared with the registry's import wizard; the canonical copies live in
// spec/templates. Run `go generate ./...` after changing them.
//
//go:generate go run sync_templates.go
var (
	//go:embed templates/github-docker.yml
	githubDockerTmpl string
	//go:embed templates/github-pipx.yml
	githubPipxTmpl string
	//go:embed templates/gitlab-docker.yml
	gitlabDockerTmpl string
	//go:embed templates/gitlab-pipx.yml
	gitlabPipxTmpl string
)

// ReleaseTemplate is the release workflow for a host ("github" or "gitlab") and runtime ("docker" or "pipx").
func ReleaseTemplate(host, kind string) string {
	switch {
	case host == "gitlab" && kind == "pipx":
		return gitlabPipxTmpl
	case host == "gitlab":
		return gitlabDockerTmpl
	case kind == "pipx":
		return githubPipxTmpl
	}
	return githubDockerTmpl
}

// Files returns path -> content for everything `ot init` creates.
func Files(p Params) (map[string]string, error) {
	files := map[string]string{"otinstaller.yaml": manifestTmpl}
	switch p.Kind {
	case "docker":
		files["Dockerfile.otinstaller-example"] = dockerfileTmpl
		if p.Host == "gitlab" {
			files[".gitlab-ci.yml"] = gitlabDockerTmpl
		} else {
			files[".github/workflows/otinstaller-release.yml"] = githubDockerTmpl
		}
	case "pipx":
		if p.Host == "gitlab" {
			files[".gitlab-ci.yml"] = gitlabPipxTmpl
		} else {
			files[".github/workflows/otinstaller-release.yml"] = githubPipxTmpl
		}
	case "guide":
		files["docs/index.md"] = guideIndexTmpl
		files["docs/01-scope-and-legal.md"] = guideLegalTmpl
	default:
		return nil, fmt.Errorf("unknown kind %q", p.Kind)
	}
	out := map[string]string{}
	for path, src := range files {
		t, err := template.New(path).Delims("<<", ">>").Parse(src)
		if err != nil {
			return nil, err
		}
		var b bytes.Buffer
		if err := t.Execute(&b, p); err != nil {
			return nil, err
		}
		out[path] = b.String()
	}
	return out, nil
}

const manifestTmpl = `# OTInstaller manifest. Reference: https://otinstaller.com/docs/manifest
# yaml-language-server: $schema=https://otinstaller.com/schema/v1.json
schema: 1
<<- if eq .Kind "guide" >>
kind: guide
<<- end >>
name: << .Name >>
namespace: << .Namespace >>
version: 0.1.0
summary: << .Summary >>
license: << .License >>
<<- if .Repo >>
homepage: https://<< .Repo >>
<<- end >>
categories: [<< .Category >>]
<<- if eq .Kind "guide" >>
title: << .Summary >>
level: beginner
format: guide
language: en
content:
  root: docs/
  nav:
    - index.md
    - 01-scope-and-legal.md
related_tools: []
topics: [<< .Input >>]
<<- else >>
readme: README.md
inputs:
  - name: target
    type: << .Input >>
    required: true
outputs:
  - type: other
runtime:
<<- if eq .Kind "docker" >>
  kind: docker
  # Filled in by the release workflow with the pushed image's digest.
  image: ghcr.io/<< .Namespace >>/<< .Name >>@sha256:0000000000000000000000000000000000000000000000000000000000000000
  platforms: [linux/amd64, linux/arm64]
  command: ["<< .Name >>", "--json", "{target}"]
<<- else >>
  kind: pipx
  package: << .Package >>
  package_version: 0.1.0
  index: pypi
  python: ">=3.10"
  entrypoint: << .Name >>
  # Filled in by the release workflow with the published wheel's SHA-256.
  wheel_sha256: "0000000000000000000000000000000000000000000000000000000000000000"
  command: ["<< .Name >>", "--json", "{target}"]
<<- end >>
  output_format: json
  timeout_seconds: 300
ethics:
  # Answer honestly; these are shown on the package page and checked at review.
  touches_target: false
  auth_required: false
  collects_personal_data: true
test:
  # Safe test values only. Used by ` + "`ot validate --smoke`" + ` and nightly health checks.
  input: { target: "example.com" }
<<- end >>
`

const dockerfileTmpl = `# Example only: keep your own Dockerfile if you have one.
FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir .
USER app
ENTRYPOINT ["<< .Name >>"]
`

const guideIndexTmpl = `# << .Summary >>

What this guide covers, who it is for, and what you need before starting.

## Tools used

List the registry tools this guide uses, and add them to ` + "`related_tools`" + ` in otinstaller.yaml.
`

const guideLegalTmpl = `# Scope and legal note

> [!WARNING]
> Only investigate people and organizations you have a lawful basis to research. Use fictional
> data, your own data, or public figures in their public role in every example.
`
