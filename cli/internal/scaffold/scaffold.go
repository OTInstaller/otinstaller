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
	// PythonProject is set when the repo already has pyproject.toml or setup.py; the example Dockerfile
	// then installs it, and otherwise ships a starter script that builds and runs as is.
	PythonProject bool
	Repo          string // e.g. github.com/dheeraj/holehe-lite
	Host          string // github | gitlab
}

// HasPythonProject reports whether pip can install the repository.
func HasPythonProject(dir string) bool {
	for _, f := range []string{"pyproject.toml", "setup.py"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			return true
		}
	}
	return false
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
	//go:embed templates/github-guide.yml
	githubGuideTmpl string
	//go:embed templates/gitlab-guide.yml
	gitlabGuideTmpl string
)

// ReleaseTemplate is the release workflow for a host ("github" or "gitlab") and kind ("docker", "pipx" or "guide").
func ReleaseTemplate(host, kind string) string {
	switch {
	case host == "gitlab" && kind == "guide":
		return gitlabGuideTmpl
	case kind == "guide":
		return githubGuideTmpl
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
	// The manifest points tools at README.md, so it is created too; existing files are never overwritten
	// without --force.
	files := map[string]string{"otinstaller.yaml": manifestTmpl, "README.md": toolReadmeTmpl}
	switch p.Kind {
	case "docker":
		if p.PythonProject {
			files["Dockerfile.otinstaller-example"] = dockerfilePipTmpl
		} else {
			files["Dockerfile.otinstaller-example"] = dockerfileStarterTmpl
			files["tool.py.otinstaller-example"] = starterScriptTmpl
		}
	case "pipx":
	case "guide":
		files["README.md"] = guideReadmeTmpl
		files["docs/index.md"] = guideIndexTmpl
		files["docs/01-scope-and-legal.md"] = guideLegalTmpl
	default:
		return nil, fmt.Errorf("unknown kind %q", p.Kind)
	}
	if p.Host == "gitlab" {
		files[".gitlab-ci.yml"] = ReleaseTemplate("gitlab", p.Kind)
	} else {
		files[".github/workflows/otinstaller-release.yml"] = ReleaseTemplate("github", p.Kind)
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
  # Safe test values only. Used by ` + "`ot validate --smoke`" + ` and the publish scan.
  input: { target: "example.com" }
<<- end >>
`

// The registry runs the image with --entrypoint set to the first word of runtime.command (the package
// name), so both Dockerfiles put an executable of that name on the PATH.
const dockerfileStarterTmpl = `# Example only: replace tool.py with your tool, or this file with your own Dockerfile.
FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
COPY tool.py /usr/local/bin/<< .Name >>
RUN chmod 755 /usr/local/bin/<< .Name >>
USER app
ENTRYPOINT ["<< .Name >>"]
`

// starterScriptTmpl answers the scaffolded command ("<name> --json <target>") with an empty result.
const starterScriptTmpl = `#!/usr/bin/env python3
"""Starter for << .Name >>: replace the lookup with your tool's logic.

Prints {"entities": [...]} so ot can turn the output into its result envelope.
"""
import argparse
import json


def lookup(target):
    # Return entities such as {"type": "account", "value": "...", "source": "..."}.
    return []


def main():
    parser = argparse.ArgumentParser(prog="<< .Name >>")
    parser.add_argument("--json", action="store_true", help="print JSON")
    parser.add_argument("target")
    args = parser.parse_args()
    print(json.dumps({"entities": lookup(args.target)}))


if __name__ == "__main__":
    main()
`

const dockerfilePipTmpl = `# Example only: keep your own Dockerfile if you have one.
FROM python:3.12-slim
RUN useradd --uid 10001 --create-home app
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir .
USER app
ENTRYPOINT ["<< .Name >>"]
`

const toolReadmeTmpl = `# << .Name >>

<< .Summary >>

## Install and run

    ot install << .Namespace >>/<< .Name >>
    ot run << .Namespace >>/<< .Name >> --target <value>

## What it does and what data it touches

Describe what the tool looks up, which sites or APIs it contacts, and what personal data it returns.
A reviewer reads this before your first release goes public.
`

const guideReadmeTmpl = `# << .Summary >>

The guide << .Namespace >>/<< .Name >> on the OTInstaller Registry. Its pages are in docs/, in the order
listed under content.nav in otinstaller.yaml.

Read it in a terminal with:

    ot guide read << .Namespace >>/<< .Name >>

To release a new version, run ` + "`ot release X.Y.Z`" + ` here: it sets the version, checks the guide, commits and pushes the
tag vX.Y.Z. The otinstaller release workflow does the same from the Actions tab if you prefer.
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
