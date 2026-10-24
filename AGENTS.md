# AGENTS.md

A guide for coding agents (and people) working in this repository. It explains what the project is, how the pieces fit,
how to build and test each one, and the rules that are easy to break without noticing. [README.md](README.md) and
[docs/](docs) hold the user-facing and operator-facing detail; this file is about working on the code.

This file is the entry point. The deep reference lives in [docs/dev/](docs/dev/README.md):

| Page | What's in it |
| --- | --- |
| [architecture.md](docs/dev/architecture.md) | System diagram and step-by-step flows: publish, scan, guide checks, backup, install/run, sign-in, review, takedown, edge cache, self-update, agents and MCP |
| [api.md](docs/dev/api.md) | Every API route with auth and caching, middleware order, rate limits, queue messages, crons, the mirror's OCI routes, every error code |
| [database.md](docs/dev/database.md) | Every migration, the final D1 schema by table, status state machines, seed contents |
| [cli.md](docs/dev/cli.md) | Every `ot` command and flag, exit codes per command, env vars, files under the data dir, packages and tests |
| [ops-payloads.md](docs/dev/ops-payloads.md) | Scan, backup, drill and health payloads and callbacks; verdict rules; registry-ops workflows; token lifetimes |
| [config.md](docs/dev/config.md) | Bindings, vars and secrets per Worker, registry-ops and the CLI release; values that must match across them |
| [local-setup.md](docs/dev/local-setup.md) | From a clean Windows, macOS or Linux machine to running every part locally |
| [troubleshooting.md](docs/dev/troubleshooting.md) | Recipes: stuck jobs, scans, backups, edge-cache staleness, D1 limits, CSP, CORS, email, GitLab, `ot` failures |

These pages were written from the code in October 2026. When you change behaviour they describe, update them in the
same commit.

## What this is

**OTInstaller Registry** is a free, public registry of OSINT tools and guides, plus `ot`, the CLI that installs and runs
them. Publishers add an `otinstaller.yaml` manifest to a GitHub or GitLab repository and push a `vX.Y.Z` tag, let the
release workflow upload it as a trusted publisher (`ot publish --oidc` with the CI's OIDC ID token, no App needed), or
upload the release straight to the registry with `ot publish` (no repository needed). The registry validates the release, has it security-scanned (tools) or content-checked (guides), sends new publishers to human review,
publishes it, and backs it up. Users then run `ot install <ns>/<name>` and `ot run <ns>/<name> ...`, which pull a
digest-pinned, cosign-verified Docker image (or a hash-pinned PyPI wheel) and run it in a locked-down container. If the
original host later refuses the artifact, `ot` falls back to the registry's own mirror or wheel copy.

AI agents are first-class callers: `ot mcp` is a local MCP server that searches, installs and runs tools with the
person's consent and a local audit log, the API serves a read-only remote MCP server at `/mcp`, and every command and
error has a JSON form (see [Agents](#agents-ot-mcp-the-remote-mcp-server-and-the-plugin)).

The community keeps the catalog current (see [Community](#community-issues-requests-submissions-and-the-upstream-watcher)):
every package has public issues and "works for me" counts, `ot run` offers to report a failed run, anyone signed in can
request a tool or submit a community wrapper that a reviewer approves, contributors have profiles and an inbox, and a
nightly upstream watcher compares each wrapper with its upstream project. Release notes, the activity feed and Atom/JSON
feeds keep people up to date, and `/learn` is where to start.

The repository also holds `otlite/`, the no-Docker edition `otlite` (the Python package manager formerly called
`otinstaller`; see [otlite/](#otlite-the-no-docker-edition-otlite)).

The launch is **public**: the closed beta planned for week 12 never ran (nobody was invited), and the site is built
with `PUBLIC_BETA=0`. `ot feedback` and issues on `OTInstaller/feedback` stay as the feedback channels.
[docs/launch-checklist.md](docs/launch-checklist.md) records what is deployed and what is left; as of 22 Oct 2026 the
latest `ot` is v0.13.1 on `OTInstaller/ot`, migrations up to 0014 are applied in production, and otlite is on PyPI.
Check the checklist for anything newer; don't restate production state here.

Production:

| Thing | Where |
| --- | --- |
| Website | `https://otinstaller.com` (`web/`, a Cloudflare Worker) |
| Registry API | `https://api.otinstaller.com/v1` (`api/`, Worker `otinstaller-registry-api`) |
| Image mirror | `https://mirror.otinstaller.com` (`api/src/mirror/`, Worker `otinstaller-mirror`, config `api/wrangler.mirror.jsonc`) |
| Remote MCP server | `https://api.otinstaller.com/mcp` (`api/src/mcp.ts`, same Worker as the API, read-only) |
| Install scripts | `get.otinstaller.com/ot` and `/ot.ps1` (the latest `ot` release's scripts), `get.otinstaller.com/otlite` (`otlite/scripts/install.sh` from `main`), `/ot/latest` (the latest `ot` version, for `ot` itself); all from `ops/get/` |
| Manifest schema | `https://otinstaller.com/schema/v1.json` (served from `spec/schema/v1.json`); also `/schema/envelope-v1.json`, `run-all-v1.json`, `error-v1.json` |
| API reference | `https://api.otinstaller.com/v1/openapi.json` (served from `spec/openapi/v1.json`) |
| Scanner, backups, drills, health checks | GitHub Actions in the private repo `OTInstaller/registry-ops` (copied from `ops/`) |
| `ot` releases | the public repo `OTInstaller/ot` (built from `cli/` by GoReleaser, with `.mcpb` bundles and `server.json`) |
| `otlite` releases | PyPI projects `otlite` and `otinstaller` (the shim), from `release-otlite.yml`; GitHub releases `otlite-vX.Y.Z` on this repo |
| Agent plugin | the public repo `OTInstaller/agent-plugin` (copied from `integrations/agent-plugin/`) |
| MCP Registry | `com.otinstaller/ot` (each `ot` release) and `com.otinstaller/registry` (the remote server) |
| Feedback and bug reports | `OTInstaller/feedback` issues |

The first-party namespace is `osintverse-community` (a GitHub organisation). The launch seed in `seed/` publishes there.

## Repository layout

```
spec/        Manifest JSON Schema, valid/invalid fixtures, release workflow templates, the envelope, run-all and
             error schemas, types.json, pivots.json and openapi/v1.json (the source of truth)
cli/         The `ot` CLI (Go 1.25+, cobra); cmd/ot is the binary, cmd/mcpb packs the release's MCP bundles
api/         Registry API and image mirror (TypeScript, Hono on Cloudflare Workers, D1, Queues, R2)
web/         Website (Astro 7 SSR on Cloudflare, Preact islands, strict CSP)
ops/         scanner/ (scan.py, backup.py, health.py, tests, Dockerfile), workflows/ (scan.yml, health.yml) copied
             into registry-ops, get/ (worker.js, wrangler.jsonc: the get.otinstaller.com Worker)
otlite/      otlite, the no-Docker edition (Python; formerly otinstaller; has its own AGENTS.md)
seed/        Launch seed: 20 first-party tools, 119 community wrappers, 10 guides, outreach texts
examples/    dns-lookup (scripts/e2e.sh), cosign and tldextract (the local/test seed in api/scripts/seed-lib.mjs
             and scripts/e2e-real.sh)
scripts/     e2e.sh, e2e-real.sh, e2e-backups.sh, e2e-direct.sh, install/ (install.sh, install.ps1, make-test-release.sh),
             beta/labels.sh, pm-catalog-to-wrappers.py
integrations/ agent-plugin/ (the Claude Code and Cursor plugin, published as OTInstaller/agent-plugin) and
             mcp-registry/server.json (the remote server's MCP Registry entry)
docs/        publishing-setup.md (operator runbook), launch-checklist.md, migrating-from-otinstaller.md,
             typed-inputs-and-results.md and agent-friendly-plan.md (design notes), code-signing.md, seo.md,
             web-redesign-plan.md, launch/ (posts, agent listings, rota), beta/ (unused beta drafts),
             dev/ (developer reference, see the table above)
.github/     workflows/ (see CI below) and ISSUE_TEMPLATE/ (bug with severity, idea, config.yml contact links);
             the live issue forms are in the public OTInstaller/feedback repo
.claude/     launch.json: dev-server definitions (`web` on 4321, `web-preview` on 4322)
LICENSE      Apache 2.0 for the whole repository; otlite/ keeps its own LICENSE and NOTICE
```

There is no root package manager or monorepo tool. Each of `cli/`, `api/`, `web/` and `otlite/` is built on its own, but
they **share files from `spec/`** (see [Spec copies](#spec-is-the-source-of-truth-keep-the-copies-in-sync)), and some
tests read `spec/`, `seed/` or `examples/`, so tests must run inside a full checkout. (`scripts/pm-catalog-to-wrappers.py`
reads `otlite/`; no test does.)

## Requirements

- Go 1.25+ (CLI)
- Node.js 22+ (API and site); dependencies are pinned in each `package-lock.json`, install with `npm install`
- Docker Desktop or Podman (running Docker tools, sandboxed pipx tools, the e2e scripts, the scanner image)
- Python 3.12 (scanner, seed tool unit tests, the converter); Python 3.10+ on Linux or macOS for `otlite/`
- `cosign`, `crane` and `git` for some e2e scripts and the `ot release` tests

The main development machine is Windows. Use forward slashes in scripts, keep files LF (`.gitattributes` sets
`* text=auto eol=lf`), and don't assume `bash`-only tools exist outside Git Bash. `otlite/` runs on Linux and macOS, not Windows.

## Quick command reference

| Task | Command (run from the folder shown) |
| --- | --- |
| CLI tests | `cd cli && go test ./...` |
| CLI vet/format | `cd cli && go vet ./... && gofmt -l .` |
| Build `ot` | `cd cli && go build -o ../bin/ot ./cmd/ot` (`bin/` is gitignored) |
| Regenerate CLI spec copies | `cd cli && go generate ./...` |
| API tests | `cd api && npm test` (Vitest in workerd with a migrated, seeded D1) |
| API typecheck | `cd api && npm run typecheck` |
| API local DB | `cd api && npm run db:migrate && npm run db:seed` |
| API dev server | `cd api && npm run dev` → `http://127.0.0.1:8787/v1/tools` |
| Mirror dev server | `cd api && npx wrangler dev -c wrangler.mirror.jsonc` |
| Regenerate API template copy | `cd api && npm run sync:templates` |
| Site dev server | `cd web && npm run dev` (port 4321; CSP **not** enforced) |
| Site production preview | `cd web && npm run build && npm run preview -- --port 4322` (CSP enforced; without `--port` Astro uses 4321) |
| Site typecheck / tests / contrast | `cd web && npm run check` / `npm test` / `npm run contrast` |
| Social image | `cd web && npm run og` (re-renders `public/og.png`) |
| Scanner tests | `python -m unittest discover ops/scanner` |
| Seed tool tests | `python -m unittest` inside a `seed/first-party/<tool>/` folder |
| otlite/ checks | `cd otlite && pip install -e ".[dev,pipeline]" && ruff check . && ruff format --check . && pytest` |
| End-to-end (Docker) | `bash scripts/e2e.sh` |
| End-to-end, real artifacts | `bash scripts/e2e-real.sh` (needs Docker, cosign and the local API running) |
| End-to-end, backups | `bash scripts/e2e-backups.sh` (Docker, cosign, crane, git, Go, Node, Python; ports 8787–8789, 5001) |
| End-to-end, direct publishing | `bash scripts/e2e-direct.sh` (Docker, Go, Node, Python, network; ports 8787–8789) |
| Test install scripts locally | `bash scripts/install/make-test-release.sh` (a release signed with a throwaway key) |

There is no linter or formatter config for `api/` or `web/`; match the surrounding style. CI does **not** run the Go,
API or site tests (see [CI](#ci-githubworkflows)), so run them yourself before you call a change done.

To point `ot` at a local API: `OT_API_URL=http://127.0.0.1:8787/v1`. To point the site at another API, set
`PUBLIC_API_URL` (copy `web/.env.example` to `web/.env.development`). Setting up a machine from scratch is in
[docs/dev/local-setup.md](docs/dev/local-setup.md).

---

## Architecture at a glance

Four Cloudflare Workers, one D1 database, three R2 buckets, one queue, and GitHub Actions in a private repo doing the
heavy work (pulling, scanning and copying images). Step-by-step flows with file and function names are in
[docs/dev/architecture.md](docs/dev/architecture.md).

```
  publisher                      user                                   staff
  git tag vX.Y.Z                 ot install / ot run / browser          review, takedowns
      |                              |              |                       |
      v                              v              v                       v
 GitHub / GitLab --webhook--> +---------------------------+ <--- otinstaller.com (web/, Astro SSR Worker)
  (OAuth, commit      |       | api.otinstaller.com/v1    |      SSR reads public API; islands call it with cookie
   statuses, PR/MR)   |       | otinstaller-registry-api  |
      ^               |       |  edge cache -> Hono app   |---> Resend (email), Sentry (errors)
      |               +-poll--|  D1 otinstaller           |
      |                       |  R2 CONTENT, BACKUPS      |---> GHCR / PyPI (artifact checks)
      +-------- status -------|  queue otinstaller-publish|
                              +---------------------------+
                                 | repository_dispatch      ^ POST /internal/scans, /backups/:run,
                                 v (otinstaller-scan,       |      /drills/:id, /health
                     OTInstaller/registry-ops Actions ------+
                     scan.py, backup.py, health.py  --crane push--> mirror.otinstaller.com (otinstaller-mirror,
                                                                    OCI registry on R2 MIRROR)
  ot (cli/) ---- pulls image by digest from GHCR (or the mirror), wheel by hash from PyPI (or BACKUPS via the API)
  MCP client --stdio--> ot mcp (same install/run path, plus consent and the audit log)
  MCP client --HTTP---> api.otinstaller.com/mcp (read-only, anonymous GETs of the public API through the edge cache)
  get.otinstaller.com (ops/get) ---- proxies install.sh / install.ps1 from the latest OTInstaller/ot release, and
                                     otlite/scripts/install.sh from main
```

| Flow | In one line |
| --- | --- |
| Publish | tag → webhook/poll/import (or an `ot publish` upload → `POST /v1/publish`, files in R2) → `publish_jobs` row → queue → `processJob` validates, checks the artifact, renders pages → scan dispatch (tools) or content checks (guides) |
| Trusted publishing | CI ID token → `POST /v1/auth/oidc/token` (`verifyCiToken`, `matchPublisher`) → hour-long `ot_` token restricted to one namespace → `POST /v1/publish` → a bundle job naming the repository, treated like its tag |
| Scan | registry-ops runs `scan.py` → `POST /internal/scans` → `verdict` → published (active namespace) or `awaiting_review` → backup plan in the answer |
| Backup | plan with signed upload URLs → `backup.py` copies image/wheel/bundle → `POST /internal/backups/:run` → `completeRun` checks what arrived |
| Install | `GET /tools/:ns/:name/:version/manifest` → pull by digest + `cosign verify` (or wheel by hash) → mirror or wheel copy only when the original host refuses |
| Run | `ContainerArgs` builds a locked-down `docker run` → output parsed into the envelope → saved under `results/` |
| Sign-in | site: OAuth → `ot_session` cookie; CLI: device flow → scoped `ot_` API token in the keychain |
| Agent run | MCP `run_tool` → `agent.Session.DecideRun` (policy, consent class) → ask the person (elicitation or a consent token) → the same install and run → audit log line |

---

## The manifest (`spec/schema/v1.json`)

JSON Schema draft 2020-12. Everything else validates against this file, so start here when a change touches what a
package can declare.

**Shared keys.** Required: `schema` (const `1`), `name`, `namespace` (slugs `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`),
`version` (semver without `v` or build metadata), `summary` (10–140 chars), `license` (not `NOASSERTION`),
`categories` (1–3 of: email, username, phone, domain-dns, ip-network, social-media, people, company, images-geo, crypto,
breach-data, web-archive, documents-metadata, utilities). Optional: `kind` (`tool` default, or `guide`), `homepage`,
`tags` (≤10).

**Tools** also require `readme`, `inputs`, `outputs`, `runtime`, `ethics`:

- `inputs[]`: `{name (^[a-z][a-z0-9_]{0,31}$), type, required, default?, description?, values?, example?}`. Types:
  email, username, phone, domain, ip, url, name, image, crypto_address, hash, company, string, integer, boolean, enum
  (`enum` needs `values`).
- `outputs[]`: `{type, description?, attrs?: [{name, type?, description?}]}`, type from: account, email, username, phone,
  domain, subdomain, ip, url, person, organization, location, breach, certificate, dns_record, image, document,
  crypto_address, transaction, other.
- `runtime`: `kind` (`docker` | `pipx`), `command` (an **array**, never a shell string, with `{input_name}` placeholders),
  `output_format` (json | jsonl | csv | text), `timeout_seconds` (default 300), `typical_seconds?`.
  - docker: `image` pinned by digest (`...@sha256:<64 hex>`), `platforms` must include `linux/amd64`.
  - pipx: `package`, `package_version`, `entrypoint`, `wheel_sha256`; optional `index: pypi`, `python`.
- `secrets[]`: `{name (^[A-Z][A-Z0-9_]{2,63}$), required, description?, url?, pricing?}`.
- `network`: `{egress, domains}`. `ethics`: `{touches_target, auth_required, collects_personal_data}` (all required),
  plus optional `notifies_target` and `notes`, which agents' consent prompts show.
- `test`: `{input, expect_exit_code (default 0)}`, used by the scanner's smoke test and the nightly health check.
- `docs`: `{root: "docs/", nav: ["page.md", ...]}` for tool docs.

The optional fields marked `?` above that came after `ot` v0.12 (`example`, output `description`/`attrs`,
`typical_seconds`, `pricing`, `notifies_target`, `notes`) are rejected by v0.12's install-time validation, so the
manifest endpoint serves `compatManifest()` (`api/src/lib/manifest.ts`) without them and the full one as
`manifest_full`. A new optional field needs the same treatment.

**Guides** (`kind: guide`) require `title`, `level` (beginner | intermediate | advanced), `format` (guide | reference),
`content` (`{root, nav}` like `docs`), and must not have `runtime` or `inputs`. Optional `language`, `related_tools`
(`ns/name`, must already be published), and `topics` (input types; guides use `topics`, never `inputs`).

**Error codes are a contract.** The CLI (`cli/internal/manifest/validate.go`, `content.go`) and the API
(`api/src/lib/manifest.ts`, `api/src/content.ts`) report the same `manifest_*` / `content_*` codes for the same problem, and
every code is documented at `https://otinstaller.com/docs/errors#<code>` (`web/src/pages/docs/errors.md`). Adding or
changing a code means changing both validators, the error docs, and usually a fixture. Problems are sorted most specific
code first, then deepest path, so "first problem" is stable.

**Fixtures.** `spec/fixtures/valid/` (docker-tool, pipx-tool, guide, plus the README and docs pages they reference) must
validate with no problems. Each file in `spec/fixtures/invalid/` starts with `# expect: <code>`; the first problem must
have that code. Both the Go tests and `api/test/week4.test.ts` run every fixture, and the Go test requires at least 20
invalid ones. Digests and hashes in fixtures are fake. Separately, `cli/internal/manifest/seed_test.go` validates every
`seed/*/*/otinstaller.yaml` (with its files) and fails if fewer than 50 are found.

### Spec is the source of truth: keep the copies in sync

| Source | Copy | Regenerate | Drift test |
| --- | --- | --- | --- |
| `spec/schema/v1.json` | `cli/internal/manifest/schema/v1.json` (embedded) | `cd cli && go generate ./...` | `TestEmbeddedSchemaMatchesSpec` |
| `spec/templates/*.yml` | `cli/internal/scaffold/templates/*.yml` (embedded) | `cd cli && go generate ./...` | `TestTemplatesMatchSpec` |
| `spec/templates/*.yml` | `api/src/release-templates.ts` (generated, "Do not edit") | `cd api && npm run sync:templates` | `week7.test.ts` |
| `spec/templates/github-docker.yml` | `seed/*/*/.github/workflows/otinstaller-release.yml` | copy by hand | — |
| `spec/schema/v1.json` | imported directly by `api/src` and `web/src/pages/schema/v1.json.ts` | nothing to do | — |
| `spec/schema/{envelope,run-all,error}-v1.json`, `spec/pivots.json`, `spec/types.json` | `cli/internal/specfiles/files/` (embedded; MCP resources, `list_types`, `suggest_pivots`, `ot pivot`) | `cd cli && go generate ./...` | `TestCopiesMatchSpec`; `TestPivotsCoverEveryEntityType` and `TestTypesDescribeEverySchemaValue` check them against the schema |
| `spec/pivots.json`, `spec/types.json`, `spec/openapi/v1.json` | imported directly by `api/src/index.ts` (`/pivots`, `/types`, `/openapi.json`) | nothing to do | `api.test.ts` checks every enum value has a description and that the OpenAPI document lists every public and owner route |
| `spec/schema/{envelope,run-all,error}-v1.json` | imported directly by `web/src/pages/schema/[name].json.ts` | nothing to do | — |
| `otlite/src/otlite/data/registry.yaml`, `seed/candidates.md` | `api/src/known-repos.ts` (generated: what otlite installs and why the seed survey dropped a repository, for tool requests) | `cd api && npm run sync:known-repos` | `requests.test.ts` |

Never edit a generated copy by hand. Edit `spec/`, then regenerate. `TestWorkflowsAreValidYAML` (`scaffold_test.go`)
also checks every generated workflow parses as YAML with string script lines (write lines containing `: ` as `|-` blocks).

### Release workflow templates (`spec/templates/`)

Used by `ot init`, `ot import` and the import wizard.

- `github-docker.yml` / `github-pipx.yml`: run by hand with a `version` input. Docker builds amd64+arm64, pushes to GHCR,
  signs keylessly with cosign and writes the digest; pipx publishes to PyPI with trusted publishing and writes
  `package_version` and `wheel_sha256`. Both commit `Release X`, tag `vX` and push.
- `gitlab-docker.yml` / `gitlab-pipx.yml`: manual web pipelines. `VERSION` defaults to `version:` in `otinstaller.yaml`
  (a pipeline variable overrides it), the job fails if the tag exists, and pushes use the job token (`RELEASE_TOKEN` only
  if set). Docker registers QEMU (`tonistiigi/binfmt`) for arm64.
- `github-guide.yml` / `gitlab-guide.yml`: optional and lean (bump version, tag, atomic push). Guides are normally
  released with `ot release` instead.

---

## CLI (`cli/`)

Module `github.com/otinstaller/otinstaller/cli`. Entry point `cli/cmd/ot/main.go` → `cli.Main` in
`cli/internal/cli/root.go`, which runs the cobra root under a Ctrl-C-cancellable context, prints `error: <msg>` on
stderr and returns `ExitCodeFor(err)`. `cli/README.md` ships in the release archives.

### Packages (`cli/internal/`)

| Package | Responsibility |
| --- | --- |
| `cli` | Every command. `root.go` has the `App` struct (`Out`, `Err`, `In`, `Config`, `API`, `Runner`, `OpenURL`, `CheckRemovals`, `CheckUpdates`, `Updater`, `SelfPath`, `JSON`, `AgentMode`), exit codes, `ExitError`/`exitErr` (with `Reason`, the JSON error code) and command registration; `machine.go` has JSON errors and the no-prompt rule; `mcp_*.go` the MCP server |
| `agent` | What an agent (or any run without a terminal) may do: consent classes (`Classify`: passive, networked, target, personal), the policy file, session approvals and limits, signed single-use consent tokens, the audit log. Shared by `ot mcp` and unattended `ot run` |
| `specfiles` | Embedded copies of `spec/`'s envelope, run-all and error schemas, `pivots.json` and `types.json` (`go generate`) |
| `api` | Registry HTTP client. Decodes `{"error":{...}}` into `*api.Error` (`Status`, `Code`, `Message`, `Hint`, `Docs`, `Problems`, `RequestID`) |
| `manifest` | Typed `Manifest`, `Parse`/`LoadFile`, `Validate(doc, m, Options{Tag, Dir})`, content rules, embedded schema |
| `runner` | Install and run: engine detection (docker, then podman), `Install` (with backup fallbacks), `Run`, `ContainerArgs`, input resolution, typed inputs, command building, target type detection (`detect.go` + embedded IANA `tlds.txt`) |
| `playbook` | Named tool sets: bundled `domain-recon`, `username-investigation`, `email-investigation`, `phone-investigation` and `ip-investigation` (none needs a key), plus `<ot home>/playbooks` and `./playbooks` (later wins). `inputs` says which input types a playbook is for; `Starter(type)` picks the bundled one to offer when nothing installed takes a type |
| `envelope` | The normalized result envelope (`Version = 1`) and `ParseOutput` / `Write` (json, raw, csv, table) |
| `results` | Saving each run's raw output plus `.meta.json` (and lazy `.stderr.txt`); `saved.go` reads them back for `extract` and `diff` |
| `keys` | OS keychain (service `osintverse-ot`); an env var of the same name wins; names indexed in `keys.json` |
| `state` | Data dir (`OT_HOME` → `%APPDATA%\ot` → `~/.ot`), `state.json` (atomic write, 0600, records `from_backup`), read-only `config.json` |
| `scaffold` | Files written by `ot init` (manifest, Dockerfile, starter tool, READMEs, guide pages) and embedded templates; uses `<<`/`>>` template delimiters |
| `selfupdate` | `ot self-update`: release lookup (`get.otinstaller.com/ot/latest`, else the GitHub API), Ed25519-signed `checksums.txt`, archive SHA-256, atomic replace |
| `oci` | `ot publish --image`: reads an OCI layout or docker-archive tar and pushes it to the mirror in 50 MiB chunks (the Worker's 100 MB request limit), standard library only |

### Commands

Packages: `search`, `info`, `changelog`, `install`, `list`, `uninstall`, `outdated`, `update`. Running: `run`, `auto`, `playbook`,
`runs`, `extract`, `diff`, `pivot`, `keys set|setup|list|rm`, `doctor`. Agents: `mcp` (`mcp install|audit|policy [reset]|tools`).
Guides: `guide search|read|open|get|tools`, `docs`. Publishing: `init`, `validate`, `import`, `publish`,
`namespace create`, `sync`, `release`,
`login` (`--gitlab`, `--osintverse`, `--scope`, `--print-token`), `logout`, `whoami`, `token create|list|revoke`, `profile`.
Trust: `report` (`--works`/`--broken` too), `claim`, `transfer`, `yank`, `deprecate`. Community: `issues`, `request`.
Other: `feedback`, `self-update`. Cobra adds `help`,
`completion` and `--version`. The root's one persistent flag is `--json` (JSON output, and errors as one JSON line on
stderr; `OT_OUTPUT=json` turns it on for a session). Its `PersistentPreRun` refreshes `cache/removed.json` (daily) and
warns about installed versions that were removed; it and the root `PersistentPostRun` also run the daily update note
(`updatecheck.go`, below). Every flag of every command, with its exit codes, is in
[docs/dev/cli.md](docs/dev/cli.md).

Each is an `(a *App) xxxCmd() *cobra.Command` method. Files: `packages.go` (search/info/install/list/uninstall),
`update.go` (outdated/update), `run_cmd.go` + `run_all.go` (run), `auto.go`, `playbook.go`, `starter.go` (what to
install when nothing takes a target), `runs.go` (runs), `saved.go` (extract/diff), `pivot.go`, `run.go`
(keys/doctor), `keysetup.go` (keys setup), `guide.go` (guide/docs), `init_validate.go`,
`import.go`, `publish.go`, `namespace.go`, `sync.go`, `release.go`, `login.go`, `token.go`, `trust.go`
(report/claim/transfer/yank/deprecate), `issues.go` (issues, and `report --works|--broken`), `request.go` (request),
`changelog.go` (changelog, and `info`'s "What's new"), `report_prompt.go` (the failure prompt), `feedback.go`,
`selfupdate.go`, `mcp_cmd.go` (mcp and its subcommands), `consent.go` (unattended runs).

- `ot run` disables cobra flag parsing and parses its own args (`run_cmd.go`): ot flags (`-f/--format`, `--json`, `-o`,
  `--out-dir`, `--native`, `-y`, `--results-dir`, `--case`, `--no-save`, `--max-raw`, `--all`, `--parallel`,
  `--dry-run` with `--all`, `--live` accepted as a no-op), any other `--x v` is a tool input, and positionals after the
  package like `u:johndoe` are typed inputs (`u:` username, `d:` domain, `e:` email, `p:` phone, `ip:` ip, `url:` url).
- The envelope carries `run_id`, `ot_version` and `client` (`cli`, `ci` when `CI` is set, `mcp`). When a text or CSV
  tool reports no entities, `runner/textentities.go` lists the emails, URLs, IPs and domains its output mentions (up
  to 200, `confidence: low`, the run's own inputs left out), so pivots and summaries have something to chain from.
- Nothing prompts without a terminal (`machine.go`): piped stdin, `OT_NONINTERACTIVE=1`, CI and `ot mcp` get an
  `input_required` error naming the flag to pass. Unattended `run`, `--all`, `playbook` and `auto` (`consent.go`) also
  need `--yes` for any tool that isn't passive (exit 2, `consent_required`; `OT_CONSENT=off` turns the check off) and
  write each run to the audit log.
- `ot pivot <run-id | file>` suggests next runs from a saved run's entities through `spec/pivots.json`
  (`--registry` adds tools not installed). `ot keys setup [tool...]` walks a person through the keys their tools
  declare, with cost and sign-up link; it refuses without a terminal (`needs_terminal`), so only a person can store a
  key. `ot token create <name>` mints a scoped registry token (`--scope`, `--expires` days, default 90).
- `runAll` (`run_all.go`) is shared by `run --all`, `playbook` and `auto`: runs `--parallel` at a time, skips tools that
  can't run unattended, prints `[n/N]` progress on stderr and a summary table or JSON.
- `ot auto <target>` guesses the type (url, ip, email, phone, domain by IANA TLD, else username; `--type` overrides) and
  runs every installed tool that takes it. `ot playbook <name> <inputs>` runs a playbook (`--list` with a TAKES column,
  `--dry-run`; missing tools are offered at a terminal, `-y` installs them without asking); runs are saved under case
  `playbook-<name>`.
- When no installed tool takes the typed inputs (`noToolsError`, `starter.go`), as on a fresh machine, `run --all` and
  `auto` offer the tools of the bundled starter playbook for that type at a terminal (`playbook.Starter`: bundled
  playbooks only), checked against the registry, and install them on a yes. Without a terminal they exit 2
  `not_installed` with an `ot playbook <starter> <type>:<value> --yes` hint. `ExitError.Hint` is the JSON error's
  `hint`, and a second line in text. Don't add flags to `auto` or `run --all`: their unknown `--x` are tool inputs.
- `ot install a b c` (`installMany` in `packages.go`, shared with `guide tools` and `playbook -y`) parses every
  reference first, installs one after another, goes on after a failure except a missing container engine (exit 5),
  and prints `Try it:` and the keys still needed (`missingKeys` in `run.go`).
- `ot runs [run-id]` lists saved runs newest first from `resultDirs()` (`listSavedRuns`, shared with MCP's
  `list_runs`), or shows one and points at `ot pivot`. `ot extract` and `ot diff` read saved results (indicators; the
  two latest runs compared).
- `ot outdated` / `ot update` compare installed packages with the registry (`GET /tools/:ns/:name` and `/versions`,
  four at a time); rows carry lifecycle `flags` (`deprecated`, `possibly_broken`, `yanked`, `source_unavailable`,
  `moved`, `held`) and `replacement`, each with a `warning:` line (`held` gets a `note:`). `update` installs newer
  versions and moves a renamed package to its new name (`forgetOldName`), and exits 1 when an update fails. `ot outdated`
  also notes a newer `ot` (looked up at most daily into `cache/ot-latest.json`; never for dev builds, `ot mcp`, CI or
  `OT_NO_UPDATE_CHECK=1`).
- Holds: installing an exact version (`ot install x@1.2.0`, or `ot run x@1.2.0` installing it) sets `held` in
  `state.json`; `ot update --all` skips held packages, and naming one (`ot update x`, `ot install x`) moves it and
  releases the hold. Under `AgentMode` an install keeps the hold as it was, and MCP `install_tool` refuses to change a
  held version (`version_held`). User docs: `web/src/pages/docs/updates.md`.
- The daily update note (`updatecheck.go`): at a terminal, at most once a day, never in CI, under `ot mcp`, with JSON
  output, for quiet commands (`help`, completion, `uninstall`, `outdated`, `update`, `self-update`, `mcp`) or with
  `OT_NO_UPDATE_CHECK=1`. The root `PersistentPreRun` starts `GET /v1/latest` (every package's latest version, the same
  for everyone, into `cache/latest.json`) and the newer-`ot` lookup; the `PersistentPostRun` prints, after the command's
  output, how many installed packages have newer versions (held ones counted apart) and a newer `ot`. Tests turn it on
  with `App.CheckUpdates`. MCP `list_installed` reads the same list.
- After a single `ot run` that timed out, or exited non-zero with no entities, `report_prompt.go` asks at a terminal
  whether to report it as broken; a yes sends `POST /tools/:ns/:name/run-reports` with the version, exit code, OS,
  engine and ot version only. Never under `ot mcp`, in CI, without a terminal, with `--json`/`-f json`, for local
  manifests or with telemetry off; at most once a week per tool and version (`cache/report-prompts.json`). The run's
  exit code doesn't change.
- `ot issues <tool>` lists a package's issues; `ot request <repo-url> [--note] [--vote]` asks for a tool to be packaged
  (or votes for the existing request); `ot changelog <tool>` prints release notes newer than the installed version
  (through `stripControl`), and `ot info` shows the latest version's "What's new". `ot import --community` finishes
  as a reviewed submission (`--dockerfile`, `--request`); `--wrapper` keeps the admins' pull-request flow.
- `ot feedback [message]` posts to `/v1/feedback` (`--kind bug|idea|question|other`, `--email`, `--about`); with no
  message it reads piped stdin, or opens `<site>/feedback`.
- `ot release <version> [path]` (`release.go`) releases **guides only**: checks a clean tree and an unused tag, rewrites
  `version:`, validates, commits `Release X` if changed, creates an annotated tag and runs `git push --atomic`.
  Tools are released by their release workflow, which builds and signs the artifact.
- `ot publish [path]` (`publish.go`) releases without a tag. It validates, uploads the manifest, README, pages and
  images (`manifest.BundleFiles`) to `POST /v1/publish`, then polls `GET /v1/me/publish-jobs/:id` until validation
  ends (`--wait`: the outcome). `--dry-run` lists the files.
  - `--image`, `--image-archive` or `--build` first push a Docker image to the mirror (`cli/internal/oci`) and pin its
    digest in `otinstaller.yaml`.
  - `--sign` runs `cosign sign` with the mirror credential in a temporary `DOCKER_CONFIG`, never in argv.
  - `--oidc` (`oidc.go`; also used when no token is set and the CI offers an ID token) gets the job's ID token
    (GitHub's `ACTIONS_ID_TOKEN_REQUEST_URL` with `audience=otinstaller`, or GitLab's `OTINSTALLER_ID_TOKEN`), trades it
    at `POST /v1/auth/oidc/token` and uses the minted token for the upload, any image push and following the job.
  - `ot namespace create <name>` (`namespace.go`) makes a registry namespace to publish into; `ot namespace trust`,
    `trusted` and `untrust` manage its trusted publishers.
- Commands that need a sign-in (`whoami`, `import`, `publish`, `namespace create`, `sync`, `claim`, `transfer`, `token`)
  fail with exit 2 when there is no token.
- [docs/typed-inputs-and-results.md](docs/typed-inputs-and-results.md) is the design note for typed inputs, saved
  results, `--all`, playbooks, auto, extract/diff and outdated/update; [docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md)
  maps `otinstaller` commands to `ot`. Keep both in step with behaviour changes.

### Exit codes (`root.go`)

`0` ok · `1` tool error (default) · `2` bad usage or invalid manifest · `3` missing key · `4` trust refusal · `5` runtime
missing · `124` timeout · `130` interrupted. Typed errors map to them: `runner.UsageError` → 2, `runner.TrustError` → 4,
`runner.RuntimeMissingError` → 5, `runner.TimeoutError` → 124, `*cli.ExitError` → its `Code` (a nil `Err` exits
silently). Wrap registry 4xx errors with `a.requestError(err)` so they exit 2 and print problem lists. These codes are
documented to users; don't repurpose them. Caveats: errors raised by cobra itself (wrong argument count, unknown
flag) exit 2 too, through `cobraUsage` (`machine.go`); a batch `ot install` (and `guide tools`, `playbook -y`) exits
with its failures' common code, or 1 when they differ; `search`, `info`, `login`, `outdated` and `update` don't wrap
registry 4xx errors, so those exit 1; `doctor` exits 5 when any check fails; `self-update` exits 4 on a failed
verification. With `--no-save`, Ctrl-C
during a single run exits 1, not 130. With `--json`, the error is `{"error": {code, message, hint?, exit_code, ...}}`
on stderr (`spec/schema/error-v1.json`, shared with the API); its `code` is the registry's own code, else
`ExitError.Reason`, else one that follows from the exit code.

### Security model when installing and running tools (don't weaken it)

- Docker images must be pinned by digest. If the registry returns a signer identity, `cosign verify` must pass
  (missing cosign only warns). Wheels are matched by `wheel_sha256` from PyPI and re-hashed after download.
- Backup fallbacks: when the original registry refuses the image (401/403/404, denied, manifest unknown...), `ot` pulls
  the same digest from `mirror_image` and verifies the same signature; when PyPI answers 403/404/410 or lacks the wheel,
  it downloads `wheel_url` and checks the same SHA-256. Network errors never trigger a fallback. Tests are in
  `runner/backup_test.go`.
- Under `ot mcp` (`AgentMode`) the rules are stricter: a Docker image needs a recorded signer and cosign present
  (`RequireSignature`); local manifests, yanked versions, versions that failed their scan and possibly broken tools
  are refused (`trust_refused`, exit 4); nothing prompts or opens a browser.
- Containers run with `--rm --read-only --tmpfs /tmp:rw,size=256m --cap-drop ALL --security-opt no-new-privileges
  --pids-limit 256 --memory 1g --cpus 2 --user 65534:65534 -e HOME=/tmp`, plus `-v <out dir>:/out:rw` when there is
  an output folder and `--entrypoint` from the manifest's `command` (`ContainerArgs` in `runner/runner.go`), and
  `--network none` unless the manifest says `network.egress: true` (no `network` block, or no `egress` in it, means
  offline, as in the scanner's smoke test).
- Secrets are passed as `-e NAME` with the value only in the child process environment, so they never appear in argv,
  in `.meta.json` or in logs. Containers get only `HOME` and the declared secrets; `--native` pipx tools inherit ot's
  whole environment.
- Sandboxed pipx tools are built into `ot-local/<ns>-<name>:<version>` on `python:3.12-slim` with `WORKDIR /tmp` (the only
  writable folder); `--native` uses ot's own `PIPX_HOME`/`PIPX_BIN_DIR`.
- Removed packages (`tool_removed`) are refused with exit 4; `cache/removed.json` drives warnings.

### Environment variables

`OT_HOME`, `OT_API_URL`, `OT_SITE_URL` (`guide open`, `report`, `feedback`), `OT_MIRROR_URL` (where `ot publish --image`
pushes; default `https://mirror.otinstaller.com`), `OT_NO_TELEMETRY` (any non-empty value
disables the install ping; the ping, like search, tool and manifest reads, goes through `api.Client.anon()` and never
carries the token), `OT_RESULTS_DIR` (legacy
`OTINSTALLER_RESULTS_DIR`; results default to `./results`, not the data dir), `OTINSTALLER_TOKEN` (overrides the
keychain token; like every key, an env var of the same name wins), `OTINSTALLER_ID_TOKEN` (a GitLab CI job's ID token
for `ot publish --oidc`; GitHub's comes from `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN`), `OT_OUTPUT=json` (as `--json`),
`OT_NONINTERACTIVE=1` (never prompt), `OT_CONSENT=off` (no `--yes` needed unattended; still audited), `OT_MAX_RAW`
(leave `raw` out of large envelopes), `OT_NO_UPDATE_CHECK=1` (no daily update note, and `ot outdated` doesn't look up the latest `ot`), `CI`
(the envelope's `client` becomes `ci`, and there is no daily note or newer-`ot` check). `config.json` (`api_url`,
`site_url`, `telemetry`, `format`) is read, never written. Install scripts:
`OT_VERSION`, `OT_RELEASE_REPO`, `OT_INSTALL_DIR`, `OT_DOWNLOAD_BASE` (serve a release from another URL; checks still
apply), `OT_NO_MODIFY_PATH=1` (Windows). Build-time only: `OT_RELEASE_PUBLIC_KEY`, `OT_RELEASE_KEY_FILE`,
`RELEASE_OWNER`, `RELEASE_NAME`, `TAP_GITHUB_TOKEN`.

### CLI conventions

- Data goes to `a.Out` (stdout); progress, `note:` and `warning:` lines go to `a.Err`. Never write to `os.Stdout`
  directly: tests capture the `App` writers. `ot run` keeps stdout for the envelope and prints `Saved <path>` on stderr.
- Tables: `text/tabwriter` with `(0, 4, 2, ' ', 0)` and uppercase headers. `--json` output: 2-space indent via
  `writeJSON` / `newJSONEncoder`.
- Messages are plain sentences that suggest the next command in backticks (``run `ot login` ``).
- Every package has a `// Package x ...` comment; exported identifiers have doc comments; comments explain why.
- No logging library. Standard `testing` only (no assertion library), `t.TempDir`, `t.Setenv`, table-driven `t.Run`.
- Tests use `newTestApp` and `fakeExec` (`cli_test.go`), `httptest` fake registries (`guide_test.go`, `import_test.go`,
  `trust_test.go`, `login_test.go`, `sync_test.go`, ...), `keyring.MockInit()` for the keychain, and override
  `runner.PyPIBase`, `pollSleep`, `cli.Version`. `release_test.go` uses real `git` and skips without it. There are no
  golden files.

### Releasing `ot`

Push a `vX.Y.Z` tag on this repo: `.github/workflows/release-cli.yml` writes the install scripts with the public key
filled in to `dist/install/` (the checkout must stay clean), then runs GoReleaser (`cli/.goreleaser.yaml`) for
windows/darwin/linux × amd64/arm64. Archives contain exactly `LICENSE`, `README.md` and `ot`; `checksums.txt` is signed
with the Ed25519 release key and with cosign; deb/rpm are built; the Homebrew tap and Scoop bucket update only with
`TAP_GITHUB_TOKEN` (not offered yet). It publishes to `OTInstaller/ot` (the default when the variables are
unset). Archive names `ot_<ver>_<os>_<arch>.tar.gz|.zip` are relied on by `self-update`, the install scripts and the
`ops/get` Worker. The last step runs `cli/cmd/mcpb` on GoReleaser's binaries and uploads six MCP Bundles
(`ot_<ver>_<os>_<arch>.mcpb`, one-click installs for Claude Desktop, not yet `mcpb sign`ed) and the MCP Registry
`server.json` to the release. `cli-install.yml` tests this whole path on PRs, including `mcpb validate`. Listing a
release in the MCP Registry is a manual step afterwards (see [Agents](#agents-ot-mcp-the-remote-mcp-server-and-the-plugin)).
Only tag a release when asked.

---

## API (`api/`)

Two Workers from one folder:

- `otinstaller-registry-api` (`wrangler.jsonc`, `main: src/index.ts`), a Hono app with base path `/v1`. Bindings: D1 `DB`
  (`otinstaller`), R2 `CONTENT` (`otinstaller-content`: rendered pages and images), R2 `BACKUPS` (`otinstaller-backups`:
  git bundles and wheels), R2 `MIRROR` (`otinstaller-mirror`, shared with the mirror), queue `PUBLISH_QUEUE`
  (`otinstaller-publish`), var `MIRROR_HOST`. Crons: `17 3 * * *` (nightly), `*/15 * * * *`, `41 4 * * 1` (weekly
  backups), `23 5 1 * *` (monthly restore drill).
- `otinstaller-mirror` (`wrangler.mirror.jsonc`, `main: src/mirror/index.ts`): an OCI distribution registry on R2 at
  `mirror.otinstaller.com`, with the API's D1 bound as `DB`.
  - Anonymous public pulls; deletes and `private/` pulls need `MIRROR_PUSH_TOKEN`.
  - Pushes need that credential, or a publisher's `ot_` token (publish scope) for `<namespace>/<name>` of a namespace
    they belong to (`ot publish --image`). That makes the mirror the image's primary home.
  - A publisher's image stays `pending/` (not public) until a published version uses it. Pushes are limited (2 GiB an
    image, 10 GiB a namespace a day, 30 tags an hour) and swept nightly when no version uses them.

There are no wrangler `env` blocks; the files are production config. Secrets are listed in the wrangler comments and
`src/env.ts`. For local runs copy `.dev.vars.example` to `.dev.vars` (never commit it). The example predates the backup
and beta work, so `R2_*`, `ISSUES_REPO`/`ISSUES_TOKEN` and `EDGE_CACHE` are only in `env.ts`.

### Source layout (`api/src/`)

| Path | Responsibility |
| --- | --- |
| `index.ts` | App setup, CORS (credentialed only when `Origin` equals `SITE_URL` exactly, so not `www.`), auth middleware, write rate limit (30/min per signed-in non-staff user on non-GET requests; registered after `authRoutes`, so auth, token and device routes aren't limited), public read routes, `onError`/`notFound`, default export `{ fetch, queue, scheduled }` (fetch wrapped in `edgeCached`). Exporting anything but the handlers from this file makes workerd refuse to start, and vitest won't catch it |
| `edge-cache.ts` | Edge cache for anonymous reads (see below), plus weak ETags and 304s on every successful JSON or text read |
| `mcp.ts` | The read-only remote MCP server at `/mcp` (outside `/v1`; see [Agents](#agents-ot-mcp-the-remote-mcp-server-and-the-plugin)) |
| `scopes.ts` | API token scopes: `requiredScope(method, path)`, `enforceScopes` (403 `insufficient_scope`, and an audit row for every write a token makes) |
| `env.ts` | `Env`, `PublishMessage`, `User`, `deps.fetch` (all outbound HTTP), `requireSecret` |
| `catalog.ts` | Shared public-read SQL (`VISIBLE`, `LISTED`, `summary()`, `findTool()` with aliases, `cached()`) |
| `ranking.ts` | Search score (bm25 + installs + stars + health + verified − broken − registry-held) |
| `publish.ts` | Queue consumer `handleBatch` and the release validation pipeline `processJob` |
| `scans.ts` | `dispatchOps` / `dispatchScan` to registry-ops, `verdict`, `applyScanResults`, `publishVersion`, commit statuses, scan timeouts |
| `backups.ts` | Backup plans, runs and items, signed upload/download URLs, weekly runs, backfill, takedown deletion and legal holds, restore links, restore drills |
| `guides.ts` / `content.ts` | Guide and docs rendering (marked + sanitizer), R2 storage, link checks, URL Scanner, PII heuristics |
| `sync.ts` | Keeping packages in sync with repos: 6-hourly poll, tag queuing, renames/archives/deletes |
| `imports.ts` | Import wizard: detection, draft manifests, finishing as PR/MR, registry-held manifests, community wrappers, bulk (≤50), the `REDISTRIBUTABLE` license list |
| `direct.ts` | Direct publishing: registry namespaces (`createNamespace`, reserved names, GitHub/GitLab names left to their owners, `purgeIdleNamespaces`), uploads (`acceptUpload`: checks before the body is read, files to R2 `uploads/<jobId>/`, CI uploads naming their repository), and `bundleHost`, the `RepoHost` `processJob` reads an upload through |
| `trusted.ts` | Trusted publishing: a namespace's trusted publishers (add, list, remove), `matchPublisher` (repository, pinned ids, workflow, environment, package, risky events), `exchangeIdToken` (the hour-long restricted CI token), `purgeCiTokens` |
| `trust.ts` / `transfers.ts` | Yank, deprecate, removal, reports, transparency, rate limits; claims and transfers |
| `notify.ts` | Resend email with idempotency keys (`notifications` table); skipped when `RESEND_API_KEY` is unset |
| `ops.ts` | Health targets/results, stuck-job alerts, daily digest, rate-limit purge, Sentry `reportError` |
| `changelog.ts` | Release notes: captured from the host's release or the version's `CHANGELOG.md` section at publish, cleaned and rendered |
| `activity.ts` | `GET /activity`: registry events from the audit log, and with `events=community` confirmed/fixed issues and accepted/published requests, worded from fields |
| `community.ts` | Issues, comments, confirmations, flags, moderation, roles (`triager`, `reviewer`; tool maintainers), screening (`screen`, `holdReason`), `renderPost`, failed-run reports, the status line, system issues (`fileSystemIssue`, `closeSystemIssue`) |
| `inbox.ts` | Inbox items written with each event, release notifications for a package's followers (`notifyFollowers`), email delivery (immediate every 15 minutes, daily digests), signed unsubscribe links |
| `requests.ts` | Tool requests: checks (`readUpstream`, `packagedFrom`, `knownRepo`), votes, triagers' decisions, `linkPublished` |
| `people.ts` | Contributor profiles and the nightly `contributor_stats` recount |
| `submissions.ts` | Community wrapper submissions: checks, `dockerfileChecks`, the community bot (`COMMUNITY_*`), the first-release review gate |
| `upstream-pin.ts` / `upstream.ts` / `bumps.ts` | Reading a wrapper's upstream pin from its Dockerfile; the nightly upstream watcher (`UPSTREAM_WATCH`); bump pull requests, "merge and release", following each release to released or failed (`settleBump`, `sweepBumps`) and releasing on its own in auto mode |
| `proposals.ts` | Change proposals: a wrapper's maintainers change its manifest, Dockerfile or README beyond the pin (`checkProposal`), the community bot opens the pull request, a reviewer who isn't the proposer approves it and the bot merges and releases it |
| `build-watch.ts` | The build watcher: first-party tools' requirements.txt pins against PyPI (issues, dependency update pull requests, auto releases under `UPSTREAM_WATCH`), and each community-namespace build's base image on Docker Hub (rebuilds under `REBUILD_WATCH`) |
| `first-week.ts` | A new version's first week: its works/broken counts (`firstWeekCounts`) for the status line, the versions list and the activity feed |
| `known-repos.ts` | **Generated** from otlite's catalog and `seed/candidates.md`; don't edit |
| `mirror/` | The mirror Worker: `index.ts` (entry) and `registry.ts` (OCI API, `imageExists`, `hideImage`, `deleteImage`) |
| `hosts/` | External services: `github.ts`, `gitlab.ts`, `osintverse.ts` (OIDC), `repo.ts` (`RepoHost` over both), `artifacts.ts` (OCI digest and PyPI wheel checks) |
| `lib/` | `errors.ts` (`apiError`), `crypto.ts` (hashing, AES-GCM, RS256 JWT, `ulid()`), `manifest.ts` (validator), `images.ts` (metadata stripping, SVG sanitizing), `presign.ts` (R2 SigV4 URLs), `reserved.ts` (namespace names the site's sections take, and the few more a registry namespace can't), `tokens.ts` (the `ot_` token lookup the API and the mirror share, and what a restricted CI token may do), `oidc.ts` (OIDC discovery and keys cached per issuer, EdDSA and RS256 checks, `verifyCiToken` for GitHub Actions and GitLab CI) |
| `routes/` | One `xxxRoutes(app)` registrar per area: auth, device, webhooks, review, sources, imports, guides, trust, transfers, backups, beta, ops, profiles, community, inbox, requests, people, submissions, upstream, direct, trusted, proposals |
| `release-templates.ts` | **Generated** from `spec/templates`; don't edit |

Routes only parse input, check permissions and shape responses; domain logic lives in the top-level modules. Route
registration order in `index.ts` matters (guides before `/tools/:ns/:name/:version`).

### Edge cache (`edge-cache.ts`)

Added after crawlers used up D1's daily read allowance and every read answered 500. Anonymous `GET`s (no `authorization`
or `cookie` header) go through `caches.default`, keyed by URL with sorted query params plus whether the origin is the
site (credentialed CORS) or not. Only 200s with `public` and a non-zero `max-age` and no `set-cookie` are stored, for as
long as their own `Cache-Control` says; there is no purge. On a hit the original `Cache-Control` is restored (from
`x-ot-cache-control`) and `x-edge-cache: hit` is set. Consequences:

- A public endpoint's `cached(c, seconds)` value is how stale production can be after a change. Per-user or
  just-changed data must not be `public`.
- Tests set `EDGE_CACHE: "off"` in `vitest.config.ts`; `api/test/edge-cache.test.ts` turns it back on.
- The site helps too: filter and sort links are `rel="nofollow"`, any page with a query string is `noindex`, and
  `robots.txt` disallows `/*?`. Keep that when adding filters.

### Main endpoints (all under `/v1`)

- Public: `GET /health`, `/openapi.json` (`spec/openapi/v1.json`), `/types` (enums, the pivot map and descriptions from
  `spec/types.json`), `/tools` (search: `q`, `input`, `output`, `category`, `runtime`, `kind`, `level`, `format`,
  `lang`, `sort`, `no_keys`, `passive_only`, `limit`, `cursor`; summaries carry ethics and egress), `/facets`,
  `/guides`, `/tools/:ns/:name[/versions|/:version[/manifest|/scans|/wheel/:file]]`,
  `/namespaces[/:ns[/activity]]` (publisher profiles), `/pivots`
  (follows `spec/pivots.json`), `/removed`, guide pages, tool docs, readmes, `/assets/:sha256.ext`; `POST /installs`
  (counted once per address, version and day through a salted hash in `rate_limits`; only per-version and
  per-client-kind daily counts are kept), `POST /feedback`. The manifest response includes
  `mirror_image` / `wheel_url` install fallbacks for public backups. `GET /tools/:ns/:name` carries `sample`: what the
  scanner's smoke test of the latest version produced (first five entities, or the start of stdout), which the tool
  page shows as its sample output.
- Auth: `/auth/:provider/login|callback` (github, gitlab, osintverse), `/auth/logout`, `/auth/device/start|token`,
  `POST /auth/oidc/token` (a CI run's ID token for a restricted token: trusted publishing),
  `/me`, `/me/tokens`, `/me/publish-jobs[/:id]`, `/me/repos`, `/me/transfers`, `/me/backups`,
  `/me/namespaces/:ns/profile[/preview|/sync|/hosts[/:provider]]` (an owner's profile settings),
  `/me/namespaces/:ns/trusted-publishers[/:id]` (an owner's trusted publishers).
- Publishing: `POST /webhooks/github` (HMAC), `POST /webhooks/gitlab` (per-source token), `/imports...`,
  `/sources/gitlab`, `/packages/:ns/:name/sync|sync-log|manifest|manifest/pr|source|backups|backups/restore`,
  `POST /namespaces` (a registry namespace) and `POST /publish` (an upload from `ot publish`).
- Owners: yank/unyank, deprecate, claim, transfer, git-backup opt-out, restore, switch source. Anyone: reports, feedback.
- Community (public reads cached, writes scope `feedback`, triage `manage`): `/tools/:ns/:name/issues[/:n[/comments|
  /status|/lock|/subscription|/viewer]]`, `/tools/:ns/:name/status`, `/tools/:ns/:name/confirmations`,
  `/tools/:ns/:name/run-reports`, `/tools/:ns/:name/problem-reports` (Report a problem without a sign-in; both refuse
  another website's `Origin` with `foreign_origin`), `/issues` (the board), `/comments/:id`, `/flags`, `/moderation/...`,
  `/admin/community/roles`; `/tools/:ns/:name/follow`; `/me/inbox`, `/me/email-prefs`, `/me/follows`, `/unsubscribe`; `/requests[/:n[/vote|/status|/viewer]]`;
  `/people/:handle`, `/me/community-profile`; `/submissions[/:n[/approve|/request-changes|/reject|/start|/withdraw|
  /viewer]]` (submitting is `POST /imports/:id/finish {mode: "submit"}`); `/upstream/summary`, `/admin/upstream...`,
  `/packages/:ns/:name/bump`, `/packages/:ns/:name/pulls/:n/release`; `/proposals`, `/packages/:ns/:name/files`,
  `/packages/:ns/:name/proposals[/:n[/review|/viewer]]`; `/activity` (`events=registry|community|all`).
- Staff (`/admin/...`): review queue, namespace approve/request-changes/reject/verify/suspend, version approve/reject,
  reports, removals, legal holds, audit log, transfers, bans, feedback triage, beta metrics, manual backups, restore
  drills, `POST /admin/email-test` (checks the Resend key).
- Internal: `POST /internal/scans` (scanner callback; on a pass it answers with a backup plan),
  `/internal/backups/objects/*` (signed PUT/GET when R2 credentials aren't set), `POST /internal/backups/:run`,
  `POST /internal/drills/:id`, `/internal/health[/targets]`. Scans, backup runs and drills each use their own
  single-use token (scan 1 h, run 3 h or 12 h weekly, drill 6 h); the health endpoints use the static shared
  `HEALTH_TOKEN`.
- The full route table (197 routes, with auth, scope and caching for each) is in [docs/dev/api.md](docs/dev/api.md).
  `spec/openapi/v1.json` describes the public and owner routes, each with its token scope as `x-scope`; a test in
  `api.test.ts` fails when a route and the document disagree, so add new routes to both.
- 429s carry `Retry-After`, `RateLimit-Policy` and `retry_after_s` (`rateLimited` in `lib/errors.ts`).

### Publish pipeline

1. A tag webhook (or the poller, or an import) creates a `publish_jobs` row and queues `{ jobId }`. So does an upload
   (`POST /v1/publish`, `direct.ts`): its files go to R2 `uploads/<jobId>/`, and the job has `provider = 'direct'`, a
   `namespace_id` and a `bundle_key`.
   - **Bundle jobs.** Code branches on `bundle_key` ("is this an upload"), never on `provider`.
   - **Direct packages.** They have no `sources` row and `tools.repo_url` is NULL: the namespace owns the name until a
     repository in it releases the package.
   - **Signers.** They are pinned on first use (`scans.ts:pinSigner`); see
     [docs/dev/architecture.md](docs/dev/architecture.md), flow a2.
   - **CI uploads** (trusted publishing, `trusted.ts`) are bundle jobs whose `provider`, `repo` and `repo_id` come from
     the run's ID token, with `trusted_publisher_id` and `ci_json`. They are treated like that repository's tag: it owns
     the name (`tools.repo_url`), links point at the tag, the scanner expects `expectedSigner`, and there is no source
     row or commit status. An upload of a release already received from the same repository answers 200
     `already_received`, and `onTag` skips a tag a CI run already uploaded.
2. `processJob` reads `otinstaller.yaml` at the tagged commit (or the registry-held manifest, or the upload), validates it, checks
   release rules (`manifest_tag_mismatch`, `manifest_version_exists`, `manifest_name_taken`, `namespace_not_allowed`, ...),
   checks the artifact exists (`hosts/artifacts.ts`), renders README/docs/guide pages to R2, and sets a pending
   `otinstaller/publish` commit status.
3. Tools: `dispatchScan` sends a `repository_dispatch` (`otinstaller-scan`) to `OPS_REPO` with everything under
   `client_payload.scan`. The scanner posts back to `/internal/scans`. `verdict` fails on signature mismatch/dropped,
   malware, secrets, or a failed smoke test; fixable critical/high vulns warn.
   Guides: `runContentChecks` checks every external link (and URL Scanner when configured) and runs PII heuristics.
4. Pass/warn: published right away if the namespace is `active`, otherwise `awaiting_review` until a reviewer approves the
   namespace. PII hits in a guide always go to review. A community submission's first release
   (`tools.needs_first_review`) waits for a staff or community reviewer who isn't its submitter, even in the active
   community namespace. Emails go out at each step. `publishVersion` also announces the version once, when it first
   becomes the latest (`versions.announced_at`): on open broken and outdated issues, whose followers are told, and to
   the package's other followers (`notifyFollowers`). It also makes a submission's submitter a maintainer, and marks
   requests for that repository published.
5. Backups: a passing scan's callback answer tells the scanner to back up right away; versions published another way
   (namespace approval, guides) queue `{ backupVersionId }`. See below.
6. Every 15 minutes: expire stale scans (1 h), poll due sources, alert on jobs stuck > 30 min, expire backup runs and
   drills, backfill up to 5 versions with no backup, email inbox items due now. `scheduled()` runs this block on
   **every** trigger, including the nightly, weekly and monthly ones. Nightly also: guide link rechecks (> 20% dead →
   needs update), the reviewer digest, rate-limit purge, backup purge, locking stale closed threads, daily inbox
   digests and the inbox purge, the `contributor_stats` recount, queuing every community wrapper's upstream check and every community-namespace build's dependency and base-image check,
   `installs_30d` recompute.

Queue messages (`PublishMessage` in `env.ts`): `{ jobId }`, `{ importId }`, `{ checkVersionId, attempt? }`,
`{ linkCheckToolId }`, `{ publishVersionId }`, `{ backupVersionId }`, `{ profileNamespaceId }`, `{ upstreamCheckToolId }`,
`{ buildCheckToolId }`, `{ mirrorSweepRepo }`;
anything else is treated as `{ jobId }`. Transient
failures retry with a delay of 30 × attempts seconds, 5 deliveries in all (the code acks before wrangler's own
`max_retries` kicks in); a `HostError` with `transient=false` fails immediately. On the last failure a job becomes
`error` (`internal_error`) and an import `detection_failed`; other messages are only logged.

### Backups (`backups.ts`, `routes/backups.ts`, `ops/scanner/backup.py`)

Three kinds: **image** (copied with its signature/attestation/SBOM tags by `crane` to the mirror at
`[private/]<ns>/<name>@<digest>`), **wheel** (R2 `wheels/<ns>/<name>/<sha256>.whl`), **git** (a mirror-clone bundle in R2
`git/<provider>/<project_id>/<date>-v<version>.bundle`, plus weekly bundles, last 4 kept). The API never does the copying:
it dispatches `otinstaller-backup` jobs to registry-ops with signed upload URLs and a single-use token, and
`completeRun` checks what arrived (size, SHA-256, `imageExists`).

- Only public repositories and published or yanked versions. Mirrors are public only for OSI-approved licenses
  (`osiApproved()`); others go under `private/`. Owners can opt out of git backups.
- An image a publisher pushed to the mirror itself (`backups.ts:hostedImage`) is never copied.
  - At publishing, `recordHostedImage` releases it (clears its `pending/` markers) and writes a `hosted = 1` image row.
    Takedowns, purges, legal holds and drills treat that row as a copy; install fallbacks never offer it.
  - Nightly, `queueMirrorSweeps` → `{mirrorSweepRepo}` → `sweepMirrorRepo` deletes what no version uses.
- Limits: bundles 500 MiB, images 2 GiB, wheels 1 GiB (over → `too_large` plus an email). Without the `R2_*`
  secrets, uploads go through the API instead of straight to R2 and are capped at about 100 MB by the Worker body
  limit.
- Takedowns hide mirrored images at once and delete backups after 14 days (`TAKEDOWN_GRACE`) unless a legal hold is
  set. Git opt-outs are deleted at the next nightly purge.
- Monthly restore drills (`otinstaller-drill`) restore a random bundle and pull a random mirrored image; failures email
  admins. Admins can run one now (`POST /admin/backups/drill`).
- `scripts/e2e-backups.sh` is the end-to-end check. The operator setup is section 11 of `docs/publishing-setup.md`.

### Data model (`api/migrations/`)

`0001_initial.sql` creates the core tables (users, accounts, sessions, api_tokens, namespaces, namespace_members,
installations, tools, versions, tool_io, tool_secrets, sources, sync_events, imports, publish_jobs, scans, health_checks,
pages, tool_guides, stars, install_counts, reports, transfers, aliases, audit_log) and the FTS5 table `tools_fts`. Later
migrations add publish intake (0002), scans/review and `notifications` (0003), sync (0004, 0006), imports (0005), guides and
`page_links` (0007, 0008), trust/takedowns/claims/health and `rate_limits` (0009), OSINTverse login plus `device_logins`
(0010), backups (`backup_runs`, `backups`, `restore_drills`, tool `git_backups`/`legal_hold`/`legal_hold_reason`, 0011),
`feedback` (0012), and scoped tokens (`api_tokens.scoped`) plus the `install_clients` daily counts by client kind
(0013), publisher profiles (`namespace_profiles`, `namespace_hosts`, 0014), release-note sources (0015), the community
(handles, `community_roles`, `issues`, `issue_comments`, `confirmations`, `run_signals`, `content_flags`,
`issue_subscriptions`, 0016; `problem_signals` from Report a problem, 0032), notifications (`email_prefs`, `inbox`, 0017; following packages' releases, `package_follows`,
`email_prefs.releases`, `versions.announced_at`, 0029; following publishers and input types, `follows`, 0030), tool requests (`tool_requests`,
`request_votes`, 0018), `contributor_stats` (0019), community submissions (`tools.needs_first_review`,
`tool_maintainers`, `wrapper_submissions`, 0020), the upstream watcher (`upstream_watch`, 0021), bump pull requests
(`bump_prs`, 0022; outcomes and `tools.auto_release`, 0028), direct publishing (`publish_jobs` `namespace_id`/`bundle_key`/`submitted_by`,
`namespaces.created_by`, 0023), images hosted on the mirror (`mirror_pushes`, `backups.hosted`, 0024), trusted
publishing (`trusted_publishers`, the CI token columns `api_tokens.namespace_id`/`package`/`trusted_publisher_id`/
`oidc_json`/`jti`, and `publish_jobs.trusted_publisher_id`/`ci_json`, 0025), request discussions
(`request_comments`, `request_subscriptions`, flags on requests, 0026) and change proposals (`change_proposals`,
0027), and the build watcher (`dependency_watch`, `base_images`, `base_watch`, `bump_prs.kind`, 0031). That is 63 tables plus `tools_fts`; every
table, column, CHECK value set and status transition is in
[docs/dev/database.md](docs/dev/database.md).

- IDs are ULIDs (`ulid()`), timestamps are Unix **milliseconds**, booleans are 0/1, JSON columns end in `_json`
  (older exceptions: `tools.categories`, `tools.tags`, `installations.repo_ids`, `sources.topics`,
  `sources.baseline_tags`; `api_tokens.scopes` is comma-separated). `publish_jobs.status` and `sync_events.status`
  have no CHECK constraint.
- Add schema changes as a new numbered migration (`00NN_description.sql`); never edit an applied one. Parallel branches
  can collide on a number: renumber yours before merging. Some migrations rebuild a table to change a CHECK constraint;
  follow that pattern if you need one.
- Apply locally with `npm run db:migrate`; remotely `npx wrangler d1 migrations apply otinstaller --remote` (only when
  asked: it changes production).

### Auth

`authenticate` (in `routes/auth.ts`) runs on every request and sets `c.var.user` or null: first `Authorization: Bearer
ot_...` (sha256 lookup in `api_tokens`), then the `ot_session` cookie (30 days, httpOnly, Secure, Lax). Only hashes are
stored. Provider tokens are AES-GCM encrypted with `TOKEN_ENC_KEY`. Accounts link only by signing in while signed in
with the session cookie (an API token on an OAuth callback links nothing), never by email. Use `requireUser` (401), `requireReviewer` / `requireAdmin` (403, in `routes/review.ts`) and
`requireMember` (`routes/sources.ts`). Staff are `users.is_reviewer` / `users.is_admin`.

API tokens are scoped (`scopes.ts`, migration 0013): `read`, `publish`, `manage`, `feedback`, and `staff`, which only a
signed-in reviewer or admin can mint from the website. `enforceScopes` runs right after `authenticate` and refuses a
token request outside its scopes with 403 `insufficient_scope`; the session cookie has every power its user has, and
tokens minted before 0013 (`scoped = 0`) keep theirs. A token can't mint one with more than it has. `ot login` tokens
get all four user scopes unless `--scope` says otherwise and don't expire; `/me/tokens` (`ot token create`) defaults
to 90 days. Creating, revoking and every write made with a token are audited. A new route needs the right scope in
`requiredScope` (GETs are `read`, `/admin` is `staff`, imports, sources, manifests and syncs are `publish`, reports and
feedback `feedback`, other writes `manage`).

CI tokens (trusted publishing, `trusted.ts`) are `api_tokens` rows with a `namespace_id`: minted by
`POST /auth/oidc/token` for one CI run's ID token (whose `jti` is unique, so it works once), they last an hour, act for
the owner who added the trusted publisher, and are restricted to that namespace (and `package`). `authenticate` treats
one as anonymous anywhere but `POST /publish` and `GET /me/publish-jobs/:id` (`restrictedRouteAllowed` in
`lib/tokens.ts`), the mirror lets it push only `<namespace>/<package>`, `/me/tokens` doesn't list it, and the nightly
cron deletes it two days after it expires.

### API conventions

- Errors: `apiError(status, code, message, hint?)` throws; the body is
  `{ error: { code, message, hint, docs: "https://otinstaller.com/docs/errors#<code>" } }` (`spec/schema/error-v1.json`,
  the same shape as `ot --json` errors). Codes are snake_case;
  messages are short lowercase sentences; hints usually name an `ot` command or a sign-in link (the site makes hint
  links clickable). Multi-problem responses add `problems`. Unhandled errors become 500 `internal_error` with a
  `request_id` (the `cf-ray` header) and go to Sentry; D1 failing on Cloudflare's side (`d1RetryAfter`) is 503
  `database_unavailable` with `Retry-After` instead, a Sentry warning grouped by kind, and the site's `api()` retries
  such a read once. If you add a user-facing code, document it in `web/src/pages/docs/errors.md`.
- **All outbound HTTP goes through `deps.fetch`** (passed to host functions as `f: Fetch`). Calling `fetch` directly
  breaks the tests' fake hosts.
- Raw D1 SQL with `?` bindings; multi-statement writes in `db.batch([...])` with `audit(...)` in the same batch.
  Idempotency via `ON CONFLICT` and guarded status transitions (`UPDATE ... WHERE status = 'x'`, then check
  `meta.changes`).
- Bodies: `await c.req.json<T>().catch(() => ({}) as T)`, then validate by hand with `apiError(400, "invalid_body", ...)`.
- Public reads set `cached(c, seconds)` (and so land in the edge cache); per-user responses should send
  `private, no-store` (only a few do today; the rest are safe only because requests with a cookie or `authorization`
  header bypass the edge cache).
- camelCase in TS, snake_case in SQL and JSON responses, kebab-case file names. Each file opens with a `//` comment saying
  what it owns and where related logic lives (`env.ts` and `index.ts` don't yet); exported functions get `/** */` docs; sections use
  `// ---------- name ----------`. Double quotes, semicolons, two-space indent, long lines are normal here.

### API tests (`api/test/`)

`vitest.config.ts` uses `@cloudflare/vitest-plugin`, so tests run in workerd against the bindings from `wrangler.jsonc`
with fake secrets, `EDGE_CACHE: "off"` and `UPSTREAM_WATCH: "report"`. The config also builds `TEST_SEED` (from `scripts/seed-lib.mjs`),
`TEST_FIXTURES` and `TEST_TEMPLATES` (from `spec/`), `TEST_KNOWN_REPOS` (what `known-repos.ts` should hold) and
`TEST_DOCKERFILES` (every seed wrapper's Dockerfile and upstream); `test/setup.ts` applies the migrations and, when `tools` is empty,
the seed. Helpers in `test/helpers.ts`: `fakeHosts(routes)` (keys like `"GET https://api.github.com/..."`,
longest prefix wins, unmatched requests get status 599), `testEnv()` (a generated GitHub App key, cached per file; a fake queue collecting messages into
`sent`), `call(path, init, env?)`, `webhook(event, payload)`. `test/fixtures.ts` has `ghUser`, `installation`, `tagEvent`,
`manifestFor`, `fakeRelease`. Signed-in users are usually inserted directly into D1 with an `ot_test_<id>` token. Test
files are named by plan week (`week4` publish intake, `week5` scans/review, `week6` GitLab/sync, `week7` imports,
`week8` guides/content, `week10` trust/ops, `week11` backups and mirror, `week12` feedback/beta/test email) plus
`api.test.ts` (search, pivots, types, facets, OpenAPI, old-`ot` manifests, the remote MCP server), `edge-cache.test.ts`,
`osintverse.test.ts`, `community-provenance.test.ts`, `community.test.ts` (issues, moderation, notifications, failed runs,
community activity), `requests.test.ts`, `people.test.ts`, `upstream.test.ts` (pins, the watcher, bumps) and
`proposals.test.ts` (change proposals, first-week counts); community
submissions are in `week7` with the imports. Add tests to the file for that area. Every file migrates and seeds its own D1 and they all run at once, so tests get
30 seconds (`testTimeout`) and hooks 60: on a busy machine a test can pass Vitest's 5-second default without anything
being wrong.

### Seed data

`api/scripts/seed-lib.mjs` builds demo SQL (from `spec/fixtures/valid`, `examples/cosign`, `examples/tldextract`, a `cosign-wrong-signer` variant and some
inline packages, with
deterministic IDs like `tool_<ns>_<name>`) for `npm run db:seed` and the tests. It is for **local D1 only**. Never seed
production from it, from `spec/fixtures`, or with SQL: production packages come only through the real pipeline. It
inserts 5 namespaces, 11 tools, 13 versions, a source, a guide link and an alias, and no users.

---

## Website (`web/`)

Astro 7 with `output: "server"` on `@astrojs/cloudflare`, Preact islands, no CSS framework. Worker
`otinstaller-registry-web` on `otinstaller.com` and `www.otinstaller.com`; deploy with `npm run deploy` (only when asked).

### Layout

- `src/pages/`: SSR pages. Tool pages live under `[ns]/[name]/` (overview, versions, security, docs, report, claim),
  guides under `guides/`, search at `search.astro`, plus `input/[type]`, `category/[slug]`, `[ns]/index.astro` (publisher),
  `dashboard`, `import`, `feedback`, `publish.astro`, `tour.astro`, `settings/accounts`, `transfers/[id]`,
  `admin/[...section]`, `docs/*.md` (including `agents`, `mcp-tools`, `automation`, `api`, `results`, `otlite`),
  `policy/*`, `removed.astro`, `404.astro`, `500.astro` (API trouble, shows the request ID), `new.astro` (what's new),
  `changelog/` and `blog/` (see below), `learn.astro` (+ `learn.md.ts`), the community pages (`community/` with the board and moderation,
  `[ns]/[name]/issues/`, `requests/`, `people/[handle]`, `submissions/`, `settings/notifications`, `unsubscribe`),
  Atom and JSON feeds (`feed.atom.ts`/`feed.json.ts` at the root, per publisher, per tool, per input type), `robots.txt.ts`,
  `sitemap.xml.ts`, `llms.txt.ts` and `llms-full.txt.ts`, `schema/v1.json.ts` and `schema/[name].json.ts` (the
  envelope, run-all and error schemas). Only `schema/v1.json.ts` is prerendered.
- Markdown twins for agents: `<ns>/<name>.md`, guide pages and docs and policy pages as `.md` (`docs/[page].md.ts`,
  `policy/[page].md.ts`, `lib/twins.ts`); `src/middleware.ts` serves them for `Accept: text/markdown` too.
- `/changelog` and `/blog` (`changelog/index.astro`, `blog/index.astro`, `blog/[slug].astro`, their `feed.atom.ts` /
  `feed.json.ts` and `.md` twins): hand-written Markdown in `src/content/changelog/` (one file per entry,
  `YYYY-MM-DD-<words>.md`) and `src/content/blog/` (one per post, the file name is its URL), read by `lib/content.ts`
  (metadata, feeds, twins; what `content.test.ts` loads) and rendered by `lib/content-html.ts` (Vitest can't load `.md`
  components). Not an Astro content collection, so `lib/markdown.ts` and the middleware can answer the twins.
  `src/content/README.md` says how to write an entry or a post.
- `/agents` (`agents.astro`): the homepage for AI agents. Its Markdown twin (`agents.md.ts`, and
  `Accept: text/markdown` on `/agents`) is built from the same content in `lib/agents.ts`, which `agents.test.ts`
  keeps in step with `docs/agents.md` and `docs/mcp-tools.md`. `agents` must stay in `RESERVED` (`lib/twins.ts`),
  or `/agents.md` is taken for a publisher's twin.
- `/otlite` and `/otlite/tools`: the no-Docker edition and its tool catalog (both list every tool through
  `components/OtliteCatalog.astro`, and `/otlite` computes its counts from it), read at build time from
  `src/data/otlite-catalog.json`, which `otlite/scripts/web_catalog.py` generates from otlite's registry (a test in
  `otlite/tests/test_web_catalog.py` fails when it is stale; regenerate it, don't edit it).
- `/otlite/tools/<name>` (`otlite/tools/[name].astro`): one page per otlite tool, from the same JSON through
  `lib/otlite.ts`. It shows install and run commands with a value builder (the value never leaves the page), what each
  typed input becomes on the tool's command line (`tool_args`, computed by otlite's own `_build_tool_args`; the
  browser's `lib/otlite-args.ts` must agree, which `otlite.test.ts` checks for every tool), caveats from the registry's
  flags and `notes`, keys, results, batch runs and playbooks, and a link to the registry wrapper when the launch seed has
  one and it is published. Its Markdown twin is `otlite/tools/[name].md.ts`; there is no sample output on purpose,
  because otlite's example files are illustrative.
- Tool pages show sample output: the envelope the scanner's smoke test recorded (`sample` from the API,
  `recordedEnvelope` in `lib/evidence.ts`), else one shaped from the declared output types, with a caption saying
  which.
- `public/.well-known/mcp-registry-auth`: the public key that proves `otinstaller.com` to the MCP Registry. Don't
  remove or change it without a new key pair (see [Agents](#agents-ot-mcp-the-remote-mcp-server-and-the-plugin)).
- `src/layouts/`: `Base.astro` (HTML shell, beta strip, header with the account menu, lean footer, the one inline
  script, global client JS for copy buttons and the `/me` account check), `Docs.astro` (with prev/next links),
  `Policy.astro`.
- `src/components/*.astro`: server components (PasteBox, InstallBlock, ToolRow, ToolCard, ToolHeader, Evidence,
  Results, PageReader, Terminal, BetaNotice, CopyCode, CopyCommand, Logo, PageHead, SideNav, ThemeToggle).
  The design follows osintverse.com (`docs/web-redesign-plan.md` section 4.9): Geist Mono, dark by default, no radius.
- `src/islands/*.tsx`: Preact islands for anything signed-in or interactive (AdminConsole with review, reports,
  transfers, community, upstream, audit, feedback and beta tabs; Dashboard; PackageDetail and JobView (the `/dashboard/{ns}/{name}` and
  `/dashboard/publish/{jobId}` pages); Backups (used by Dashboard and PackageDetail); ImportWizard (four steps; its
  forms write YAML blocks through `lib/yaml-blocks.ts`), Accounts, ClaimFlow, TransferView, ReportProblem (the
  report page: a public issue through `IssueForm`, a count without an account, or the private ReportForm), FeedbackForm,
  VersionActions, SearchDialog; for the community IssueComposer, IssueThread, WorksForMe, FollowReleases, CommunityModeration,
  NotificationSettings, RequestForm, RequestVote, RequestDecision, SubmissionActions, UpstreamWatch, BumpRelease,
  ProposeChange and ProposalActions (a community package's Changes tab, `[ns]/[name]/changes/`)).
  The import wizard also packages someone else's tool ("Someone else's tool", with `lib/dockerfile-templates.ts`).
  `shared.tsx` has `useMe`, `SignIn`, `ErrorNote`, `Status`, `Loading`, `Confirm`.
- `src/lib/`: `api.ts` (the only fetch helper: `api<T>()`, `apiOrNull`, `ApiError`, `signInUrl`, response types, and the
  `BETA` / `ISSUES_URL` settings), `page.ts` (`cacheFor`, `searchFrom`, `withParam`), `tool.ts` (`loadTool` handles
  404/410/moved/guide redirects), `theme-boot.ts`, `format.ts` (+ `format.test.ts`, including `hintParts`),
  `detect.ts` (the paste box's type detection, the CLI's rules; `/search` redirects typed values to `/input/{type}`),
  `evidence.ts` (the tool page's evidence lines and sample envelope), `install.ts` (the install commands; a test
  keeps `docs/getting-started.md` equal to them), `yaml-blocks.ts`, `feeds.ts` (Atom, JSON Feed, event wording),
  `learn.ts`, `compare.ts` (the input pages' comparison table), `community.ts`, `requests.ts`, `submissions.ts` and
  `proposals.ts` (labels), `first-week.ts` (wording a new version's first-week counts), `report.ts` (the report page's
  choices, `reportHref`, `withError`), `twins.ts` (Markdown twins and `RESERVED`).
- `src/styles/`: `tokens.css` (all colours, radii, motion, type scale; light and dark), `global.css` (shared classes),
  `admin.css` (admin console only).

Environment: `PUBLIC_API_URL` (default production), `PUBLIC_BETA` (`"0"` hides the beta strip), `PUBLIC_ISSUES_URL`
(default `https://github.com/OTInstaller/feedback/issues`), `SITE_URL`.

### Rules that are easy to break

- **Strict CSP** (`astro.config.mjs`, hashed `script-src` and `style-src`). These are blocked in production and fail
  silently: inline `style=""` attributes, `define:vars`, un-hashed `is:inline` scripts, `<ClientRouter />` /
  view-transitions router, Shiki syntax highlighting (inline styles), third-party fonts or scripts not already listed.
  - Put client code in bundled `<script>` tags in `.astro` files or in islands.
  - The only inline script is `THEME_BOOT` (`src/lib/theme-boot.ts`); its hash is computed in `astro.config.mjs`. A new
    inline script needs the same treatment.
  - Stagger animations with `.stagger > :nth-child(n) { --i }`, hide reveal-on-scroll content only under `html.js`, and
    use native `@view-transition` for page transitions.
  - The CSS minifier drops unprefixed `backdrop-filter` when a `-webkit-` duplicate sits next to it: write only the
    standard property.
  - **`astro dev` does not enforce the CSP.** Check visual or motion changes in the production preview
    (`npm run build && npm run preview -- --port 4322`, or the `web-preview` launch config).
- Colours come from tokens in `tokens.css`, defined for light, dark (`prefers-color-scheme`) and `[data-theme]`; keep
  pairs WCAG 2.2 AA in both themes. Honour `prefers-reduced-motion` (CSS zeroes durations; JS checks `matchMedia`).
- `PUBLIC_API_URL` is read both in `astro.config.mjs` (CSP `connect-src`) and in `src/lib/api.ts`; they must agree.
- SSR pages call the API without cookies and render only public data. Signed-in data loads in islands, and those pages
  send `Cache-Control: private, no-store`. Public pages set caching with `cacheFor`.
- Filter, sort and pagination links get `rel="nofollow"` (see the edge cache above); pages with a query string are
  `noindex` automatically.
- New docs pages need adding to the hardcoded nav in `Docs.astro` and to `DOCS` in `sitemap.xml.ts`. Policy pages go in
  the nav in `Policy.astro`; the sitemap has no policy pages today.
- Install instructions come from `lib/install.ts` (used by `InstallBlock.astro`) and are repeated in
  `docs/getting-started.md`, which `install.test.ts` checks; Homebrew, Scoop and Go installs are hidden until after the
  beta.
- Nothing may be hidden at first paint waiting for JavaScript (no `opacity: 0` reveals), and nothing loops: the old
  reveal-on-scroll hid the whole home page in some browsers. `npm run contrast` checks the token pairs for AA.
- HTML from the registry (READMEs, guide pages) is already sanitized server-side and rendered with `set:html`; don't
  render other untrusted HTML that way.
- Every component and island file opens with a one-line purpose comment.
- A new top-level page needs its name in `RESERVED` (`lib/twins.ts`) and in the API's `RESERVED_NAMESPACES`
  (`api/src/lib/reserved.ts`), or a publisher with that name hides it; `reserved.test.ts` checks both.
- Community content is user-written: render posts only through the API's `body_html` (sanitized, links
  `nofollow ugc`), never put titles or notes into feeds, `aggregateRating` or `<title>` of an indexable page, and keep
  issue, request and submission pages `noindex` until the API says `indexable`.

### Local environments

- Production API holds the published seed (most of `seed/`; the dry-run test packages were taken down on 21 Oct),
  and sits behind the edge cache; staging (`staging-api.otinstaller.com`) only works
  while a tunnel to someone's local `wrangler dev` is up, so it's usually down.
- From a `localhost` origin, browser-side calls to the production API with credentials (`/me`, quick search) fail CORS.
  That is expected, not a site bug.
- For a full local check: run the API (`npx wrangler dev --var SITE_URL:http://127.0.0.1:<site port>` in `api/`, seeded)
  and build the site with `PUBLIC_API_URL=http://127.0.0.1:8787`. Details in
  [docs/dev/local-setup.md](docs/dev/local-setup.md).

---

## Community: issues, requests, submissions and the upstream watcher

The plan is [docs/roadmap.md](docs/roadmap.md) (phase 1 built). User docs: `web/src/pages/docs/community.md` and
`policy/community.md`; every route is in [docs/dev/api.md](docs/dev/api.md) and every table in
[docs/dev/database.md](docs/dev/database.md).

- **Issues** (`community.ts`, migration 0016): per package, with replies, "me too", follows and flags. Posts from
  accounts under a day old, posts `screen()` flags as personal data or secrets, and a first post with links are held
  for a moderator; links from new authors render as text, every link is `nofollow ugc`. A personal-data flag from an
  established account, or three flags, hides a post at once. Triage (status, locks, hiding) is for the package's
  maintainers, triagers and staff; only staff redact. Daily limits per person (`dailyLimit`). The registry files
  system issues itself (`fileSystemIssue`, deduplicated by key).
- **Status line** (`GET /tools/:ns/:name/status`): the nightly health check and its history, confirmations from the
  last 30 days by platform, open broken issues, in one sentence with counts, never a score.
- **`ot` hooks**: the failure prompt (`report_prompt.go`) sends `run-reports` only after a yes; anonymous reports only
  count (once per address a day; three in a week open an "unconfirmed" issue), signed-in ones join the version's broken
  issue.
- **Report a problem** (the button in `ToolHeader`, `/<ns>/<name>/report`, `ReportProblem`): doesn't work, shows an
  error, out of date or wrong page become issues when signed in; without a sign-in, broken and out of date are counted
  (`problem-reports`, `problem_signals`, 0032). Broken counts share `ot`'s once-a-day key and unconfirmed issue;
  outdated ones (latest version only) open `outdated_signals:<v>` unless another outdated issue is open, closed by
  `announceVersion`. Malware, abuse and legal problems stay the private `ReportForm`.
- **Notifications** (`inbox.ts`, 0017): inbox rows written with each event, emailed within 15 minutes or as a daily
  digest per person's preference, at most 12 a day, with a signed one-click unsubscribe (`TOKEN_ENC_KEY`).
- **Following releases** (0029): anyone signed in follows a package (`PUT /tools/:ns/:name/follow`, the "Follow
  releases" island on tool pages) and gets a `release` item (scope `releases`, its own email preference) when a
  version becomes the latest. People following one of its open broken or outdated issues get the issue's item
  instead. Follows are private: no counts, nothing on profiles. Publishers and input types can be followed too
  (0030, `PUT /me/follows/publisher|input/:target`, the same island on publisher and input pages): a publisher's
  followers hear of each of its releases, an input type's of new packages taking it, each person once per release
  (`notifyFollowers`).
- **Requests** (`requests.ts`, 0018): one per repository, checked when made (public, not packaged or requested,
  no upstream manifest; a license the registry can't redistribute or an archived repository is declined at once);
  votes; triagers decide; a published package from that repository answers it (`linkPublished`). Each has a
  discussion (0026): replies screened and moderated like issue comments through the same `community.ts` functions
  (kind `request_comment`), followers (the requester, repliers, anyone who follows it) told of replies and decisions,
  locks by triagers or 30 days after a decision. Requests and their replies can be flagged; they are moderated by
  triagers and staff only.
- **Profiles** (`people.ts`, 0019): `/people/<handle>` with roles and counts recomputed nightly; never email or
  accounts; hidden profiles 404.
- **Submissions** (`submissions.ts`, 0020): anyone signed in finishes a community import with mode `submit`. Checks
  first, then the community bot (a second GitHub App, `COMMUNITY_APP_*`; without it 503 `community_bot_missing`)
  creates `osintverse-community/<name>`, commits the files and tags or dispatches the release. The first release waits
  for a reviewer who isn't the submitter (`needs_first_review`); the submitter becomes a maintainer.
- **Upstream watcher** (`upstream.ts`, 0021; pins from `upstream-pin.ts`): nightly, at most three requests per
  wrapper. `UPSTREAM_WATCH=report` (default) records; `issues` opens and closes outdated issues; `prs` also has the
  bot open pin-only bump pull requests for stable releases (`bumps.ts`, 0022, 0028), which maintainers merge and
  release from the package page; `auto` also has the nightly check merge and release a pin-only bump itself a week
  after upstream's release (`maybeAutoRelease`: stable version, redistributable license, still open on GitHub, exactly
  the planned file, the package's `tools.auto_release` on, at most ten a day). Each release is followed: published
  settles the bump `released` and closes its outdated issue; a rejected version or publish job, a failed release
  workflow run or nothing within 12 hours settles it `failed` and tells the maintainers (`settleBump`, `sweepBumps` on
  the 15-minute cron), and a failed bump can be released again under a new version. The wrapper's version is
  upstream's as X.Y.Z (`upstreamSemver`: 2.2 is 2.2.0), or a patch on top when that isn't above every version it had
  (`wrapperVersion`).
- **Build watcher** (`build-watch.ts`, 0031): nightly, for every Docker package with a source in the community
  namespace. First-party tools' `requirements.txt` pins are compared with PyPI; under `UPSTREAM_WATCH` they get
  `dependency:<pkg>==<ver>` issues, one bot pull request per set of releases (`bump_prs.kind = 'dependency'`, released
  as a patch) and auto releases, through the same release, settle and sweep code as bumps. Each build's base image
  (last `FROM`, Docker Hub digest) is recorded; `REBUILD_WATCH=rebuild` reruns the release workflow on unchanged source
  (`kind = 'rebuild'`, #0) when the digest changed and the latest scan has fixable critical or high vulnerabilities.
- **Change proposals** (`proposals.ts`, 0027): a wrapper's maintainers and reviewers edit its `otinstaller.yaml`,
  Dockerfile or README on the package's Changes tab. `checkProposal` keeps only what differs from main, validates the
  manifest, refuses identity changes (`protected_field`) and secrets, moves the version past every version the package
  had, and lists for the reviewer the fields changed, ethics changes, Dockerfile rules missed and personal data. The
  bot opens the pull request; a reviewer who isn't the proposer approves it, and the bot merges it and dispatches the
  release workflow (builds) or tags it. Reviewers find open ones on `/submissions`.
- **A new version's first week** (`first-week.ts`): for seven days after a version is published, the status line
  says when it came out and what people said since, `GET /tools/:ns/:name/status` has `new_version` (by platform,
  beside the previous version), and the versions list and `/v1/activity` carry `first_week`, which the tool page,
  versions page, `/new` and `ot outdated` (a `note:` line and `latest_first_week`) show.
- **Activity and feeds**: `/v1/activity` (registry events; `events=community` adds confirmed and fixed issues and
  accepted and published requests, worded from fields), `/new`, and Atom/JSON feeds at the root, per publisher, per
  tool (release notes) and per input type.

## Agents: `ot mcp`, the remote MCP server and the plugin

The design note is [docs/agent-friendly-plan.md](docs/agent-friendly-plan.md) (phases 1 to 5 built; each phase's
status section says where the build differs). User docs: `web/src/pages/docs/agents.md`, `mcp-tools.md` (every tool,
resource and prompt) and `automation.md` (JSON output, exit and error codes, no prompts, consent for scripts).

**`ot mcp`** (`cli/internal/cli/mcp_*.go`, rules in `cli/internal/agent/`) is a local MCP server over stdio, on the
official Go SDK. Tools run on the person's machine in the same sandbox as `ot run`.

- Read-only tools (`mcp_tools.go`): `search_tools`, `get_tool`, `list_installed`, `list_types`, `key_setup`,
  `suggest_pivots`, `detect_type`, `list_playbooks`, `get_playbook`, `list_runs`, `get_run`, `extract_indicators`,
  `diff_runs`, `search_guides`, `read_guide`, `validate_manifest`, `doctor`, `get_consent_status`. Tools with effects
  (`mcp_run.go`): `install_tool`, `uninstall_tool`, `run_tool`, `run_all`, `run_playbook`, `cancel_run`. Resources
  (`ot://schema/...`, `ot://types`, `ot://policy/...`, `ot://runs/{run_id}`, `ot://cases/{case}`, tool manifests,
  guide pages) and prompts (`investigate_*`, `pivot_from_run`, `compare_runs`, `write_playbook`, `publish_tool`) are in
  `mcp_content.go`. Every result that carries tool output starts with a note that it is untrusted data, not instructions.
  `list_playbooks` and `get_playbook` give each playbook's `inputs`. `run_all` and `run_playbook` never install: with
  nothing installed for the target, `run_all` answers `not_installed` with the starter playbook's `suggested_tools`.
- Consent: `agent.Classify` puts each run in the strictest class that applies: passive (offline), networked, target
  (`ethics.touches_target`, or the person's own keys or account) or personal (`collects_personal_data`, or an email,
  phone, name or image input). By default only passive runs go ahead unasked. Otherwise the server asks the person:
  clients on the 2026-07-28 protocol get an input request back, older clients that support elicitation get a form, and
  the rest get a `consent_required` error with a summary and a consent token (`ct_...`). The token is an HMAC over
  that exact call (tool, artifact and arguments), works once, expires after 10 minutes and dies with the process; an
  agent must only pass it back after the person said yes. "Allow for this session" lasts `consent_ttl_minutes`.
- Policy: `<ot home>/agent-policy.json` (`ot mcp policy` shows it, `ot mcp policy reset` writes the defaults):
  `enabled` (kill switch), `mode` (`live`, or `sandbox` to run every tool on its own test input), `allow_tools` /
  `deny_tools`, `auto_approve` (none, passive or networked; target and personal runs always ask), rate limits per hour,
  per target and in parallel, `max_output_chars`, `allow_install` and `redact_targets_in_audit`. A broken file is an
  error, never a silent fallback to looser rules; changes apply without a restart.
- Audit log: `<ot home>/agent-audit.jsonl`, one line per install, uninstall or run by an agent or an unattended
  `ot run` (client, tool and digest, inputs or their hash, class, how consent was given, outcome, run id), rotated at
  10 MiB with four old files kept. It never leaves the machine. `ot mcp audit [--since 24h]` reads it.
- `ot mcp install <claude|claude-desktop|cursor|vscode|codex|gemini>` writes the client's configuration (`--print`
  shows it instead). `ot mcp tools` lists the tools, resources and prompts.
- API keys: agents never set keys. `key_setup` describes each key a tool needs (cost, sign-up link, whether it is set,
  never the value) and hands over `ot keys setup <tool>`, which only works at a terminal.
- Tests: `mcp_test.go`. `TestMCPToolsDocsMatch` requires every tool's exact description in
  `web/src/pages/docs/mcp-tools.md`, and `TestAgentPluginMatchesServer` that every tool and prompt the plugin names
  exists, so a renamed or reworded tool means editing both.

**Remote MCP server** (`api/src/mcp.ts`, `https://api.otinstaller.com/mcp`): Streamable HTTP without sessions, answered
by the API Worker's `fetch` before the Hono app. Six read-only tools (`search_tools`, `get_tool`, `list_types`,
`suggest_pivots`, `search_guides`, `read_guide`), each an anonymous GET of the public API through the edge cache, so
it costs what a page view does. It can't install or run anything and points agents at `ot mcp` for that. A
Cloudflare rate-limiting rule on the zone covers `/mcp` and the search routes (launch checklist). Tests are in
`api/test/api.test.ts` ("remote MCP server"). It reports the consent class `ot mcp` would give a run, from a hand-made
copy of `cli/internal/agent/consent.go` (`PERSONAL_INPUTS`); keep the two in step.

**Agent plugin** (`integrations/agent-plugin/`): a Claude Code and Cursor plugin with skills
(`osint-investigation`, `publish-osint-tool`, `write-osint-guide`), a Cursor rule, hooks and the MCP configuration.
It is published by copying the folder to the public repo `OTInstaller/agent-plugin` and tagging there
([publishing-setup.md](docs/publishing-setup.md) section 12).

**MCP Registry.** `com.otinstaller/ot` is listed from each `ot` release's `server.json` (written by `cli/cmd/mcpb`;
descriptions must stay within the registry's 100 characters), `com.otinstaller/registry` from
`integrations/mcp-registry/server.json` (bump its `version` when the remote tools change). Both are published by hand
with the registry's publisher (installed by `go install` as `publisher`), signed in with
`publisher login http --domain otinstaller.com` and the owner's private key (kept outside the repository in
`~/.mcp-registry/`); the registry checks it against
`web/public/.well-known/mcp-registry-auth`. The steps are in [publishing-setup.md](docs/publishing-setup.md),
section 10, "MCP bundles and the MCP Registry".

## Ops (`ops/`)

- `ops/scanner/scan.py <request.json> [--post]`: the job runner registry-ops executes. The request is a scan payload, a
  `{"job": ...}` wrapper, a backup payload or a drill payload.
  - Scans: Docker images are pulled, `cosign verify`ed against the expected signer (plus a loose verify to tell "signed by
    someone else" from "unsigned"), Trivy vuln+secret scanned, SBOM'd. pipx wheels are downloaded by hash, checked for
    PEP 740 provenance against the source (or upstream) repo, Trivy scanned on python:3.12-slim, and run through
    GuardDog. Then a sandboxed smoke test with `test.input` (network only if egress is declared) passes when the exit
    code equals `test.expect_exit_code`. Results POST to `callback_url`; if the answer has a `backup` plan, it runs.
- `ops/scanner/backup.py`: image copies with `crane` (signature, attestation and SBOM tags included; big layers chunked),
  wheel and git-bundle uploads to signed URLs, and restore drills.
- `ops/scanner/health.py`: the nightly health check (each tool's test input, with network); 3 failures in a row mark a tool
  Possibly broken.
- `ops/scanner/Dockerfile`: pinned Docker CLI, Trivy, cosign, crane, GuardDog for local runs. Tests: `test_scan.py`,
  `test_backup.py`.
- `ops/workflows/scan.yml` (dispatch types `otinstaller-scan`, `otinstaller-backup`, `otinstaller-drill`; needs
  `MIRROR_PUSH_TOKEN`) and `health.yml`: copied into `OTInstaller/registry-ops`, not run from this repo. If you change
  `ops/scanner` or `ops/workflows`, the copies there have to be updated separately.
- The payload formats are defined by `dispatchOps`/`dispatchScan` in `api/src/scans.ts` and `backups.ts`, and parsed by
  `parseResults` in `api/src/routes/review.ts` (scans) and inline in `routes/backups.ts` (backup reports, at most 10
  items; drill reports aren't shape-checked); change both sides together. Every field, with JSON examples, is in
  [docs/dev/ops-payloads.md](docs/dev/ops-payloads.md).
- `dispatchOps` authenticates with `OPS_DISPATCH_TOKEN`, or else a GitHub App installation token for
  `OPS_INSTALLATION_ID`. Secrets on the registry-ops side: `MIRROR_PUSH_TOKEN` and `HEALTH_TOKEN` (must match the
  mirror's and the API's), variables `MIRROR_HOST` and `REGISTRY_API`; see [docs/dev/config.md](docs/dev/config.md).
- `ops/get/`: the `otinstaller-get` Worker for `get.otinstaller.com`. It maps `/ot`, `/ot.sh`, `/install.sh` and
  `/ot.ps1`, `/install.ps1` to the latest release's scripts on `OTInstaller/ot` (`RELEASE_REPO`), and `/otlite`,
  `/otlite.sh` to `otlite/scripts/install.sh` on this repo's `main` (`OTLITE_REPO`; it installs from PyPI, so it needs
  no release). Both are cached 5 minutes; upstream errors get a script that fails loudly, and other paths redirect to
  the getting-started docs. `/ot/latest` answers `{"version"}` for the latest `OTInstaller/ot` release, read from
  GitHub's `/releases/latest` redirect (no API limit) and cached an hour; `ot self-update` and `ot outdated` ask it
  first and fall back to the GitHub API. A change to `otlite/scripts/install.sh` is live as soon as it reaches `main`.
  Deploy with `npx wrangler deploy` from `ops/get` (only when asked). It has no automated test.

## Seed (`seed/`)

Each folder becomes its own repository under `osintverse-community`; see [seed/README.md](seed/README.md) for the full
table, publish order (namespace → tools → guides), what was not converted and why, and health risks.

- `first-party/<tool>/` (20): a single stdlib-first Python script (`<snake_name>.py`, argparse, `main(argv=None)` returning
  an exit code, prints `{"entities": [...]}`), `test_<snake_name>.py` (unittest, no network), a `python:3.12-slim`
  Dockerfile running as uid 10001, `otinstaller.yaml` with a zero-digest placeholder the release workflow fills in,
  `README.md`, MIT `LICENSE`, and `.github/workflows/otinstaller-release.yml` (copied from
  `spec/templates/github-docker.yml`; copies older than its OIDC publish step lack it). Nine (published 24 Oct 2026)
  are built on a data provider's official PyPI client (VirusTotal, urlscan.io, Censys, OTX, IPinfo, Hunter, HIBP,
  Companies House, SEC EDGAR), pinned in `requirements.txt` so the build watcher follows it; they exit 3 when their
  key is missing, and a script named like its client library gets a `_lookup` suffix so it doesn't import itself.
- `community/<tool>/` (119): wrappers of third-party tools. Docker wrappers pin the upstream version in a Dockerfile and
  build amd64+arm64; pipx wrappers are just a manifest pinning the wheel by `wheel_sha256` plus a README crediting
  upstream. The upstream license must be in the API's `REDISTRIBUTABLE` list (`api/src/imports.ts`), which includes the
  AGPL; GHunt (needs a Google login) and blackbird (no license) are outreach only. 11 wrappers were converted from the
  `otlite/` catalog by `scripts/pm-catalog-to-wrappers.py` (`--dry-run`, `--offline`; it never overwrites a folder);
  git-pinned ones use versions like `0.0.0-git.<commit>`. 65 more (October 2026) cover every open-source OSINT tool
  over 100 stars that could be wrapped; `seed/candidates.md` lists every candidate with why it was wrapped or dropped.
  All 65 were published on 22 Oct 2026. 16 more (published 24 Oct 2026) wrap PyPI clients of data providers
  (ONYPHE, PolySwarm, Joe Sandbox, FOFA, CIRCL's services, the Internet Archive, Common Crawl, GLEIF, MalwareBazaar,
  ipdata, Google Safe Browsing and others; `seed/README.md`, "PyPI clients of data providers"). A CLI that reads its
  key only from a config file gets a Docker shim that writes it from the key's environment variable, as
  `shodan-host` does, and a CLI whose command needs a pip extra is a Docker wrapper (`pip install "pkg[cli]==X"`).
- The scanner's smoke test builds the command from `test.input` alone and leaves input defaults out, so an argument
  that embeds a defaulted input (`rows:{limit}`), or a flag a tool can't run without, needs that input in
  `test.input`.
- Seven published seed packages gained `ethics.notifies_target`/`notes` or a key's `pricing` and were re-released on
  22 Oct 2026 with a patch bump (seed/README.md, "notifies_target and key pricing"). A wrapper that already pins the
  latest upstream gets a patch version upstream never shipped, because a prerelease never becomes `@latest`.
- `guides/<guide>/` (10): `otinstaller.yaml` (`kind: guide`, CC-BY-4.0), `docs/index.md` + numbered pages, README,
  LICENSE.md. Guides have no release workflow: release them with `ot release X.Y.Z` (or a plain `git tag vX.Y.Z && git
  push`), never through GitHub Actions.
- `outreach/`: issue and PR texts for upstream maintainers.
- The bundled playbooks' tools must exist in the seed (`TestBundledToolsAreSeeded`), take one of the playbook's
  `inputs` types and need no key (`TestBundledPlaybooksFitSeed`), and every seed manifest must validate
  (`TestSeedManifests`).
- Updating a pipx wrapper: change `version`, `package_version` and `wheel_sha256` (from `https://pypi.org/pypi/<pkg>/json`).
  With `UPSTREAM_WATCH=prs` the community bot opens that change as a bump pull request, and Docker wrappers get their
  pin line bumped the same way.
- Every wrapper Dockerfile must pin its upstream release in a way `api/src/upstream-pin.ts` reads, and follow the
  submission rules (`dockerfileChecks`); `upstream.test.ts` and `week7` check every seed Dockerfile.

## otlite, the no-Docker edition (`otlite/`)

`otlite` (on PyPI; called `otinstaller` until 1.0.0) is the Docker-free edition for Linux and macOS (macOS from 1.2): it
installs tools by name into per-tool virtualenvs from the catalog in `otlite/src/otlite/data/registry.yaml`. It is
supported alongside `ot`; the `ot` alias it once had was removed. The `OTINSTALLER_*` environment variables are still
read and the first run copies settings from `~/.otinstaller`. Users of both editions use
[docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md).

- Releases: bump the version in `otlite/pyproject.toml` and `src/otlite/__init__.py`, add a `CHANGELOG.md` entry and
  tag `otlite-vX.Y.Z`; `release-otlite.yml` tests, builds, publishes with PyPI trusted publishing and creates the
  GitHub release. 1.0.0, 1.1.0 and 1.2.0 went out on 22 Oct 2026 (a 1.2.1 pull request was open that day); check PyPI
  or `gh release list` for the latest rather than trusting a number here. The `otinstaller` shim
  (`otlite/otinstaller-shim/`, the old PyPI name, depending on `otlite`; 0.2.0 is published) is uploaded by its own job
  from its own environment (`pypi-otinstaller`, `testpypi-otinstaller`), because PyPI picks one publisher per
  environment.
- The one-line installer `curl -fsSL https://get.otinstaller.com/otlite | sh` is `otlite/scripts/install.sh` (pipx
  from PyPI when Python and pipx are there, else a pinned, hash-checked uv with its own Python 3.12, no sudo), served
  from `main` by `ops/get`. Bumping uv means changing `UV_VERSION` and all four SHA-256 values in the script.
- `otlite/scripts/web_catalog.py` writes `web/src/data/otlite-catalog.json` for the site's `/otlite` pages (it reads
  `seed/community/` to name each tool's registry wrapper); rerun
  it whenever the catalog changes (its test fails otherwise). This is the one place where `otlite/` writes outside its
  folder.
- **Read [otlite/AGENTS.md](otlite/AGENTS.md) before touching anything in `otlite/`.** Its rules apply there and differ
  from the rest of the repo: the package and command are `otlite`; no "OSINT" in package/command names or CLI help;
  Typer (with click), Rich, PyYAML, sentry-sdk and the standard library only (ask before adding dependencies); pip or git installs, one venv per
  tool; never `shell=True`; never log API key values; no emojis; neutral metadata; short lowercase imperative commit
  messages; run `ruff check .`, `ruff format --check .` and `pytest` after every change.
- Layout: `src/otlite/` (`cli.py` thin Typer layer, `registry.py`, `installer/`, `runner.py`, `results.py`,
  `keys.py`, `crash_reports.py`, `examples.py`, `data/`), `tests/` (run from `otlite/`; network tests need
  `RUN_NETWORK_TESTS=1`), `pipeline/` (discover and verify candidate tools; a human merges approved entries),
  `registry/` (denylist and pipeline output), `debian/` (Debian/Kali packaging), `docs/`, `scripts/` (`install.sh`,
  `web_catalog.py`, `readme_tools.py` which regenerates the README tool list and fails a test when stale,
  `generate_status_page.py`), `otinstaller-shim/`.
- Crash reports are opt-in Sentry with scrubbing; tests and the Debian build force `DO_NOT_TRACK=1`. Keep it that way.
- `otlite/LICENSE` is Apache 2.0 with a `NOTICE` that redistributions must keep.
- If you change the catalog's shape, check `scripts/pm-catalog-to-wrappers.py`, which reads it.

## End-to-end scripts

- `scripts/e2e.sh`: builds `bin/ot`, starts a local `registry:2` on 127.0.0.1:5000, builds and pushes
  `examples/dns-lookup`, fills its digest into the (gitignored) `otinstaller.yaml`, then runs `ot validate`,
  `validate --smoke`, `run` and `list` with a temporary `OT_HOME`.
- `scripts/e2e-real.sh`: against the local API (`cd api && npm run db:seed && npm run dev`), checks that the real signed
  `sigstore/cosign` image installs (exit 0), a wrong signer is refused (exit 4), the real tldextract wheel installs, and a
  tampered wheel hash is refused (exit 4).
- `scripts/e2e-backups.sh`: runs the API and mirror under `wrangler dev`, backs up a release with the scanner's backup
  job, blocks the original registry and PyPI, and checks `ot install` succeeds from the mirror and the wheel copy, then
  restores the git bundle.
- `scripts/e2e-direct.sh`: runs the API and mirror under `wrangler dev`, creates a namespace with `ot namespace
  create`, publishes `examples/dns-lookup` with `ot publish --image` (dry run first), checks the pushed image is hidden
  from anonymous pulls, readable with the scanner's credential and closed to another user's token, then reports a
  passing scan and checks `ot install` pulls the released image from the mirror.
- `scripts/install/make-test-release.sh`: a locally signed release for testing the install scripts (used by CI).
- `scripts/beta/labels.sh`: creates the issue labels (`sev-1..3`, `needs-triage`, `beta`, `area:*`) with `gh` (only when
  asked: it changes a GitHub repo).

## CI (`.github/workflows/`)

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `cli-install.yml` | PRs and pushes to main touching `cli/**`, `scripts/install/**`, `cli-install.yml` or `release-cli.yml`; `workflow_dispatch` | GoReleaser snapshot with the real config, archive contents check, the MCP bundles built and checked with `mcpb validate`, then installs with `install.sh` / `install.ps1` on Linux (x64, arm), macOS and Windows and runs `ot --version`, `search`, `info`, `doctor`, and on Linux (x64 and arm) a real install/run |
| `release-cli.yml` | `v*.*.*` tags | Releases `ot` with its `.mcpb` bundles and `server.json` (see above) |
| `otlite-ci.yml` | pushes and PRs touching `otlite/**` | ruff and pytest on Ubuntu × Python 3.10–3.14, Debian, Arch and macOS 14; a Kali `.deb` build and install; wheel build, pipx install and the `otinstaller` shim; the one-line installer on Debian and macOS; a Playwright browser tool check |
| `otlite-nightly.yml` | 02:00 UTC daily; `workflow_dispatch` | ruff, otlite pipeline verify (20 candidates), an installed-tool contract test and the full otlite test suite |
| `release-otlite.yml` | `otlite-v*.*.*` tags; `workflow_dispatch` (`testpypi` or `pypi`) | Tests, builds otlite and the shim, publishes each with PyPI trusted publishing from its own environment (otlite first), creates a GitHub release |
| `issue-severity.yml` | issues opened/edited | Sets one `sev-N` label from the bug form's Severity field |

Nothing in CI runs `go test`, the API tests, the site checks, the scanner tests or the e2e scripts.

---

## Cross-cutting checklists

**Changing the manifest format**
1. Edit `spec/schema/v1.json`; add valid/invalid fixtures (`# expect: <code>`).
2. `cd cli && go generate ./...`; update `cli/internal/manifest` (typed struct, semantic checks, codes).
3. Update `api/src/lib/manifest.ts` (and `publish.ts` if release-time) with the same codes.
4. Update `web/src/pages/docs/manifest.md` and `errors.md`; check `api/scripts/seed-lib.mjs`, the seed manifests
   (`TestSeedManifests`) and `scripts/pm-catalog-to-wrappers.py` still produce valid manifests.
5. A new optional field: add it to `compatManifest()` so older `ot` releases can still install; a new input or entity
   type: describe it in `spec/types.json` and map it in `spec/pivots.json` (both have tests).
6. `go test ./...` in `cli`, `npm test` in `api`.

**Changing a release template**: edit `spec/templates/`, run `go generate ./...` in `cli` and `npm run sync:templates`
in `api`, keep the GitLab merge-request text in `api/src/imports.ts` in step, and update the copies under
`seed/*/*/.github/workflows/` if the seed should pick it up.

**Adding an API endpoint**: put it in the matching `routes/*.ts`, logic in the domain module, outbound calls through
`deps.fetch`, errors through `apiError`, the right caching (`public` lands in the edge cache), the right token scope
(`requiredScope` in `scopes.ts`), the operation in `spec/openapi/v1.json` for public and owner routes, a test in the
matching test file, and if the CLI or site uses it, the client in `cli/internal/api` or `web/src/lib/api.ts`.
User-visible behaviour belongs in `web/src/pages/docs/`.

**Adding a CLI command**: an `xxxCmd()` method registered in `Root()`, output via `a.Out`/`a.Err`, a `--json` form,
no prompt without a terminal (`needsInput`), typed errors for exit codes (with a `Reason` for the JSON code), a test
with `newTestApp`, entries in `web/src/pages/docs/cli.md` and [docs/dev/cli.md](docs/dev/cli.md), and in
`cli/README.md` / `docs/typed-inputs-and-results.md` where relevant.

**Changing an MCP tool**: `cli/internal/cli/mcp_tools.go` or `mcp_run.go`; its row in
`web/src/pages/docs/mcp-tools.md` must carry the exact description (`TestMCPToolsDocsMatch`); the plugin's skills and
rule in `integrations/agent-plugin/` must name only tools that exist (`TestAgentPluginMatchesServer`); anything with an
effect goes through `agent.Session.DecideRun` and the audit log. If the remote server should offer it too, add it to
`api/src/mcp.ts` and bump `integrations/mcp-registry/server.json`'s version.

**Changing what the scanner receives or reports**: `api/src/scans.ts` / `backups.ts`, the matching route parser,
`ops/scanner/*.py` and their tests, and a note that registry-ops needs the new copy.

**Adding a top-level site page**: the page, `RESERVED` in `web/src/lib/twins.ts`, `RESERVED_NAMESPACES` in
`api/src/lib/reserved.ts`, the sitemap if it should be indexed, and `llms.txt` if agents should find it.

**Changing community rules** (who may post or triage, holds, limits): `api/src/community.ts` (or `requests.ts`,
`submissions.ts`), the error codes in `web/src/pages/docs/errors.md`, `web/src/pages/docs/community.md` and
`policy/community.md`, and the tests in `community.test.ts` (or the matching file).

**Changing the site's look or motion**: tokens first, no inline styles or scripts, test both themes and reduced motion,
and verify in the preview build.

## Git and commits

- `main` is the default branch. Work happens on a `claude/<topic>` branch. Since PR #2 nearly everything lands as a
  GitHub pull request (`Merge pull request #N from OTInstaller/claude/<topic>`); older work was merged locally with a
  no-ff `Merge claude/<topic> (short description)`. Fetch first: `origin/main` moves often, and bring it in with a
  merge (`Merge origin/main`), not a rebase of shared branches.
- A change people will notice (an `ot` or otlite release, a new page or feature, the registry behaving differently)
  adds a changelog entry, one file in `web/src/content/changelog/`, in the same pull request; how to write one is in
  `web/src/content/README.md`. Date it the day it reaches people (release or deploy), and fix the date if the deploy
  comes later. Internal changes (tests, refactors, ops, docs for contributors) get none.
- Commit subjects: imperative, sentence case, no trailing period, no conventional-commit prefixes. An area prefix is
  common: `Seed:`, `Scanner:`, `Web:`, `Site:`, `Backups:`, `Edge cache:`, `Admin API:`, `Install scripts:`,
`Release workflow:`, `ot run:`, `ot feedback:`, `Launch checklist:`, `AGENTS.md:`. British spelling is used
  ("Honour", "organisation"). Backticks for commands are fine. Inside `otlite/`, follow its own style (short, lowercase,
  imperative).
- Bodies: a short paragraph on why, then `- ` bullets in plain prose, wrapped at about 115 characters.
- `Release X.Y.Z` is reserved for release commits made by workflows and `ot release`.
- Don't add AI or tool attribution (no `Co-Authored-By` trailers, no "Generated with ..." lines) anywhere: commits, PRs,
  code, or docs.
- Don't commit `.dev.vars`, `.env.development`, `bin/`, `dist/`, `results/`, `.wrangler/` or
  `examples/dns-lookup/otinstaller.yaml` (all gitignored), nor `__pycache__/` (ignored only inside `otlite/` and
  `seed/`; one `.pyc` under `ops/scanner/` is committed by mistake).

## Things that need explicit permission

These affect production or other people, so do them only when asked: `npm run deploy` / `wrangler deploy` (api, mirror,
web or `ops/get`), `wrangler d1 ... --remote`, `wrangler secret put`, pushing `v*` tags on this repo (releases `ot`),
pushing tags or running workflows on seed repositories (publishes packages), publishing `otlite/` to PyPI (pushing
`otlite-v*` tags or running `release-otlite.yml`), pushing to `OTInstaller/agent-plugin`, `publisher publish` to
the MCP Registry, submitting to directories or marketplaces (Anthropic, Cursor), posting outreach issues or PRs or
launch posts, running `scripts/beta/labels.sh`, triggering backups or drills on production, changing the Cloudflare
rate-limiting rule, changing GitHub App, OAuth, R2 or registry-ops settings (including creating the community bot's
App and setting `COMMUNITY_APP_*`), moving `UPSTREAM_WATCH` past `report`, and granting community roles in
production. The operator runbook for all of these is
[docs/publishing-setup.md](docs/publishing-setup.md); current production state is in
[docs/launch-checklist.md](docs/launch-checklist.md).

---

## Troubleshooting quick reference

Full recipes, with the SQL to run and what the crons already fix on their own, are in
[docs/dev/troubleshooting.md](docs/dev/troubleshooting.md). Read production with
`npx wrangler d1 execute otinstaller --remote --file q.sql` (always with `LIMIT`; every read counts against D1's
allowance) and watch it with `npx wrangler tail otinstaller-registry-api --format pretty`. Any write to production
needs the owner's go-ahead.

| Symptom | First thing to check | Recipe |
| --- | --- | --- |
| A release never appears | `publish_jobs` rows in `queued`/`validating`/`scanning`; the commit status on the tag. There is no requeue endpoint | [Stuck publish jobs](docs/dev/troubleshooting.md#stuck-publish-jobs) |
| Version stuck "scanning" | `versions.scan_dispatched_at`; dispatch errors in tail (`OPS_REPO`, dispatch token); the registry-ops run | [Scans that never call back](docs/dev/troubleshooting.md#scans-that-never-call-back) |
| Scan rejected | `scans` rows and the verdict codes; `GET /v1/tools/:ns/:name/:version/scans` | [Failed scans](docs/dev/troubleshooting.md#failed-scans-and-what-the-publisher-sees) |
| Backup `expired`, `failed` or `too_large` | `backup_runs` / `backups` rows; `R2_*` secrets; `MIRROR_PUSH_TOKEN` on both sides | [Backup runs](docs/dev/troubleshooting.md#backup-runs-that-expire-or-fail-too_large) |
| Drill failed email | the `restore_drills` row | [Restore drill failures](docs/dev/troubleshooting.md#restore-drill-failures) |
| Change not visible on the public API | `x-edge-cache: hit` and the endpoint's `max-age`; there is no purge | [Edge-cache staleness](docs/dev/troubleshooting.md#edge-cache-staleness) |
| Every read answers 500 | D1 daily read allowance (the 21 Oct 2026 crawler outage); filter links must stay `nofollow` | [D1 read limits](docs/dev/troubleshooting.md#d1-read-limit-exhaustion) |
| Works in `astro dev`, broken in production | CSP violations in the browser console of the preview build | [CSP failures](docs/dev/troubleshooting.md#csp-failures-on-the-site) |
| CORS errors in the browser | Origin vs the API's `SITE_URL` (exact match) | [CORS from localhost](docs/dev/troubleshooting.md#cors-errors-from-localhost) |
| No emails | `notifications.status` (`skipped` = no key); `POST /v1/admin/email-test` | [Emails not sending](docs/dev/troubleshooting.md#emails-not-sending) |
| GitLab tag ignored | the source's webhook token, the OAuth `api` scope, job-token pushes | [GitLab problems](docs/dev/troubleshooting.md#gitlab-webhook-and-token-problems) |
| `ot install` exits 4 | signer identity in the manifest response vs the image's signature | [cosign failures](docs/dev/troubleshooting.md#cosign-verify-failures-in-ot-exit-4) |
| Install fails though a mirror copy exists | the original's error type: network errors never fall back | [Mirror fallback](docs/dev/troubleshooting.md#mirror-fallback-not-triggering) |
| `ot` misbehaves on a user's machine | `ot doctor` (exits 5 when any check fails) | [`ot doctor`](docs/dev/troubleshooting.md#ot-doctor) |
| An agent or script run stops with `consent_required`, or a token gets `insufficient_scope` | `ot mcp policy`, `ot mcp audit`, `--yes`; the token's scopes | [Agents and unattended runs](docs/dev/troubleshooting.md#agents-and-unattended-runs) |

## Known gaps and tech debt

Found while checking this guide against the code in October 2026. None of these is fixed yet; each is worth its own
change. Keep this list current when you fix one or find another.

**Security and correctness**

- Takedowns lag in the edge cache: the wheel copy route sends `max-age=86400`, exact-version manifests 3600 s and
  `/removed` 600 s (plus the CLI's own cache), though `scheduleDeletion` says serving stops at once.
- The mirror hides a single taken-down image only partly: its blobs and `tags/list` are still served (the blob check
  looks only at a repository-wide marker). The same goes for a publisher's unreleased (`pending/`) image: its manifest
  is hidden, but its blobs are readable by anyone who knows their digests.
- The write rate limit skips everything registered by `authRoutes` (`POST /me/tokens`, logout, device login), though
  its comment says tokens are covered; CORS credentials work only for the exact `SITE_URL`, not `www.`.
- Jobs that fail after the last retry become `error` and never reach the stuck-job alert, despite `failJob`'s comment.
- `expireStaleScans` leaves the commit status pending and sends no email.
- `sendEmail` records `sent` before calling Resend, so a thrown fetch loses the email silently; failed emails are never
  retried.
- Review: nothing moves a namespace out of `rejected` or `suspended`; a report can be resolved twice.
- A pinned signer of a package published directly can't be changed by its owner (a reviewer has to clear
  `signer_identity` on its versions by hand), and only keyless signatures count.
- Trusted publishing accepts only github.com Actions and gitlab.com CI (not GitHub Enterprise or self-managed GitLab
  issuers). A package published only from CI has no `sources` row, so it gets no git backups or sync. A GitLab job has
  one ID token, so if the answer to its exchange is lost, `ot publish --oidc` can't retry in that job
  (`oidc_token_reused`).
- `tools_fts` triggers fire only on `tools`, so renaming a namespace leaves the old name in search.
- Redelivering a GitHub webhook is a no-op once the first delivery created a job.
- `ot install` doesn't warn about deprecated packages (the manifest response doesn't carry deprecation).
- The install scripts ask `api.github.com` for the latest release without a token (60 requests an hour per IP).
  `ot self-update` and `ot outdated` ask `get.otinstaller.com/ot/latest` first and use the API only as a fallback.
- The same error code has two statuses in places (`tool_removed` 410/409, `manifest_in_repo` 409/400,
  `unknown_provider` 404/400); `manifest_name_mismatch` exists only in the API.
- `ot login --osintverse` ignores `--scope` and token expiry: the OSINTverse device poll (`pollOsintverseDevice` in
  `routes/device.ts`) mints with the default four scopes and never reads `scopes` or `expires_in_days`, unlike the
  GitHub and GitLab path. It also writes `token.create` to the audit log twice (once in `mintApiToken`, once itself).
- Namespaces that already exist with a reserved name (`api/src/lib/reserved.ts` only affects new ones) keep it; none
  did in production as of 23 Oct 2026.
- Stars are still never written (no route records one), though ranking and `stars` columns read them.
- Community: `contributor_stats` is only as fresh as the last nightly run.
- Change proposals cover `otinstaller.yaml`, the Dockerfile and the README only (not docs pages or other files). A
  proposal merged or closed on GitHub directly stays open in the registry (nothing reads `pull_request` webhooks; a
  bump closed there is only noticed by auto mode), and a merged proposal whose release fails its scan still shows as
  merged (bumps report their outcome; proposals don't yet).
- A new version's first-week counts are signed-in confirmations only; anonymous failed-run reports (`run_signals`)
  and Report a problem counts (`problem_signals`) only reach it once they open an issue.
- Bump pull requests skip wrappers that pin upstream's own image (they get an outdated issue only), and commit pins.
- The build watcher records a version's base image digest when it first sees the version, not the one it was built on,
  so a base that changed between the build and that first check is only noticed at its next change. It reads only
  exact `==` pins in `requirements.txt` and Docker Hub base images.
- The community bot creates wrapper repositories on GitHub only; a submission whose first release fails its scan
  stays `failed` until the submitter changes it.

**Docs debt**

- `api/.dev.vars.example` lacks `OPS_DISPATCH_TOKEN`, `OPS_INSTALLATION_ID`, `RESEND_API_KEY`, `R2_*` and more; the
  secrets comment in `wrangler.jsonc` lacks `HEALTH_TOKEN`, `SENTRY_DSN` and `ISSUES_TOKEN` ([config.md](docs/dev/config.md)).
- Stale comments: "within 30 days" for takedown deletion in `backups.ts` and `trust.ts` (the code uses 14);
  `release-cli.yml` says `otinstaller/ot`.
- The root `README.md` still describes `otlite/` as Linux-only; it runs on macOS too since 1.2.

**Hygiene**

- CI runs no Go, API, site or scanner tests; there is no `engines` field for Node; `cli/internal/api`, `keys`,
  `state` and `selfupdate` have no test files of their own.
- `ops/scanner/__pycache__/scan.cpython-313.pyc` is committed and the root `.gitignore` has no `__pycache__/` rule.
- `api/src/env.ts` and `index.ts` miss their opening purpose comment.
- Schema: `versions.status` allows `received`/`validating`, which nothing writes; `tools.latest_version_id` and
  `audit_log.actor_id` have no foreign key.

## Glossary

| Term | Meaning |
| --- | --- |
| Package | Anything in the registry: a tool or a guide, addressed as `<namespace>/<name>` (rows in `tools`) |
| Tool / guide | `kind: tool` (runnable, Docker or pipx) or `kind: guide` (Markdown pages, no runtime) |
| Namespace | The publisher's slug (a GitHub user or org, a GitLab group, `osintverse-community`, or a registry namespace made with `ot namespace create`). `pending_review` until a reviewer approves it, then `active` (or `rejected`, `suspended`); `verified` is a separate badge |
| Direct upload / bundle job | A release uploaded with `ot publish` (`POST /v1/publish`) instead of tagged: a `publish_jobs` row with a `bundle_key`, whose files come from R2. A package published this way has no repository (`tools.repo_url` NULL) and its signer is pinned on first use |
| Trusted publisher / CI token | A repository (optionally one workflow, environment or package) a namespace's owner trusts to publish with `ot publish --oidc` (`trusted_publishers`), and the hour-long `ot_` token restricted to that namespace a run gets for its OIDC ID token. Its upload is a bundle job that names the repository |
| Manifest | `otinstaller.yaml`, validated against `spec/schema/v1.json` |
| Registry-held manifest | A manifest stored in D1 for a repo that doesn't have one (import wizard, community wrappers); `PUT /packages/:ns/:name/manifest` edits it |
| First-party / community wrapper | Tools written by the project (`seed/first-party`) vs third-party tools packaged under `osintverse-community` (`seed/community`), which their authors can claim |
| Release workflow | The GitHub Actions or GitLab CI file from `spec/templates/` that builds, signs, bumps the version and tags |
| Publish job | One attempt to publish one tag (`publish_jobs`); a version is its result (`versions`) |
| Source | A repository linked to a package (`sources`); polled every 6 h as a webhook backstop |
| Import | The wizard that turns a repository into a draft manifest and finishes as a PR/MR, a registry-held manifest or a wrapper |
| Scan / verdict | The registry-ops job (`scan.py`) and its outcome: pass, warn (fixable critical/high vulns) or fail |
| Smoke test | The scan's sandboxed run of the manifest's `test.input`; the nightly health check runs it again |
| Possibly broken | Three failed health checks in a row (`tools.health_status = 'broken'`) |
| Issue | A public report on a package (broken, outdated, wrong_info, feature, question), with replies; system issues are filed by the registry itself (`author_kind = 'system'`) |
| Confirmation | "Works for me" or "broken for me" on a version and platform; counts, never ratings |
| Handle | The public name on someone's posts and profile (`users.handle`) |
| Triager / reviewer | Community roles staff grant: triagers triage any package's issues and moderate; reviewers also decide submissions |
| Maintainer | Someone who looks after a package: its namespace's members, plus `tool_maintainers` (a submission's submitter, others staff add) |
| Tool request | A request to package a repository (`tool_requests`), with votes; open → accepted → in progress → published, or declined |
| Submission | A community wrapper someone packaged through the wizard (`wrapper_submissions`); its first release waits for a reviewer |
| Community bot | The second GitHub App (`COMMUNITY_APP_*`), installed only on `osintverse-community`, that creates wrapper repositories and opens bump pull requests and change proposals' pull requests |
| Upstream watcher | The nightly check of each wrapper's pin against its upstream's latest release (`upstream_watch`, `UPSTREAM_WATCH`) |
| Bump pull request | The community bot's pull request changing only a wrapper's pin; maintainers merge and release it, or the registry does in auto mode, and its release ends `released` or `failed` (`bump_prs`) |
| Build watcher | The nightly check of first-party tools' PyPI dependencies and of every community-namespace build's base image (`build-watch.ts`); dependency updates and rebuilds are `bump_prs` rows of their own `kind` |
| Change proposal | A wrapper maintainer's change to its manifest, Dockerfile or README, opened as a pull request by the community bot; a reviewer who isn't the proposer approves it (`change_proposals`) |
| First week | The seven days after a version is published, when its works/broken counts are shown beside the previous version's |
| Failure prompt | `ot run`'s "Report it as broken?" after a run that failed; sends no inputs or output |
| Awaiting review | A passing version of a not-yet-approved namespace, or a guide with PII hits |
| Yank / deprecate / remove | Owner takes a version off `@latest` (an exact `@version` still installs) / owner marks a package as superseded / staff takedown (410, backups deleted after 14 days unless a legal hold) |
| Claim / transfer | Taking over a community wrapper by proving upstream ownership / moving a package between namespaces |
| Backup kinds | image (mirror), wheel (R2 copy served by the API), git (bundle in R2) |
| Mirror | `mirror.otinstaller.com`, the registry's own OCI registry; `private/` for non-OSI licenses |
| Restore drill | The monthly job that proves a random bundle restores and a random mirrored image pulls |
| registry-ops | The private repo `OTInstaller/registry-ops` whose Actions run scans, backups, drills and health checks |
| Edge cache | `caches.default` in front of anonymous API reads (`edge-cache.ts`) |
| Envelope | The normalised result `ot run` prints (`envelope.Version = 1`) |
| Typed input | A positional like `d:example.com` that maps to an input by type |
| Held | An installed package the person installed at an exact version (`held` in `state.json`): `ot update --all` leaves it, and agents never move it |
| Case | A folder under `results/` grouping saved runs (`--case`; playbooks use `playbook-<name>`) |
| Playbook | A named list of tools run against the same inputs |
| Data dir | `OT_HOME`, else `%APPDATA%\ot`, else `~/.ot`: `state.json`, `keys.json`, `cache/`, `playbooks/`, `guides/`, `agent-policy.json`, `agent-audit.jsonl` |
| Device login | `ot login`'s flow: `/auth/device/start`, then polling `/auth/device/token` for an `ot_` token |
| Scope | What an API token may do: `read`, `publish`, `manage`, `feedback`, `staff` (`api/src/scopes.ts`) |
| Consent class | How far a run reaches: passive, networked, target or personal (`agent.Classify`); decides whether an agent or an unattended run must ask |
| Consent token | A single-use `ct_...` HMAC over one exact MCP call, returned with `consent_required` and valid for 10 minutes in the same `ot mcp` process |
| Audit log | `agent-audit.jsonl` in the data dir: every install, uninstall and run by an agent or an unattended `ot run` |
| Pivot | An entity type found by one run that can feed another tool's input (`spec/pivots.json`) |
| Sample output | What the scanner's smoke test of the latest version produced, shown on the tool page |
| OSINTverse | The sister site whose OIDC sign-in the registry accepts (`hosts/osintverse.ts`) |

## User-facing and operator docs

| Where | What |
| --- | --- |
| [web/src/pages/docs/](web/src/pages/docs) | The site's docs: quick start, getting started, otlite, CLI, agents, MCP tools, automation, results, API, manifest, publishing, guides, security, errors, FAQ |
| [web/src/pages/policy/](web/src/pages/policy) | Acceptable use, privacy, takedown, terms, transparency |
| [docs/publishing-setup.md](docs/publishing-setup.md) | Operator runbook: GitHub App, OAuth apps, registry-ops, secrets, imports, guides, trust, releasing `ot`, backups |
| [docs/launch-checklist.md](docs/launch-checklist.md) | What is deployed, what was verified, what is left before launch |
| [docs/typed-inputs-and-results.md](docs/typed-inputs-and-results.md) | Design note for typed inputs, saved results, `--all`, playbooks, auto, extract/diff, outdated/update |
| [docs/agent-friendly-plan.md](docs/agent-friendly-plan.md) | Design note for `ot mcp`, consent, JSON output, scoped tokens, OpenAPI, the remote MCP server and the plugin |
| [docs/launch/](docs/launch/README.md) | Launch posts, agent directory listings, on-call rota, demo video script (drafts; each needs the owner's OK) |
| [docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md) | `otinstaller` to `ot` command map |
| [docs/beta/](docs/beta) | Beta invitation, author onboarding, feedback survey (unused: no beta ran) |
| [seed/README.md](seed/README.md) | The launch seed: every package, publish order, health risks |
| [cli/README.md](cli/README.md) | The README shipped in `ot` release archives |
| [otlite/README.md](otlite/README.md), [otlite/AGENTS.md](otlite/AGENTS.md) | otlite, the no-Docker edition |
