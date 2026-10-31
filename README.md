# OTInstaller

**Stop fixing OSINT tools. Start using them.**

OTInstaller is the package manager and largest registry built only for OSINT tools: over 130 tools and a set of
investigation guides, free at [otinstaller.com](https://otinstaller.com). One command installs, runs, updates or
removes any of them on Windows, macOS or Linux.

| Job | Today | With OTInstaller |
| --- | --- | --- |
| Install a tool | Clone it, find a Python it still works with, make a virtualenv, untangle conflicting requirements, then repeat for the next tool | `ot install osintverse-community/holehe`, or just run it |
| Run it | Read each README for its flags | The same typed inputs for every tool: `ot run osintverse-community/holehe e:ada@example.com` |
| Use the results | Text, CSV, HTML and JSON, a different shape per tool, sent on as screenshots | Every run saved under `results/` in one JSON shape, ready for scripts and AI agents; `ot share 3f9a1c2e` gives a link to it that works for 24 hours |
| API keys | Spread across config files and shell history | One keychain: `ot keys set ABUSEIPDB_API_KEY`; each tool gets only its own keys |
| Keep it working | Find out a tool broke in the middle of a case | Every tool run every night; `ot outdated`, `ot update --all` |
| Trust it | Run a stranger's script with full access to your files | Pinned, scanned and run in a container that can't read your files |
| Remove it | Leftovers in your system Python | `ot uninstall osintverse-community/holehe` |

Two editions share the same typed inputs and `results/` layout:

- **`ot`** (Windows, macOS, Linux; needs Docker or Podman) installs signed, scanned packages from the registry and
  runs them in a sandbox.
- **`otlite`** (Linux and macOS, no Docker) is every popular OSINT tool, managed for you: each one pinned and tested,
  in its own virtualenv, with every API key in one file.

## Install

`ot` on macOS or Linux:

```sh
curl -fsSL https://get.otinstaller.com/ot | sh
```

`ot` on Windows (PowerShell):

```powershell
irm https://get.otinstaller.com/ot.ps1 | iex
```

The scripts download the latest release from [OTInstaller/ot](https://github.com/OTInstaller/ot/releases) and check
its signed checksums before installing; archives, deb and rpm packages are there too. `ot` needs Docker Desktop or
Podman running, and uses `cosign` to verify images when it's installed.

`otlite` on Linux or macOS, with nothing installed first (or `pipx install otlite`):

```sh
curl -fsSL https://get.otinstaller.com/otlite | sh
```

## First run

```sh
ot start                                                 # pick tools, AI agents and settings, then install them
ot doctor                                                # checks Docker, cosign, the keychain and the registry
ot search email                                          # tools that take an email address
ot run osintverse-community/holehe e:someone@example.com # installs it on first use, then runs it
ot auto someone@example.com                              # every installed tool that takes this input
ot runs                                                  # saved runs, newest first
```

Typed inputs fill the matching input of any tool: `u:` username, `e:` email, `d:` domain, `p:` phone, `ip:` IP
address and `url:` URL. Every run is saved under `./results/` with a `.meta.json` sidecar, and prints one JSON envelope
whose shape is the same for every tool ([results](https://otinstaller.com/docs/results)). `ot pivot <run-id>` suggests
what to run next from what a run found, and `ot playbook --list` shows bundled tool sets for a username, an email, a
domain, a phone number or an IP address.

`ot start` is a short wizard: starter packs (the bundled playbooks) and tools from the registry, which AI clients get
ot's MCP server, the output format, where results go, and API keys. [otinstaller.com/start](https://otinstaller.com/start)
builds the same choices into one command to copy.

More in the [quick start](https://otinstaller.com/docs/quick-start), the
[getting started guide](https://otinstaller.com/docs/getting-started) and the
[CLI reference](https://otinstaller.com/docs/cli). For otlite, see [otlite/README.md](otlite/README.md).

## For AI agents

- **`ot mcp`** is a local MCP server that searches, installs and runs tools on your machine. `ot mcp install claude`
  (or `claude-desktop`, `cursor`, `vscode`, `codex`, `gemini`) adds it to your client. The agent asks you before any
  run that goes online, touches a target or involves a person's identifiers, and every run is written to a local
  audit log (`ot mcp audit`). See [AI agents and MCP](https://otinstaller.com/docs/agents).
- **The agent plugin** for Claude Code and Cursor adds skills for investigating, packaging tools and writing guides:
  [OTInstaller/agent-plugin](https://github.com/OTInstaller/agent-plugin), built from
  [integrations/agent-plugin/](integrations/agent-plugin).
- **The remote MCP server** at `https://api.otinstaller.com/mcp` searches the registry and reads guides without
  installing anything.
- **Scripts and CI**: `--json` (or `OT_OUTPUT=json`) on every command, one-line JSON errors on stderr, stable exit
  codes, and no prompts without a terminal ([automation](https://otinstaller.com/docs/automation)).

## Publish a tool or a guide

A package is a repository (on GitHub or GitLab) or an upload with an `otinstaller.yaml` manifest next to it. `ot init`
writes a starter manifest, Dockerfile and release workflow; `ot validate` checks it against
[the schema](https://otinstaller.com/schema/v1.json).

- **From a repository:** run the release workflow `ot init` added, from the Actions tab with the version to
  release. It builds and signs the image, pins its digest in the manifest and tags the release, which the registry
  picks up; or it publishes with `ot publish --oidc` as a trusted publisher. `ot import <repository-url>` drafts the
  manifest for an existing project and opens a pull or merge request with it.
- **Without a repository:** `ot namespace create <name>`, then `ot publish` uploads the manifest, README and docs, and
  `--image` or `--build` pushes the Docker image to the registry's own mirror.
- **Guides** are Markdown pages with `kind: guide`, released with `ot release X.Y.Z`.

Every release is validated, security-scanned (signature, Trivy, GuardDog and a sandboxed smoke test) or, for guides,
link- and content-checked, then published; a new publisher's first release waits for a reviewer. See
[publishing](https://otinstaller.com/docs/publishing) and [the manifest](https://otinstaller.com/docs/manifest).

## Security model

- Docker images are pinned by digest and their cosign signature is checked against the publisher's identity; wheels
  are pinned by SHA-256 and checked again after download. A pipx tool runs in the image the registry built from its
  wheel and scanned, pulled by digest and signed by the registry's scanner, or one `ot` builds from the same
  hash-locked dependencies.
- Tools run with a read-only root, no capabilities, no new privileges, an unprivileged user, memory, CPU and process
  limits, and no network unless the manifest declares it. They see only an output folder and the API keys they declare
  (a pipx tool you choose to run with `--native` runs outside the container instead).
- If the original host refuses an artifact, `ot` installs the same digest or hash from the registry's mirror and
  checks it the same way. Network errors never trigger that fallback.
- A tool is marked possibly broken while it has an open broken issue, or while at least two signed-in people said in
  the last 30 days that its latest version is broken and they outnumber those who said it works.

Details: [security](https://otinstaller.com/docs/security) and the
[acceptable use policy](https://otinstaller.com/policy/acceptable-use).

## Feedback and security reports

- Bugs and ideas: [OTInstaller/feedback](https://github.com/OTInstaller/feedback/issues), or `ot feedback "..."` from
  the terminal.
- A problem with a published tool (malware, abuse, a license): report it from the tool's page on otinstaller.com.
- A security problem in OTInstaller itself: email security@otinstaller.com instead of opening an issue.

## Development

This repository holds the open-source parts of OTInstaller. The website at otinstaller.com is built from a separate
repository that includes this one. [AGENTS.md](AGENTS.md) is the guide to working on the code, and
[docs/dev/](docs/dev/README.md) the developer reference: architecture, every API route, the database, every `ot`
command, configuration, local setup and troubleshooting. To run your own registry with real GitHub and GitLab apps,
follow [docs/publishing-setup.md](docs/publishing-setup.md).

| Folder | What it is |
| --- | --- |
| `spec/` | The manifest JSON Schema (`schema/v1.json`), the envelope, run-all and error schemas, valid and invalid example manifests, the release workflow templates, and the import wizard's Dockerfile templates |
| `cli/` | `ot` (Go): installing and running tools, typed inputs, playbooks, saved runs, keys, publishing, `ot mcp`, self-update |
| `api/` | The registry API (Cloudflare Workers, Hono, D1, Queues, R2): search and reads, sign-in, publishing and review, scans, backups, the community features and the remote MCP server; plus the image mirror Worker (`src/mirror/`) |
| `ops/` | The scanner and backup jobs (`scanner/`), the workflows that run them in a separate repository, and the Worker behind get.otinstaller.com (`get/`) |
| `otlite/` | otlite, the no-Docker edition (Python), with its own [README](otlite/README.md), [rules](otlite/AGENTS.md), tests, Debian packaging and release workflow |
| `seed/` | The launch seed: first-party tools, community wrappers of third-party tools, and guides, each its own repository under `osintverse-community` ([seed/README.md](seed/README.md)) |
| `integrations/` | The agent plugin and the remote MCP server's MCP Registry entry |
| `examples/` | A tiny real tool and two real packages used by the end-to-end tests |
| `scripts/` | The end-to-end tests and the install scripts |
| `docs/` | The developer reference (`dev/`), the operator runbook, design notes and the `otinstaller` to `ot` migration guide |

Requirements: Go 1.25+, Node.js 22+, Docker Desktop or Podman, and Python 3.12 (3.10+ on Linux or macOS for otlite).

```sh
(cd cli && go test ./... && go build -o ../bin/ot ./cmd/ot)       # the CLI
(cd api && npm install && npm test)                                # the API, in the Workers runtime with a seeded D1
(cd api && npm run db:migrate && npm run db:seed && npm run dev)   # a local registry at http://127.0.0.1:8787/v1
python -m unittest discover ops/scanner                            # the scanner
(cd otlite && pip install -e ".[dev,pipeline]" && pytest)          # otlite (Linux or macOS)
bash scripts/e2e.sh                                                # end to end, with Docker
```

Point `ot` at a local registry with `OT_API_URL=http://127.0.0.1:8787/v1`. CI runs otlite's tests and the install
scripts, not the Go or API tests, so run those before opening a pull request. Changes to `spec/` have copies to
regenerate (`go generate ./...` in `cli/`, `npm run sync:templates` in `api/`); AGENTS.md lists them.

`otlite/` was imported with `git subtree`, so its full history is kept: `git log --follow otlite/pyproject.toml`
shows the import and `git log 842c78e` the original commits. It was renamed from `otinstaller` to `otlite` at 1.0.0;
[docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md) maps its commands to `ot`.

## License

Apache License 2.0 ([LICENSE](LICENSE)). `otlite/` keeps its own copy of the same [LICENSE](otlite/LICENSE) and its
[NOTICE](otlite/NOTICE), which must be kept with any redistribution or derived work of it ("OTinstaller by
OSINTverse"). Tools installed by either CLI, and the upstream projects the community wrappers in `seed/` package, keep
their own licenses.

## Design notes

- Guide manifests use `topics:` (not `inputs:`) for what a guide helps investigate, so `inputs` always means tool inputs.
- `ot` drives the `docker` (or `podman`) CLI rather than the Engine API, which keeps it working with Docker Desktop,
  OrbStack, Colima and Podman.
- The scanner resolves a pipx tool's dependencies once, pins each with the SHA-256 of every file PyPI has for it (so
  the lock installs on amd64 and arm64), builds the sandbox image from that lock on `python:3.12-slim` pinned by digest,
  scans and smoke-tests it, and pushes it to the mirror signed by its workflow. `ot` pulls that image on amd64;
  elsewhere, or when it can't, it builds `ot-local/<namespace>-<name>:<version>` from the verified wheel and the same
  lock, so nothing is resolved again at install time.
- Smoke tests run offline unless the manifest declares `network.egress: true`; then they keep the network, on a
  disposable runner with no secrets in the container. Fully offline smoke tests would fail most OSINT tools.
- Wheels are scanned for vulnerabilities in their Python packages only; the base image the scanner wraps them in is not
  the author's. Docker images are not run through GuardDog (it reads Python packages); Trivy and the smoke test cover
  them.
- Release templates sign on the default branch before creating the tag, so the expected signer accepts the
  repository's CI on a branch ref as well as on the release tag.
- The import wizard opens GitHub pull requests through the GitHub App, so the App also needs Contents and Workflows
  write access (GitHub requires the Workflows permission to add a file under `.github/workflows/`). GitLab merge
  requests use the author's own token with the `api` scope, asked for only when they finish an import. A GitLab
  project that already has a `.gitlab-ci.yml` gets the release job as `.gitlab/otinstaller-release.yml`, with a note
  in the merge request to include it; an existing pipeline is never rewritten.
- The mirror is a small OCI registry of our own on R2 (`api/src/mirror/registry.ts`) rather than a fork of
  Cloudflare's serverless-registry: it only needs pulls, the scanner's pushes (including chunked uploads, for layers
  over the Workers request limit) and deletes for takedowns. It has no referrers API, so signatures use the tag schema:
  the scanner copies those tags with crane, and `cosign verify` reads them. Each repository keeps its own blobs, so a
  takedown never touches another package.
- Every published package has a registry-held copy (the image on the mirror, the wheel, and a `git bundle` of the
  source), so a ban or takedown on GitHub or GitLab never breaks installs or loses code. Git bundles hold branches and
  tags only, not the hosts' own refs (`refs/pull/*`, `refs/merge-requests/*`), which cannot be pushed to the other host.
- A registry-held manifest is published with the version from each new tag, and the image tagged with that version
  (or the PyPI wheel of that version) is looked up at publish time, so authors don't edit the manifest for every
  release.
