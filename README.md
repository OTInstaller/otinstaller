# OTInstaller Registry

A free, public registry of OSINT tools and guides, and `ot`, the CLI that installs and runs them.
This repository holds weeks 1–7 of the plan: the manifest spec, the `ot` CLI, the registry API's read side,
publishing intake (GitHub/GitLab sign-in, the GitHub App webhook, the queue that validates tagged releases), and
security scans with the review queue (scanner, verdicts, publishing, reviewer decisions, emails), and GitLab support
with sync (connecting GitLab projects, GitLab webhooks and CI templates, and a poller that catches missed tags, renames,
archiving and deleted repositories), and the import wizard (detecting what a repository contains, drafting its manifest,
opening a pull or merge request, registry-held manifests, and bulk imports of up to 50 repositories), and source and
artifact backups (week 11: the image mirror at mirror.otinstaller.com, wheel and git bundle copies in R2, `ot`'s
fallback to them, Restore from backup, and a monthly restore drill).
To connect real GitHub and GitLab apps, follow [docs/publishing-setup.md](docs/publishing-setup.md).

It also holds `otlite`, the no-Docker edition: a Python CLI (from OSINTVerseHQ/OTinstaller, imported with its
history into `otlite/`, called `otinstaller` until 1.0) that installs tools from pip or git into per-tool virtualenvs
on Linux and macOS. Its tool catalog has also been converted into registry packages (see [otlite (otlite/)](#otlite-otlite)).
Moving between the two: [docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md).

| Folder | What it is |
| --- | --- |
| `spec/` | Manifest JSON Schema (`schema/v1.json`), example manifests (3 valid, 24 invalid with expected error codes) and the release workflow templates (`templates/`) that `ot init` and the import wizard both use |
| `cli/` | The `ot` CLI (Go): `init`, `validate`, `search`, `info`, `install`, `run`, `playbook`, `auto`, `extract`, `diff`, `list`, `outdated`, `update`, `uninstall`, `keys`, `doctor`, `login`, `logout`, `whoami`, `import`, `sync`, `feedback` |
| `api/` | Registry API (Cloudflare Workers + Hono + D1 + Queues + R2): search and read endpoints, GitHub/GitLab sign-in and device flow, API tokens, GitHub App webhooks, publish validation, the import wizard, backups; and the image mirror Worker (`src/mirror/`, `wrangler.mirror.jsonc`) |
| `web/` | The website (Astro on Cloudflare, Preact islands): home, search, tool and guide pages, docs, policies, the import wizard, dashboard and admin console. `npm run dev` for a dev server, `npm run og` to re-render the social preview image |
| `otlite/` | `otlite`, the no-Docker edition (Python, Linux and macOS): installs tools from pip or git into per-tool virtualenvs, typed inputs, saved results, Debian packaging, its own PyPI release workflow. See below |
| `seed/` | The launch seed: first-party tools, community wrappers (including those converted from `otlite`'s catalog), guides |
| `ops/` | The scanner (`scanner/scan.py`, backups and restore drills in `scanner/backup.py`, its Docker image) and the GitHub Actions workflows for the registry-ops repo |
| `examples/dns-lookup/` | A tiny real tool used by the end-to-end test |
| `examples/tldextract/`, `examples/cosign/` | Real packages (a PyPI wheel and Sigstore's signed image) used by `scripts/e2e-real.sh` |
| `scripts/e2e.sh` | Builds the example, pushes it to a local registry, then validates, smoke-tests and runs it with `ot` |
| `scripts/e2e-backups.sh` | The week 11 exit test: installs from the mirror and the wheel copy with the original registry blocked, and restores a bundle into an empty repository |

## Requirements

- Go 1.25+ (for the CLI)
- Node.js 22+ (for the API)
- Docker Desktop or Podman (to run Docker tools and sandboxed pipx tools)

## CLI

```bash
cd cli
go test ./...
go build -o ../bin/ot ./cmd/ot
../bin/ot validate ../spec/fixtures/valid/docker-tool.yaml
```

`ot` talks to `https://api.otinstaller.com/v1` by default. Point it at a local API with `OT_API_URL=http://127.0.0.1:8787/v1`.
Its data lives in `%APPDATA%\ot` on Windows and `~/.ot` elsewhere (override with `OT_HOME`). API keys go to the OS keychain;
an environment variable with the same name takes precedence, which is handy in CI.

Exit codes: 0 success, 1 tool error, 2 bad usage or invalid manifest, 3 missing key, 4 trust refusal, 5 runtime missing, 124 timeout,
130 interrupted.

`ot run` takes inputs as `--<input> <value>` or as typed inputs after the package, which fill the tool's input of that
type: `u:` username, `d:` domain, `e:` email, `p:` phone, `url:` url (`ot run osintverse-community/sherlock u:johndoe`).
Every run's raw output is saved to `./results/<tool>/<target>/<timestamp>_<tool>_<target>_<runid>.<ext>` with a
`.meta.json` sidecar (command, timing, exit code, status, SHA-256, entities); `--results-dir` or `OT_RESULTS_DIR` moves
it (`OTINSTALLER_RESULTS_DIR` still works), `--case NAME` groups runs under `cases/NAME/`, `--no-save` skips it. The
envelope still goes to stdout. `ot run --all u:johndoe` runs every installed tool with a username input, four at a time
(`--parallel N`), skips those that need other inputs or a missing key, and prints a summary (`--format json` for JSON).
These are the Python `otinstaller` features; see [docs/typed-inputs-and-results.md](docs/typed-inputs-and-results.md).

The CLI embeds copies of `spec/schema/v1.json` and `spec/templates/`. After changing the spec, run `go generate ./...` in `cli/`
and `npm run sync:templates` in `api/`; tests fail if the copies drift.

`ot import <github-or-gitlab-url>` publishes an existing repository: the registry drafts `otinstaller.yaml` from what is
in it (a Dockerfile, a `pyproject.toml` console script, or `docs/`), `ot` asks for what it could not detect (inputs,
outputs, command, ethics), and then opens a pull or merge request with the manifest and a release workflow. `--registry`
keeps the manifest on the registry instead (repository owners only), several URLs start a bulk import, and `--list`
shows your imports. `osintverse-community` admins can package a tool they don't own with `--community`: the draft goes
into the `osintverse-community` namespace (only for upstream licenses that allow it), the pull or merge request goes to a
wrapper repository (`--wrapper`) with a README crediting the upstream project, and the package is labelled
Community-packaged.

`ot sync <namespace/name>` checks a package's source repository now instead of waiting for a webhook or the 6-hourly
poll (10 times an hour at most); `ot sync --log <namespace/name>` shows its sync status and recent events.

## API

```bash
cd api
npm install
npm test                 # runs in the Workers runtime with a seeded D1
npm run db:migrate       # local D1
npm run db:seed          # demo packages from spec/fixtures plus a few extras
npm run dev              # http://127.0.0.1:8787/v1/tools
```

Before deploying, create the database with `npx wrangler d1 create otinstaller` and put its ID in `wrangler.jsonc`.

## End-to-end

With Docker running:

```bash
bash scripts/e2e.sh
```

Against real artifacts (a keyless-signed image and a real PyPI wheel), with Docker, cosign and the local API running:

```bash
bash scripts/e2e-real.sh
```

## Backups

Every published package has a registry-held copy, so a mistaken ban or takedown on GitHub or GitLab never breaks installs
or loses code. After a passing scan, the scan job copies the image with its signatures to the mirror (`crane copy`, same
digest, so cosign verifies the same signature), uploads the verified wheel and a `git bundle` of a mirror clone through
short-lived signed URLs, and reports back; a weekly job bundles every active source again. When the original registry
refuses an image (401, 403, 404, "denied"), `ot install` pulls the same digest from `mirror.otinstaller.com` and verifies it;
when PyPI no longer serves a wheel, it uses the registry's copy with the same SHA-256 check. Owners get Restore from
backup and Switch source on the dashboard. Rules: public repositories of published packages only; 500 MB per bundle and
2 GB per image; public mirrors only for OSI-approved licenses; takedowns delete backups 14 days later unless on legal
hold; owners can opt out of git backups. Setup (R2 buckets, the mirror Worker, DNS, credentials):
[docs/publishing-setup.md, section 11](docs/publishing-setup.md#11-backups-the-image-mirror-r2-buckets-and-restore-drills).

```bash
bash scripts/e2e-backups.sh   # needs Docker, cosign, crane, git, Go, Node and Python
```

## otlite (otlite/)

`otlite/` is the no-Docker edition of OTInstaller: the OTinstaller package manager, imported with `git subtree` so its
full history is kept (`git log --follow otlite/pyproject.toml` shows the import; `git log 3c3bfb5` the original
commits) and renamed from `otinstaller` to `otlite` at 1.0.0. It keeps its own conventions in
[otlite/AGENTS.md](otlite/AGENTS.md), its changelog and its Debian packaging (`otlite/debian/`, built from
`otlite/`). Install it with `pipx install otlite`; the docs are at
[otinstaller.com/docs/otlite](https://otinstaller.com/docs/otlite).

How it fits with the registry:

- **Two editions.** `ot` installs signed, scanned packages from the registry and runs them in containers on Linux,
  macOS and Windows. `otlite` installs pinned pip or git releases into per-tool virtualenvs on Linux and macOS and needs no
  container runtime. Both use the same typed inputs and `results/` layout.
  [docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md) covers the rename and maps `otlite`
  commands to `ot`.
- **Releases.** Tag `otlite-vX.Y.Z` (matching `otlite/pyproject.toml`) and `.github/workflows/release-otlite.yml`
  publishes to PyPI with trusted publishing; run it by hand with `repository: testpypi` for a dry run. The old PyPI
  name `otinstaller` is a shim in `otlite/otinstaller-shim/` that depends on `otlite`.
- **Catalog.** `otlite`'s tested catalog (`otlite/src/otlite/data/registry.yaml`) is converted into
  `osintverse-community` wrappers in `seed/community/` by `python scripts/pm-catalog-to-wrappers.py`: a pinned pip
  release with a pure-Python wheel on PyPI becomes a pipx package pinned by the wheel's SHA-256; git installs, extra
  packages, Playwright browsers and releases without a wheel become Docker wrappers built at the same pinned
  version. Typed inputs (`u:`, `e:`, `d:`, `url:`, `p:`) become manifest inputs, and the flags they map to become
  the command template. Existing seed folders are never overwritten. Tools that need a login or a terminal, take no
  typed input, or whose license doesn't allow a wrapper are listed and skipped; see [seed/README.md](seed/README.md).
- **Install paths.** apt (Debian/Kali) and pip/pipx installs of `otlite` stay as they are. Through the
  registry, the same tools install with `ot` as Docker images or sandboxed pipx wheels; the bare per-tool
  virtualenvs and unpinned git checkouts don't carry over.

Tests (Linux only, so on Windows run them in a container):

```bash
cd otlite
pip install -e ".[dev,pipeline]"
ruff check . && ruff format --check . && pytest
```

CI for it is `.github/workflows/otlite-ci.yml` (tests, a Kali `.deb`, a pipx install and the shim) and
`otlite-nightly.yml`, scoped to `otlite/**`.

## Licenses

The whole repository is under the Apache License 2.0 ([LICENSE](LICENSE)). `otlite/` keeps its own copy of the same
[LICENSE](otlite/LICENSE) and its [NOTICE](otlite/NOTICE), which must be kept with any redistribution or derived work
of it ("OTinstaller by OSINTverse"). Tools installed by either CLI, and the upstream projects the community wrappers in
`seed/` package, keep their own licenses.

## Notes on the plan

- Guide manifests use `topics:` (not `inputs:`) for what a guide helps investigate, so `inputs` always means tool inputs.
- `ot` drives the `docker` (or `podman`) CLI rather than the Engine API, which keeps it working with Docker Desktop, OrbStack, Colima and Podman.
- Sandboxed pipx tools are built into a local image (`ot-local/<namespace>-<name>:<version>`) from a verified wheel on `python:3.12-slim`.
- An extra `tool_secrets` table powers the "no API keys needed" search filter.
- Config is `config.json` in the data directory.
- Smoke tests run offline unless the manifest declares `network.egress: true`; then they keep the network, on a disposable
  runner with no secrets in the container. Fully offline smoke tests would fail most OSINT tools.
- Wheels are scanned for vulnerabilities in their Python packages only; the base image the scanner wraps them in is not the author's.
- Release templates sign on the default branch before creating the tag, so the expected signer accepts the repository's
  CI on a branch ref as well as on the release tag.
- Docker images are not run through GuardDog (it reads Python packages); Trivy and the smoke test cover them.
- The import wizard opens GitHub pull requests through the GitHub App, so the App also needs Contents and Workflows
  write access (GitHub requires the Workflows permission to add a file under `.github/workflows/`). GitLab merge
  requests use the author's own token with the `api` scope, asked for only when they finish an import.
- A GitLab project that already has a `.gitlab-ci.yml` gets the release job as `.gitlab/otinstaller-release.yml`, with a
  note in the merge request to include it; an existing pipeline is never rewritten.
- The mirror is a small OCI registry of our own on R2 (`api/src/mirror/registry.ts`) rather than a fork of Cloudflare's
  serverless-registry: it only needs pulls, the scanner's pushes (including chunked uploads, for layers over the Workers
  request limit) and deletes for takedowns. It has no referrers API, so signatures use the tag schema: the scanner copies
  those tags with crane, and `cosign verify` reads them. Each repository keeps its own blobs, so a takedown never touches another package.
- Git bundles hold branches and tags only, not the hosts' own refs (`refs/pull/*`, `refs/merge-requests/*`), which
  cannot be pushed to the other host.
- A registry-held manifest is published with the version from each new tag, and the image tagged with that version (or
  the PyPI wheel of that version) is looked up at publish time, so authors don't edit the manifest for every release.
