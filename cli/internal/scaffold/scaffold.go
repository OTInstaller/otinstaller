// Package scaffold generates the files `ot init` writes into a repository.
package scaffold

import (
	"bytes"
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

const githubDockerTmpl = `# Builds a multi-arch image, signs it, pins its digest in otinstaller.yaml and tags the release.
# Run it from the Actions tab with the version to release.
name: otinstaller release
on:
  workflow_dispatch:
    inputs:
      version:
        description: Version to release (e.g. 1.2.0)
        required: true
permissions:
  contents: write
  packages: write
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-qemu-action@v3
      - uses: docker/setup-buildx-action@v3
      - uses: sigstore/cosign-installer@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: build
        uses: docker/build-push-action@v6
        with:
          push: true
          platforms: linux/amd64,linux/arm64
          tags: ghcr.io/${{ github.repository }}:${{ inputs.version }}
      - name: Sign
        run: cosign sign --yes "ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}"
      - name: Pin digest and tag
        env:
          VERSION: ${{ inputs.version }}
          IMAGE: ghcr.io/${{ github.repository }}@${{ steps.build.outputs.digest }}
        run: |
          IMAGE=$(echo "$IMAGE" | tr '[:upper:]' '[:lower:]')
          sed -i -E "s|^version: .*|version: ${VERSION}|; s|^  image: .*|  image: ${IMAGE}|" otinstaller.yaml
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -am "Release ${VERSION}"
          git tag "v${VERSION}"
          git push origin HEAD "v${VERSION}"
`

const gitlabDockerTmpl = `# Builds the image, signs it with GitLab's OIDC token, pins its digest and tags the release.
# Run a pipeline manually with the variable VERSION set (e.g. 1.2.0). RELEASE_TOKEN is a project
# access token with write_repository, used to push the release commit and tag.
otinstaller-release:
  image: docker:27
  services: [docker:27-dind]
  rules:
    - if: $CI_PIPELINE_SOURCE == "web" && $VERSION
  id_tokens:
    SIGSTORE_ID_TOKEN:
      aud: sigstore
  script:
    - apk add --no-cache git cosign
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
    - docker buildx create --use
    - docker buildx build --platform linux/amd64,linux/arm64 --push -t "$CI_REGISTRY_IMAGE:$VERSION" --metadata-file meta.json .
    - DIGEST=$(sed -n 's/.*"containerimage.digest": *"\([^"]*\)".*/\1/p' meta.json)
    - cosign sign --yes "$CI_REGISTRY_IMAGE@$DIGEST"
    - sed -i -E "s|^version: .*|version: $VERSION|; s|^  image: .*|  image: $CI_REGISTRY_IMAGE@$DIGEST|" otinstaller.yaml
    - git config user.name "otinstaller release"
    - git config user.email "release@otinstaller.invalid"
    - git commit -am "Release $VERSION"
    - git tag "v$VERSION"
    - git push "https://oauth2:${RELEASE_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git" HEAD:$CI_DEFAULT_BRANCH "v$VERSION"
`

const githubPipxTmpl = `# Publishes to PyPI with Trusted Publishing, pins the wheel hash in otinstaller.yaml and tags the release.
name: otinstaller release
on:
  workflow_dispatch:
    inputs:
      version:
        description: Version to release (must match pyproject.toml)
        required: true
permissions:
  contents: write
  id-token: write
jobs:
  release:
    runs-on: ubuntu-latest
    environment: pypi
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - run: python -m pip install build && python -m build
      - uses: pypa/gh-action-pypi-publish@release/v1
      - name: Pin wheel hash and tag
        env:
          VERSION: ${{ inputs.version }}
        run: |
          SHA=$(sha256sum dist/*.whl | cut -d' ' -f1)
          sed -i -E "s|^version: .*|version: ${VERSION}|; s|^  package_version: .*|  package_version: \"${VERSION}\"|; s|^  wheel_sha256: .*|  wheel_sha256: \"${SHA}\"|" otinstaller.yaml
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -am "Release ${VERSION}"
          git tag "v${VERSION}"
          git push origin HEAD "v${VERSION}"
`

const gitlabPipxTmpl = `# Publishes to PyPI with Trusted Publishing, pins the wheel hash in otinstaller.yaml and tags the release.
# Configure a GitLab trusted publisher for this project on PyPI first, then run a pipeline manually
# with the variable VERSION set (it must match pyproject.toml). RELEASE_TOKEN is a project access token
# with write_repository, used to push the release commit and tag.
otinstaller-release:
  image: python:3.12
  rules:
    - if: $CI_PIPELINE_SOURCE == "web" && $VERSION
  id_tokens:
    PYPI_ID_TOKEN:
      aud: pypi
  script:
    - python -m pip install build twine
    - python -m build
    - RESP=$(curl -sSf -X POST https://pypi.org/_/oidc/mint-token -d "{\"token\":\"${PYPI_ID_TOKEN}\"}")
    - export TWINE_USERNAME=__token__
    - export TWINE_PASSWORD=$(python -c "import json,sys; print(json.loads(sys.argv[1])['token'])" "$RESP")
    - python -m twine upload dist/*
    - SHA=$(sha256sum dist/*.whl | cut -d' ' -f1)
    - sed -i -E "s|^version: .*|version: $VERSION|; s|^  package_version: .*|  package_version: \"$VERSION\"|; s|^  wheel_sha256: .*|  wheel_sha256: \"$SHA\"|" otinstaller.yaml
    - git config user.name "otinstaller release"
    - git config user.email "release@otinstaller.invalid"
    - git commit -am "Release $VERSION"
    - git tag "v$VERSION"
    - git push "https://oauth2:${RELEASE_TOKEN}@${CI_SERVER_HOST}/${CI_PROJECT_PATH}.git" HEAD:$CI_DEFAULT_BRANCH "v$VERSION"
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
