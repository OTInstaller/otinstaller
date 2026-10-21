# AGENTS.md

A guide for coding agents (and people) working in this repository. It explains what the project is, how the pieces fit,
how to build and test each one, and the rules that are easy to break without noticing. [README.md](README.md) and
[docs/](docs) hold the user-facing and operator-facing detail; this file is about working on the code.

This file is the entry point. The deep reference lives in [docs/dev/](docs/dev/README.md):

| Page | What's in it |
| --- | --- |
| [architecture.md](docs/dev/architecture.md) | System diagram and step-by-step flows: publish, scan, guide checks, backup, install/run, sign-in, review, takedown, edge cache, self-update |
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
them. Publishers add an `otinstaller.yaml` manifest to a GitHub or GitLab repository and push a `vX.Y.Z` tag. The registry
validates the release, has it security-scanned (tools) or content-checked (guides), sends new publishers to human review,
publishes it, and backs it up. Users then run `ot install <ns>/<name>` and `ot run <ns>/<name> ...`, which pull a
digest-pinned, cosign-verified Docker image (or a hash-pinned PyPI wheel) and run it in a locked-down container. If the
original host later refuses the artifact, `ot` falls back to the registry's own mirror or wheel copy.

The repository also holds `python/`, the older Python package manager `otinstaller`, now in maintenance (see
[python/](#python-package-manager-python)).

The registry is in **closed beta** (beta strip on the site, `ot feedback`, issues on `OTInstaller/feedback`);
[docs/launch-checklist.md](docs/launch-checklist.md) records what is deployed and what is left before launch. As of
21 Oct 2026 every beta blocker is done: `ot` v0.12.0 is released on `OTInstaller/ot` and served by
`get.otinstaller.com`, email (Resend) works, feedback goes to the public `OTInstaller/feedback` repo, GitLab publishing
works, the week 11 backup resources exist and migrations up to 0012 are applied in production. Check the checklist
for anything newer; don't restate production state here.

Production:

| Thing | Where |
| --- | --- |
| Website | `https://otinstaller.com` (`web/`, a Cloudflare Worker) |
| Registry API | `https://api.otinstaller.com/v1` (`api/`, Worker `otinstaller-registry-api`) |
| Image mirror | `https://mirror.otinstaller.com` (`api/src/mirror/`, Worker `otinstaller-mirror`, config `api/wrangler.mirror.jsonc`) |
| Install scripts | `get.otinstaller.com/ot` and `/ot.ps1` (`ops/get/`, a Worker proxying the latest `ot` release's scripts) |
| Manifest schema | `https://otinstaller.com/schema/v1.json` (served from `spec/schema/v1.json`) |
| Scanner, backups, drills, health checks | GitHub Actions in the private repo `OTInstaller/registry-ops` (copied from `ops/`) |
| `ot` releases | the public repo `OTInstaller/ot` (built from `cli/` by GoReleaser) |
| Beta feedback and bug reports | `OTInstaller/feedback` issues |

The first-party namespace is `osintverse-community` (a GitHub organisation). The launch seed in `seed/` publishes there.

## Repository layout

```
spec/        Manifest JSON Schema, valid/invalid fixtures, release workflow templates (the source of truth)
cli/         The `ot` CLI (Go 1.25+, cobra)
api/         Registry API and image mirror (TypeScript, Hono on Cloudflare Workers, D1, Queues, R2)
web/         Website (Astro 7 SSR on Cloudflare, Preact islands, strict CSP)
ops/         scanner/ (scan.py, backup.py, health.py, tests, Dockerfile), workflows/ (scan.yml, health.yml) copied
             into registry-ops, get/ (worker.js, wrangler.jsonc: the get.otinstaller.com Worker)
python/      otinstaller, the Python package manager (maintenance only; has its own AGENTS.md)
seed/        Launch seed: 11 first-party tools, 38 community wrappers, 10 guides, outreach texts
examples/    dns-lookup (scripts/e2e.sh), cosign and tldextract (the local/test seed in api/scripts/seed-lib.mjs
             and scripts/e2e-real.sh)
scripts/     e2e.sh, e2e-real.sh, e2e-backups.sh, install/ (install.sh, install.ps1, make-test-release.sh),
             beta/labels.sh, pm-catalog-to-wrappers.py
docs/        publishing-setup.md (operator runbook), launch-checklist.md, migrating-from-otinstaller.md,
             typed-inputs-and-results.md (design note), beta/ (invitation, onboarding, survey drafts),
             dev/ (developer reference, see the table above)
.github/     workflows/ (see CI below) and ISSUE_TEMPLATE/ (bug with severity, idea, config.yml contact links);
             the live issue forms are in the public OTInstaller/feedback repo
.claude/     launch.json: dev-server definitions (`web` on 4321, `web-preview` on 4322)
LICENSE      Apache 2.0 for the whole repository; python/ keeps its own LICENSE and NOTICE
```

There is no root package manager or monorepo tool. Each of `cli/`, `api/`, `web/` and `python/` is built on its own, but
they **share files from `spec/`** (see [Spec copies](#spec-is-the-source-of-truth-keep-the-copies-in-sync)), and some
tests read `spec/`, `seed/` or `examples/`, so tests must run inside a full checkout. (`scripts/pm-catalog-to-wrappers.py`
reads `python/`; no test does.)

## Requirements

- Go 1.25+ (CLI)
- Node.js 22+ (API and site); dependencies are pinned in each `package-lock.json`, install with `npm install`
- Docker Desktop or Podman (running Docker tools, sandboxed pipx tools, the e2e scripts, the scanner image)
- Python 3.12 (scanner, seed tool unit tests, the converter); Python 3.10+ on Linux for `python/`
- `cosign`, `crane` and `git` for some e2e scripts and the `ot release` tests

The main development machine is Windows. Use forward slashes in scripts, keep files LF (`.gitattributes` sets
`* text=auto eol=lf`), and don't assume `bash`-only tools exist outside Git Bash. `python/` is Linux-only.

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
| Site typecheck / tests | `cd web && npm run check` / `npm test` |
| Social image | `cd web && npm run og` (re-renders `public/og.png`) |
| Scanner tests | `python -m unittest discover ops/scanner` |
| Seed tool tests | `python -m unittest` inside a `seed/first-party/<tool>/` folder |
| python/ checks | `cd python && pip install -e ".[dev,pipeline]" && ruff check . && ruff format --check . && pytest` |
| End-to-end (Docker) | `bash scripts/e2e.sh` |
| End-to-end, real artifacts | `bash scripts/e2e-real.sh` (needs Docker, cosign and the local API running) |
| End-to-end, backups | `bash scripts/e2e-backups.sh` (Docker, cosign, crane, git, Go, Node, Python; ports 8787–8789, 5001) |
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
  get.otinstaller.com (ops/get) ---- proxies install.sh / install.ps1 from the latest OTInstaller/ot release
```

| Flow | In one line |
| --- | --- |
| Publish | tag → webhook/poll/import → `publish_jobs` row → queue → `processJob` validates, checks the artifact, renders pages → scan dispatch (tools) or content checks (guides) |
| Scan | registry-ops runs `scan.py` → `POST /internal/scans` → `verdict` → published (active namespace) or `awaiting_review` → backup plan in the answer |
| Backup | plan with signed upload URLs → `backup.py` copies image/wheel/bundle → `POST /internal/backups/:run` → `completeRun` checks what arrived |
| Install | `GET /tools/:ns/:name/:version/manifest` → pull by digest + `cosign verify` (or wheel by hash) → mirror or wheel copy only when the original host refuses |
| Run | `ContainerArgs` builds a locked-down `docker run` → output parsed into the envelope → saved under `results/` |
| Sign-in | site: OAuth → `ot_session` cookie; CLI: device flow → `ot_` API token in the keychain |

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

- `inputs[]`: `{name (^[a-z][a-z0-9_]{0,31}$), type, required, default?, description?, values?}`. Types: email, username,
  phone, domain, ip, url, name, image, crypto_address, hash, company, string, integer, boolean, enum (`enum` needs
  `values`).
- `outputs[]`: `{type}` from: account, email, username, phone, domain, subdomain, ip, url, person, organization, location,
  breach, certificate, dns_record, image, document, crypto_address, transaction, other.
- `runtime`: `kind` (`docker` | `pipx`), `command` (an **array**, never a shell string, with `{input_name}` placeholders),
  `output_format` (json | jsonl | csv | text), `timeout_seconds` (default 300).
  - docker: `image` pinned by digest (`...@sha256:<64 hex>`), `platforms` must include `linux/amd64`.
  - pipx: `package`, `package_version`, `entrypoint`, `wheel_sha256`; optional `index: pypi`, `python`.
- `secrets[]`: `{name (^[A-Z][A-Z0-9_]{2,63}$), required, description?, url?}`.
- `network`: `{egress, domains}`. `ethics`: `{touches_target, auth_required, collects_personal_data}` (all required).
- `test`: `{input, expect_exit_code (default 0)}`, used by the scanner's smoke test and the nightly health check.
- `docs`: `{root: "docs/", nav: ["page.md", ...]}` for tool docs.

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
| `cli` | Every command. `root.go` has the `App` struct (`Out`, `Err`, `In`, `Config`, `API`, `Runner`, `OpenURL`, `CheckRemovals`, `Updater`, `SelfPath`), exit codes, `ExitError`/`exitErr` and command registration |
| `api` | Registry HTTP client. Decodes `{"error":{...}}` into `*api.Error` (`Status`, `Code`, `Message`, `Hint`, `Docs`, `Problems`, `RequestID`) |
| `manifest` | Typed `Manifest`, `Parse`/`LoadFile`, `Validate(doc, m, Options{Tag, Dir})`, content rules, embedded schema |
| `runner` | Install and run: engine detection (docker, then podman), `Install` (with backup fallbacks), `Run`, `ContainerArgs`, input resolution, typed inputs, command building, target type detection (`detect.go` + embedded IANA `tlds.txt`) |
| `playbook` | Named tool sets: bundled `domain-recon` and `username-investigation`, plus `<ot home>/playbooks` and `./playbooks` (later wins) |
| `envelope` | The normalized result envelope (`Version = 1`) and `ParseOutput` / `Write` (json, raw, csv, table) |
| `results` | Saving each run's raw output plus `.meta.json` (and lazy `.stderr.txt`); `saved.go` reads them back for `extract` and `diff` |
| `keys` | OS keychain (service `osintverse-ot`); an env var of the same name wins; names indexed in `keys.json` |
| `state` | Data dir (`OT_HOME` → `%APPDATA%\ot` → `~/.ot`), `state.json` (atomic write, 0600, records `from_backup`), read-only `config.json` |
| `scaffold` | Files written by `ot init` (manifest, Dockerfile, starter tool, READMEs, guide pages) and embedded templates; uses `<<`/`>>` template delimiters |
| `selfupdate` | `ot self-update`: Ed25519-signed `checksums.txt`, archive SHA-256, atomic replace |

### Commands

Packages: `search`, `info`, `install`, `list`, `uninstall`, `outdated`, `update`. Running: `run`, `auto`, `playbook`,
`extract`, `diff`, `keys set|list|rm`, `doctor`. Guides: `guide search|read|open|get|tools`, `docs`. Publishing:
`init`, `validate`, `import`, `sync`, `release`, `login` (`--gitlab`, `--osintverse`), `logout`, `whoami`. Trust:
`report`, `claim`, `transfer`, `yank`, `deprecate`. Other: `feedback`, `self-update`. Cobra adds `help`, `completion`
and `--version`. The root has no persistent flags, but its `PersistentPreRun` refreshes `cache/removed.json` (daily)
and warns about installed versions that were removed. Every flag of every command, with its exit codes, is in
[docs/dev/cli.md](docs/dev/cli.md).

Each is an `(a *App) xxxCmd() *cobra.Command` method. Files: `packages.go` (search/info/install/list/uninstall),
`update.go` (outdated/update), `run_cmd.go` + `run_all.go` (run), `auto.go`, `playbook.go`, `saved.go` (extract/diff),
`run.go` (keys/doctor), `guide.go` (guide/docs), `init_validate.go`, `import.go`, `sync.go`, `release.go`, `login.go`,
`trust.go` (report/claim/transfer/yank/deprecate), `feedback.go`, `selfupdate.go`.

- `ot run` disables cobra flag parsing and parses its own args (`run_cmd.go`): ot flags (`-f/--format`, `-o`, `--out-dir`,
  `--native`, `-y`, `--results-dir`, `--case`, `--no-save`, `--all`, `--parallel`, `--dry-run` with `--all`, `--live`
  accepted as a no-op), any other `--x v` is a tool input, and positionals after the package like `u:johndoe` are typed
  inputs (`u:` username, `d:` domain, `e:` email, `p:` phone, `ip:` ip, `url:` url).
- `runAll` (`run_all.go`) is shared by `run --all`, `playbook` and `auto`: runs `--parallel` at a time, skips tools that
  can't run unattended, prints `[n/N]` progress on stderr and a summary table or JSON.
- `ot auto <target>` guesses the type (url, ip, email, phone, domain by IANA TLD, else username; `--type` overrides) and
  runs every installed tool that takes it. `ot playbook <name> <inputs>` runs a playbook (`--list`, `--dry-run`, `-y` to
  install missing tools); runs are saved under case `playbook-<name>`.
- `ot extract` and `ot diff` read saved results (indicators; the two latest runs compared). `ot outdated` / `ot update`
  compare installed packages with the registry (`update` exits 1 when an update fails).
- `ot feedback [message]` posts to `/v1/feedback` (`--kind bug|idea|question|other`, `--email`, `--about`); with no
  message it reads piped stdin, or opens `<site>/feedback`.
- `ot release <version> [path]` (`release.go`) releases **guides only**: checks a clean tree and an unused tag, rewrites
  `version:`, validates, commits `Release X` if changed, creates an annotated tag and runs `git push --atomic`.
  Tools are released by their release workflow, which builds and signs the artifact.
- Commands that need a sign-in (`whoami`, `import`, `sync`, `claim`, `transfer`) fail with exit 2 when there is no token.
- [docs/typed-inputs-and-results.md](docs/typed-inputs-and-results.md) is the design note for typed inputs, saved
  results, `--all`, playbooks, auto, extract/diff and outdated/update; [docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md)
  maps `otinstaller` commands to `ot`. Keep both in step with behaviour changes.

### Exit codes (`root.go`)

`0` ok · `1` tool error (default) · `2` bad usage or invalid manifest · `3` missing key · `4` trust refusal · `5` runtime
missing · `124` timeout · `130` interrupted. Typed errors map to them: `runner.UsageError` → 2, `runner.TrustError` → 4,
`runner.RuntimeMissingError` → 5, `runner.TimeoutError` → 124, `*cli.ExitError` → its `Code` (a nil `Err` exits
silently). Wrap registry 4xx errors with `a.requestError(err)` so they exit 2 and print problem lists. These codes are
documented to users; don't repurpose them. Caveats: errors raised by cobra itself (wrong argument count, unknown
flag) exit 1, not 2; `search`, `info`, `login`, `outdated` and `update` don't wrap registry 4xx errors, so those exit
1; `doctor` exits 5 when any check fails; `self-update` exits 4 on a failed verification. With `--no-save`, Ctrl-C
during a single run exits 1, not 130.

### Security model when installing and running tools (don't weaken it)

- Docker images must be pinned by digest. If the registry returns a signer identity, `cosign verify` must pass
  (missing cosign only warns). Wheels are matched by `wheel_sha256` from PyPI and re-hashed after download.
- Backup fallbacks: when the original registry refuses the image (401/403/404, denied, manifest unknown...), `ot` pulls
  the same digest from `mirror_image` and verifies the same signature; when PyPI answers 403/404/410 or lacks the wheel,
  it downloads `wheel_url` and checks the same SHA-256. Network errors never trigger a fallback. Tests are in
  `runner/backup_test.go`.
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

`OT_HOME`, `OT_API_URL`, `OT_SITE_URL` (`guide open`, `report`, `feedback`), `OT_NO_TELEMETRY` (any non-empty value
disables the install ping; the ping carries the bearer token when signed in), `OT_RESULTS_DIR` (legacy
`OTINSTALLER_RESULTS_DIR`; results default to `./results`, not the data dir), `OTINSTALLER_TOKEN` (overrides the
keychain token; like every key, an env var of the same name wins). `config.json` (`api_url`, `site_url`, `telemetry`,
`format`) is read, never written. Install scripts:
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
`TAP_GITHUB_TOKEN` (not offered during the beta). It publishes to `OTInstaller/ot` (the default when the variables are
unset). Archive names `ot_<ver>_<os>_<arch>.tar.gz|.zip` are relied on by `self-update`, the install scripts and the
`ops/get` Worker. `cli-install.yml` tests this whole path on PRs. Only tag a release when asked.

---

## API (`api/`)

Two Workers from one folder:

- `otinstaller-registry-api` (`wrangler.jsonc`, `main: src/index.ts`), a Hono app with base path `/v1`. Bindings: D1 `DB`
  (`otinstaller`), R2 `CONTENT` (`otinstaller-content`: rendered pages and images), R2 `BACKUPS` (`otinstaller-backups`:
  git bundles and wheels), R2 `MIRROR` (`otinstaller-mirror`, shared with the mirror), queue `PUBLISH_QUEUE`
  (`otinstaller-publish`), var `MIRROR_HOST`. Crons: `17 3 * * *` (nightly), `*/15 * * * *`, `41 4 * * 1` (weekly
  backups), `23 5 1 * *` (monthly restore drill).
- `otinstaller-mirror` (`wrangler.mirror.jsonc`, `main: src/mirror/index.ts`): an OCI distribution registry on R2 at
  `mirror.otinstaller.com`. Anonymous public pulls; pushes, deletes and `private/` pulls need `MIRROR_PUSH_TOKEN`.

There are no wrangler `env` blocks; the files are production config. Secrets are listed in the wrangler comments and
`src/env.ts`. For local runs copy `.dev.vars.example` to `.dev.vars` (never commit it). The example predates the backup
and beta work, so `R2_*`, `ISSUES_REPO`/`ISSUES_TOKEN` and `EDGE_CACHE` are only in `env.ts`.

### Source layout (`api/src/`)

| Path | Responsibility |
| --- | --- |
| `index.ts` | App setup, CORS (credentialed only when `Origin` equals `SITE_URL` exactly, so not `www.`), auth middleware, write rate limit (30/min per signed-in non-staff user on non-GET requests; registered after `authRoutes`, so auth, token and device routes aren't limited), public read routes, `onError`/`notFound`, default export `{ fetch, queue, scheduled }` (fetch wrapped in `edgeCached`). Exporting anything but the handlers from this file makes workerd refuse to start, and vitest won't catch it |
| `edge-cache.ts` | Edge cache for anonymous reads (see below) |
| `env.ts` | `Env`, `PublishMessage`, `User`, `deps.fetch` (all outbound HTTP), `requireSecret` |
| `catalog.ts` | Shared public-read SQL (`VISIBLE`, `LISTED`, `summary()`, `findTool()` with aliases, `cached()`) |
| `ranking.ts` | Search score (bm25 + installs + stars + health + verified − broken − registry-held) |
| `publish.ts` | Queue consumer `handleBatch` and the release validation pipeline `processJob` |
| `scans.ts` | `dispatchOps` / `dispatchScan` to registry-ops, `verdict`, `applyScanResults`, `publishVersion`, commit statuses, scan timeouts |
| `backups.ts` | Backup plans, runs and items, signed upload/download URLs, weekly runs, backfill, takedown deletion and legal holds, restore links, restore drills |
| `guides.ts` / `content.ts` | Guide and docs rendering (marked + sanitizer), R2 storage, link checks, URL Scanner, PII heuristics |
| `sync.ts` | Keeping packages in sync with repos: 6-hourly poll, tag queuing, renames/archives/deletes |
| `imports.ts` | Import wizard: detection, draft manifests, finishing as PR/MR, registry-held manifests, community wrappers, bulk (≤50), the `REDISTRIBUTABLE` license list |
| `trust.ts` / `transfers.ts` | Yank, deprecate, removal, reports, transparency, rate limits; claims and transfers |
| `notify.ts` | Resend email with idempotency keys (`notifications` table); skipped when `RESEND_API_KEY` is unset |
| `ops.ts` | Health targets/results, stuck-job alerts, daily digest, rate-limit purge, Sentry `reportError` |
| `mirror/` | The mirror Worker: `index.ts` (entry) and `registry.ts` (OCI API, `imageExists`, `hideImage`, `deleteImage`) |
| `hosts/` | External services: `github.ts`, `gitlab.ts`, `osintverse.ts` (OIDC), `repo.ts` (`RepoHost` over both), `artifacts.ts` (OCI digest and PyPI wheel checks) |
| `lib/` | `errors.ts` (`apiError`), `crypto.ts` (hashing, AES-GCM, RS256 JWT, `ulid()`), `manifest.ts` (validator), `images.ts` (metadata stripping, SVG sanitizing), `presign.ts` (R2 SigV4 URLs) |
| `routes/` | One `xxxRoutes(app)` registrar per area: auth, device, webhooks, review, sources, imports, guides, trust, transfers, backups, beta, ops |
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

- Public: `GET /health`, `/types`, `/tools` (search: `q`, `input`, `output`, `category`, `runtime`, `kind`, `level`,
  `format`, `lang`, `sort`, `no_keys`, `limit`, `cursor`), `/guides`, `/tools/:ns/:name[/versions|/:version[/manifest|/scans|/wheel/:file]]`,
  `/namespaces/:ns`, `/pivots`, `/removed`, guide pages, tool docs, readmes, `/assets/:sha256.ext`; `POST /installs`,
  `POST /feedback`. The manifest response includes `mirror_image` / `wheel_url` install fallbacks for public backups.
- Auth: `/auth/:provider/login|callback` (github, gitlab, osintverse), `/auth/logout`, `/auth/device/start|token`,
  `/me`, `/me/tokens`, `/me/publish-jobs`, `/me/repos`, `/me/transfers`, `/me/backups`.
- Publishing: `POST /webhooks/github` (HMAC), `POST /webhooks/gitlab` (per-source token), `/imports...`,
  `/sources/gitlab`, `/packages/:ns/:name/sync|sync-log|manifest|manifest/pr|source|backups|backups/restore`.
- Owners: yank/unyank, deprecate, claim, transfer, git-backup opt-out, restore, switch source. Anyone: reports, feedback.
- Staff (`/admin/...`): review queue, namespace approve/request-changes/reject/verify/suspend, version approve/reject,
  reports, removals, legal holds, audit log, transfers, bans, feedback triage, beta metrics, manual backups, restore
  drills, `POST /admin/email-test` (checks the Resend key).
- Internal: `POST /internal/scans` (scanner callback; on a pass it answers with a backup plan),
  `/internal/backups/objects/*` (signed PUT/GET when R2 credentials aren't set), `POST /internal/backups/:run`,
  `POST /internal/drills/:id`, `/internal/health[/targets]`. Scans, backup runs and drills each use their own
  single-use token (scan 1 h, run 3 h or 12 h weekly, drill 6 h); the health endpoints use the static shared
  `HEALTH_TOKEN`.
- The full route table (99 routes, with auth and caching for each) is in [docs/dev/api.md](docs/dev/api.md).

### Publish pipeline

1. A tag webhook (or the poller, or an import) creates a `publish_jobs` row and queues `{ jobId }`.
2. `processJob` reads `otinstaller.yaml` at the tagged commit (or the registry-held manifest), validates it, checks
   release rules (`manifest_tag_mismatch`, `manifest_version_exists`, `manifest_name_taken`, `namespace_not_allowed`, ...),
   checks the artifact exists (`hosts/artifacts.ts`), renders README/docs/guide pages to R2, and sets a pending
   `otinstaller/publish` commit status.
3. Tools: `dispatchScan` sends a `repository_dispatch` (`otinstaller-scan`) to `OPS_REPO` with everything under
   `client_payload.scan`. The scanner posts back to `/internal/scans`. `verdict` fails on signature mismatch/dropped,
   malware, secrets, or a failed smoke test; fixable critical/high vulns warn.
   Guides: `runContentChecks` checks every external link (and URL Scanner when configured) and runs PII heuristics.
4. Pass/warn: published right away if the namespace is `active`, otherwise `awaiting_review` until a reviewer approves the
   namespace. PII hits in a guide always go to review. Emails go out at each step.
5. Backups: a passing scan's callback answer tells the scanner to back up right away; versions published another way
   (namespace approval, guides) queue `{ backupVersionId }`. See below.
6. Every 15 minutes: expire stale scans (1 h), poll due sources, alert on jobs stuck > 30 min, expire backup runs and
   drills, backfill up to 5 versions with no backup. `scheduled()` runs this block on **every** trigger, including the
   nightly, weekly and monthly ones. Nightly also: guide link rechecks (> 20% dead → needs update), the
   reviewer digest, rate-limit purge, backup purge, `installs_30d` recompute.

Queue messages (`PublishMessage` in `env.ts`): `{ jobId }`, `{ importId }`, `{ checkVersionId, attempt? }`,
`{ linkCheckToolId }`, `{ publishVersionId }`, `{ backupVersionId }`; anything else is treated as `{ jobId }`. Transient
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
(0010), backups (`backup_runs`, `backups`, `restore_drills`, tool `git_backups`/`legal_hold`/`legal_hold_reason`, 0011)
and `feedback` (0012). That is 33 tables plus `tools_fts`; every table, column, CHECK value set and status transition is
in [docs/dev/database.md](docs/dev/database.md).

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
stored. Provider tokens are AES-GCM encrypted with `TOKEN_ENC_KEY`. Accounts link only by signing in while signed in,
never by email. Use `requireUser` (401), `requireReviewer` / `requireAdmin` (403, in `routes/review.ts`) and
`requireMember` (`routes/sources.ts`). Staff are `users.is_reviewer` / `users.is_admin`.

### API conventions

- Errors: `apiError(status, code, message, hint?)` throws; the body is
  `{ error: { code, message, hint, docs: "https://otinstaller.com/docs/errors#<code>" } }`. Codes are snake_case;
  messages are short lowercase sentences; hints usually name an `ot` command or a sign-in link (the site makes hint
  links clickable). Multi-problem responses add `problems`. Unhandled errors become 500 `internal_error` with a
  `request_id` (the `cf-ray` header) and go to Sentry. If you add a user-facing code, document it in
  `web/src/pages/docs/errors.md`.
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
  what it owns and where related logic lives (`env.ts`, `index.ts` and `lib/errors.ts` don't yet); exported functions get `/** */` docs; sections use
  `// ---------- name ----------`. Double quotes, semicolons, two-space indent, long lines are normal here.

### API tests (`api/test/`)

`vitest.config.ts` uses `@cloudflare/vitest-plugin`, so tests run in workerd against the bindings from `wrangler.jsonc`
with fake secrets and `EDGE_CACHE: "off"`. The config also builds `TEST_SEED` (from `scripts/seed-lib.mjs`),
`TEST_FIXTURES` and `TEST_TEMPLATES` (from `spec/`); `test/setup.ts` applies the migrations and, when `tools` is empty,
the seed. Helpers in `test/helpers.ts`: `fakeHosts(routes)` (keys like `"GET https://api.github.com/..."`,
longest prefix wins, unmatched requests get status 599), `testEnv()` (a generated GitHub App key, cached per file; a fake queue collecting messages into
`sent`), `call(path, init, env?)`, `webhook(event, payload)`. `test/fixtures.ts` has `ghUser`, `installation`, `tagEvent`,
`manifestFor`, `fakeRelease`. Signed-in users are usually inserted directly into D1 with an `ot_test_<id>` token. Test
files are named by plan week (`week4` publish intake, `week5` scans/review, `week6` GitLab/sync, `week7` imports,
`week8` guides/content, `week10` trust/ops, `week11` backups and mirror, `week12` feedback/beta/test email) plus
`api.test.ts`, `edge-cache.test.ts`, `osintverse.test.ts`, `community-provenance.test.ts`; add tests to the file for
that area. The rate-limit test in `week10` waits for the start of a minute, so a slow run is expected.

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
  `dashboard`, `import`, `feedback`, `settings/accounts`, `transfers/[id]`, `admin/[...section]`, `docs/*.md`,
  `policy/*`, `removed.astro`, `404.astro`, `500.astro` (API trouble, shows the request ID), `robots.txt.ts`,
  `sitemap.xml.ts`. Only `schema/v1.json.ts` is prerendered.
- `src/layouts/`: `Base.astro` (HTML shell, beta strip, header/footer, the one inline script, global client JS for copy
  buttons, reveal-on-scroll, count-up, staff link), `Docs.astro`, `Policy.astro`.
- `src/components/*.astro`: server components (ToolCard, ToolHeader, Results, PageReader, Terminal, InstallTabs,
  BetaNotice, Badges, CopyCode, CopyCommand, FeatureCard, Logo, PageHead, Pipeline, SideNav, Stat, ThemeToggle).
- `src/islands/*.tsx`: Preact islands for anything signed-in or interactive (AdminConsole with review, reports,
  transfers, audit, feedback and beta tabs; Dashboard; Backups (used by Dashboard); ImportWizard, Accounts, ClaimFlow, TransferView,
  ReportForm, FeedbackForm, VersionActions, SearchDialog). `shared.tsx` has `useMe`, `SignIn`, `ErrorNote`, `Status`, `Loading`.
- `src/lib/`: `api.ts` (the only fetch helper: `api<T>()`, `apiOrNull`, `ApiError`, `signInUrl`, response types, and the
  `BETA` / `ISSUES_URL` settings), `page.ts` (`cacheFor`, `searchFrom`, `withParam`), `tool.ts` (`loadTool` handles
  404/410/moved/guide redirects), `theme-boot.ts`, `format.ts` (+ `format.test.ts`, including `hintParts`).
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
- Install instructions appear in both `InstallTabs.astro` and `docs/getting-started.md`; Homebrew, Scoop and Go installs
  are hidden until after the beta.
- HTML from the registry (READMEs, guide pages) is already sanitized server-side and rendered with `set:html`; don't
  render other untrusted HTML that way.
- Every component and island file opens with a one-line purpose comment (`Badges.astro` and `ToolCard.astro` are
  missing theirs).

### Local environments

- Production API holds the published seed (most of `seed/`) plus the beta dry-run packages, and sits behind the edge
  cache; staging (`staging-api.otinstaller.com`) only works
  while a tunnel to someone's local `wrangler dev` is up, so it's usually down.
- From a `localhost` origin, browser-side calls to the production API with credentials (`/me`, quick search) fail CORS.
  That is expected, not a site bug.
- For a full local check: run the API (`npx wrangler dev --var SITE_URL:http://127.0.0.1:<site port>` in `api/`, seeded)
  and build the site with `PUBLIC_API_URL=http://127.0.0.1:8787`. Details in
  [docs/dev/local-setup.md](docs/dev/local-setup.md).

---

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
  `/ot.ps1`, `/install.ps1` to the latest release's scripts on `OTInstaller/ot` (cached 5 minutes), answers upstream
  errors with a script that fails loudly, and redirects other paths to the getting-started docs. Deploy with
  `npx wrangler deploy` from `ops/get` (only when asked). It has no automated test.

## Seed (`seed/`)

Each folder becomes its own repository under `osintverse-community`; see [seed/README.md](seed/README.md) for the full
table, publish order (namespace → tools → guides), what was not converted and why, and health risks.

- `first-party/<tool>/` (11): a single stdlib-first Python script (`<snake_name>.py`, argparse, `main(argv=None)` returning
  an exit code, prints `{"entities": [...]}`), `test_<snake_name>.py` (unittest, no network), a `python:3.12-slim`
  Dockerfile running as uid 10001, `otinstaller.yaml` with a zero-digest placeholder the release workflow fills in,
  `README.md`, MIT `LICENSE`, and `.github/workflows/otinstaller-release.yml` (identical to
  `spec/templates/github-docker.yml`).
- `community/<tool>/` (38): wrappers of third-party tools. Docker wrappers pin the upstream version in a Dockerfile and
  build amd64+arm64; pipx wrappers are just a manifest pinning the wheel by `wheel_sha256` plus a README crediting
  upstream. The upstream license must be in the API's `REDISTRIBUTABLE` list (`api/src/imports.ts`), which includes the
  AGPL; GHunt (needs a Google login) and blackbird (no license) are outreach only. 11 wrappers were converted from the
  `python/` catalog by `scripts/pm-catalog-to-wrappers.py` (`--dry-run`, `--offline`; it never overwrites a folder);
  git-pinned ones use versions like `0.0.0-git.<commit>`.
- `guides/<guide>/` (10): `otinstaller.yaml` (`kind: guide`, CC-BY-4.0), `docs/index.md` + numbered pages, README,
  LICENSE.md. Guides have no release workflow: release them with `ot release X.Y.Z` (or a plain `git tag vX.Y.Z && git
  push`), never through GitHub Actions.
- `outreach/`: issue and PR texts for upstream maintainers.
- The bundled playbooks' tools must exist in the seed (`TestBundledToolsAreSeeded`), and every seed manifest must
  validate (`TestSeedManifests`).
- Updating a pipx wrapper: change `version`, `package_version` and `wheel_sha256` (from `https://pypi.org/pypi/<pkg>/json`).

## Python package manager (`python/`)

`otinstaller` (PyPI, version 0.1.1) is the earlier, Linux-only package manager: it installs tools by name into per-tool
virtualenvs from the catalog in `python/src/otinstaller/data/registry.yaml`. It is in **maintenance: security fixes only
until 2027-06-30**, and prints an end-of-life notice (`OTINSTALLER_NO_DEPRECATION_WARNING=1` hides it). New work goes
into `ot`; the `ot` alias was removed from this package. Users move with
[docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md).

- **Read [python/AGENTS.md](python/AGENTS.md) before touching anything in `python/`.** Its rules apply there and differ
  from the rest of the repo: the package and command are `otinstaller`; no "OSINT" in package/command names or CLI help;
  Typer (with click), Rich, PyYAML, sentry-sdk and the standard library only (ask before adding dependencies); pip or git installs, one venv per
  tool; never `shell=True`; never log API key values; no emojis; neutral metadata; short lowercase imperative commit
  messages; run `ruff check .`, `ruff format --check .` and `pytest` after every change.
- Layout: `src/otinstaller/` (`cli.py` thin Typer layer, `registry.py`, `installer/`, `runner.py`, `results.py`,
  `keys.py`, `crash_reports.py`, `deprecation.py`, `data/`), `tests/` (run from `python/`; network tests need
  `RUN_NETWORK_TESTS=1`), `pipeline/` (discover and verify candidate tools; a human merges approved entries),
  `registry/` (denylist and pipeline output), `debian/` (Debian/Kali packaging), `docs/`, `scripts/readme_tools.py`
  (regenerates the README tool list; a test fails when it's stale).
- Crash reports are opt-in Sentry with scrubbing; tests and the Debian build force `DO_NOT_TRACK=1`. Keep it that way.
- `python/LICENSE` is Apache 2.0 with a `NOTICE` that redistributions must keep.
- Known leftovers from the alias removal: `python/llms.txt`, the README quick start, `debian/tests/control` and
  `debian/otinstaller.1` still mention `ot`.
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
- `scripts/install/make-test-release.sh`: a locally signed release for testing the install scripts (used by CI).
- `scripts/beta/labels.sh`: creates the issue labels (`sev-1..3`, `needs-triage`, `beta`, `area:*`) with `gh` (only when
  asked: it changes a GitHub repo).

## CI (`.github/workflows/`)

| Workflow | Runs on | What it does |
| --- | --- | --- |
| `cli-install.yml` | PRs and pushes to main touching `cli/**`, `scripts/install/**`, `cli-install.yml` or `release-cli.yml`; `workflow_dispatch` | GoReleaser snapshot with the real config, archive contents check, then installs with `install.sh` / `install.ps1` on Linux (x64, arm), macOS and Windows and runs `ot --version`, `search`, `info`, `doctor`, and on Linux (x64 and arm) a real install/run |
| `release-cli.yml` | `v*.*.*` tags | Releases `ot` (see above) |
| `python-ci.yml` | pushes and PRs touching `python/**` | ruff and pytest on Ubuntu × Python 3.10–3.14, Debian, Arch; a Kali `.deb` build and install; a Playwright browser tool check |
| `python-nightly.yml` | 02:00 UTC daily; `workflow_dispatch` | ruff, python pipeline verify (20 candidates), an installed-tool contract test and the full python test suite |
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
5. `go test ./...` in `cli`, `npm test` in `api`.

**Changing a release template**: edit `spec/templates/`, run `go generate ./...` in `cli` and `npm run sync:templates`
in `api`, keep the GitLab merge-request text in `api/src/imports.ts` in step, and update the copies under
`seed/*/*/.github/workflows/` if the seed should pick it up.

**Adding an API endpoint**: put it in the matching `routes/*.ts`, logic in the domain module, outbound calls through
`deps.fetch`, errors through `apiError`, the right caching (`public` lands in the edge cache), a test in the matching
test file, and if the CLI or site uses it, the client in `cli/internal/api` or `web/src/lib/api.ts`. User-visible
behaviour belongs in `web/src/pages/docs/`.

**Adding a CLI command**: an `xxxCmd()` method registered in `Root()`, output via `a.Out`/`a.Err`, typed errors for exit
codes, a test with `newTestApp`, an entry in `web/src/pages/docs/cli.md`, and in `cli/README.md` /
`docs/typed-inputs-and-results.md` where relevant.

**Changing what the scanner receives or reports**: `api/src/scans.ts` / `backups.ts`, the matching route parser,
`ops/scanner/*.py` and their tests, and a note that registry-ops needs the new copy.

**Changing the site's look or motion**: tokens first, no inline styles or scripts, test both themes and reduced motion,
and verify in the preview build.

## Git and commits

- `main` is the default branch. Work happens on a `claude/<topic>` branch. Since PR #2 nearly everything lands as a
  GitHub pull request (`Merge pull request #N from OTInstaller/claude/<topic>`); older work was merged locally with a
  no-ff `Merge claude/<topic> (short description)`. Fetch first: `origin/main` moves often, and bring it in with a
  merge (`Merge origin/main`), not a rebase of shared branches.
- Commit subjects: imperative, sentence case, no trailing period, no conventional-commit prefixes. An area prefix is
  common: `Seed:`, `Scanner:`, `Web:`, `Site:`, `Backups:`, `Edge cache:`, `Admin API:`, `Install scripts:`,
`Release workflow:`, `ot run:`, `ot feedback:`, `Launch checklist:`, `AGENTS.md:`. British spelling is used
  ("Honour", "organisation"). Backticks for commands are fine. Inside `python/`, follow its own style (short, lowercase,
  imperative).
- Bodies: a short paragraph on why, then `- ` bullets in plain prose, wrapped at about 115 characters.
- `Release X.Y.Z` is reserved for release commits made by workflows and `ot release`.
- Don't add AI or tool attribution (no `Co-Authored-By` trailers, no "Generated with ..." lines) anywhere: commits, PRs,
  code, or docs.
- Don't commit `.dev.vars`, `.env.development`, `bin/`, `dist/`, `results/`, `.wrangler/` or
  `examples/dns-lookup/otinstaller.yaml` (all gitignored), nor `__pycache__/` (ignored only inside `python/` and
  `seed/`; one `.pyc` under `ops/scanner/` is committed by mistake).

## Things that need explicit permission

These affect production or other people, so do them only when asked: `npm run deploy` / `wrangler deploy` (api, mirror,
web or `ops/get`), `wrangler d1 ... --remote`, `wrangler secret put`, pushing `v*` tags on this repo (releases `ot`),
pushing tags or running workflows on seed repositories (publishes packages), publishing `python/` to PyPI, posting
outreach issues or PRs, running `scripts/beta/labels.sh`, sending beta emails, triggering backups or drills on
production, and changing GitHub App, OAuth, R2 or registry-ops settings. The operator runbook for all of these is
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

## Known gaps and tech debt

Found while checking this guide against the code in October 2026. None of these is fixed yet; each is worth its own
change. Keep this list current when you fix one or find another.

**Security and correctness**

- Takedowns lag in the edge cache: the wheel copy route sends `max-age=86400`, exact-version manifests 3600 s and
  `/removed` 600 s (plus the CLI's own cache), though `scheduleDeletion` says serving stops at once.
- The mirror hides a single taken-down image only partly: its blobs and `tags/list` are still served (the blob check
  looks only at a repository-wide marker).
- The write rate limit skips everything registered by `authRoutes` (`POST /me/tokens`, logout, device login), though
  its comment says tokens are covered; CORS credentials work only for the exact `SITE_URL`, not `www.`.
- Jobs that fail after the last retry become `error` and never reach the stuck-job alert, despite `failJob`'s comment.
- `expireStaleScans` leaves the commit status pending and sends no email.
- `sendEmail` records `sent` before calling Resend, so a thrown fetch loses the email silently; failed emails are never
  retried.
- `/me/publish-jobs` joins `installations`, so GitLab publishers never see their jobs; the commit status "Details"
  link `/dashboard/publish/<jobId>` has no page in `web/`.
- Review: request-changes and reject leave the waiting jobs at `awaiting_review`; nothing moves a namespace out of
  `rejected` or `suspended`; a report can be resolved twice.
- `tools_fts` triggers fire only on `tools`, so renaming a namespace leaves the old name in search.
- Redelivering a GitHub webhook is a no-op once the first delivery created a job.
- `ot install` doesn't warn about deprecated packages (the manifest response doesn't carry deprecation).
- `ot self-update` and the install scripts ask `api.github.com` for the latest release without a token (60 requests an
  hour per IP).
- The same error code has two statuses in places (`tool_removed` 410/409, `manifest_in_repo` 409/400,
  `unknown_provider` 404/400); `manifest_name_mismatch` exists only in the API.

**Docs debt**

- 72 of the API's 97 error codes have no entry in `web/src/pages/docs/errors.md`, although every error links there
  (list in [docs/dev/api.md](docs/dev/api.md#every-code)).
- `web/src/pages/docs/cli.md` lacks exit code 130 and many flags (all of `import`, most of `init`, several on `run`,
  `auto`, `playbook`); list in [docs/dev/cli.md](docs/dev/cli.md#7-docs-drift-websrcpagesdocsclimd-and-clireadmemd).
- `api/.dev.vars.example` lacks `OPS_DISPATCH_TOKEN`, `OPS_INSTALLATION_ID`, `RESEND_API_KEY`, `R2_*` and more; the
  secrets comment in `wrangler.jsonc` lacks `HEALTH_TOKEN`, `SENTRY_DSN` and `ISSUES_TOKEN` ([config.md](docs/dev/config.md)).
- `docs/launch-checklist.md` contradicts itself (week 11 row still "Not deployed"; 79 vs 81 failed notifications; the
  intro names a merged branch).
- Stale comments: "within 30 days" for takedown deletion in `backups.ts` and `trust.ts` (the code uses 14);
  `web/astro.config.mjs` says Cloudflare Pages (it is a Worker); `release-cli.yml` says `otinstaller/ot`.
- `python/`: the `ot` leftovers listed above, and `python/pyproject.toml` URLs still point at the old
  `OSINTVerseHQ/OTinstaller` repository.

**Hygiene**

- CI runs no Go, API, site or scanner tests; there is no `engines` field for Node; `cli/internal/api`, `keys`,
  `state` and `selfupdate` have no test files of their own.
- `ops/scanner/__pycache__/scan.cpython-313.pyc` is committed and the root `.gitignore` has no `__pycache__/` rule.
- `api/src/env.ts`, `index.ts`, `lib/errors.ts`, `web/src/components/Badges.astro` and `ToolCard.astro` miss their
  opening purpose comment.
- Schema: `versions.status` allows `received`/`validating`, which nothing writes; `tools.latest_version_id` and
  `audit_log.actor_id` have no foreign key.
- The `week10` write-limit test is flaky under load.

## Glossary

| Term | Meaning |
| --- | --- |
| Package | Anything in the registry: a tool or a guide, addressed as `<namespace>/<name>` (rows in `tools`) |
| Tool / guide | `kind: tool` (runnable, Docker or pipx) or `kind: guide` (Markdown pages, no runtime) |
| Namespace | The publisher's slug (a GitHub user or org, a GitLab group, or `osintverse-community`). `pending_review` until a reviewer approves it, then `active` (or `rejected`, `suspended`); `verified` is a separate badge |
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
| Case | A folder under `results/` grouping saved runs (`--case`; playbooks use `playbook-<name>`) |
| Playbook | A named list of tools run against the same inputs |
| Data dir | `OT_HOME`, else `%APPDATA%\ot`, else `~/.ot`: `state.json`, `keys.json`, `cache/`, `playbooks/`, `guides/` |
| Device login | `ot login`'s flow: `/auth/device/start`, then polling `/auth/device/token` for an `ot_` token |
| OSINTverse | The sister site whose OIDC sign-in the registry accepts (`hosts/osintverse.ts`) |

## User-facing and operator docs

| Where | What |
| --- | --- |
| [web/src/pages/docs/](web/src/pages/docs) | The site's docs: getting started, CLI, manifest, publishing, guides, security, errors, FAQ |
| [web/src/pages/policy/](web/src/pages/policy) | Acceptable use, privacy, takedown, terms, transparency |
| [docs/publishing-setup.md](docs/publishing-setup.md) | Operator runbook: GitHub App, OAuth apps, registry-ops, secrets, imports, guides, trust, releasing `ot`, backups |
| [docs/launch-checklist.md](docs/launch-checklist.md) | What is deployed, what was verified, what is left before launch |
| [docs/typed-inputs-and-results.md](docs/typed-inputs-and-results.md) | Design note for typed inputs, saved results, `--all`, playbooks, auto, extract/diff, outdated/update |
| [docs/migrating-from-otinstaller.md](docs/migrating-from-otinstaller.md) | `otinstaller` to `ot` command map |
| [docs/beta/](docs/beta) | Beta invitation, author onboarding, feedback survey |
| [seed/README.md](seed/README.md) | The launch seed: every package, publish order, health risks |
| [cli/README.md](cli/README.md) | The README shipped in `ot` release archives |
| [python/README.md](python/README.md), [python/AGENTS.md](python/AGENTS.md) | The legacy Python package |
