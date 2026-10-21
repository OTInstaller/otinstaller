# AGENTS.md

A guide for coding agents (and people) working in this repository. It explains what the project is, how the pieces fit,
how to build and test each one, and the rules that are easy to break without noticing. [README.md](README.md) and
[docs/](docs) hold the user-facing and operator-facing detail; this file is about working on the code.

## What this is

**OTInstaller Registry** is a free, public registry of OSINT tools and guides, plus `ot`, the CLI that installs and runs
them. Publishers add an `otinstaller.yaml` manifest to a GitHub or GitLab repository and push a `vX.Y.Z` tag. The registry
validates the release, has it security-scanned (tools) or content-checked (guides), sends new publishers to human review,
and publishes it. Users then run `ot install <ns>/<name>` and `ot run <ns>/<name> ...`, which pull a digest-pinned,
cosign-verified Docker image (or a hash-pinned PyPI wheel) and run it in a locked-down container.

Production:

| Thing | Where |
| --- | --- |
| Website | `https://otinstaller.com` (`web/`, a Cloudflare Worker) |
| Registry API | `https://api.otinstaller.com/v1` (`api/`, a Cloudflare Worker) |
| Manifest schema | `https://otinstaller.com/schema/v1.json` (served from `spec/schema/v1.json`) |
| Scanner and health checks | GitHub Actions in the private repo `OTInstaller/registry-ops` (copied from `ops/`) |
| `ot` releases | the public repo `otinstaller/ot` (built from `cli/` by GoReleaser) |
| Install scripts | `get.otinstaller.com/ot` and `get.otinstaller.com/ot.ps1` (from `scripts/install/`) |

The first-party namespace is `osintverse-community` (a GitHub organisation). The launch seed in `seed/` publishes there.

## Repository layout

```
spec/        Manifest JSON Schema, valid/invalid fixtures, release workflow templates (the source of truth)
cli/         The `ot` CLI (Go 1.25+, cobra)
api/         Registry API (TypeScript, Hono on Cloudflare Workers, D1, Queues, R2)
web/         Website (Astro 7 SSR on Cloudflare, Preact islands, strict CSP)
ops/         Scanner (scan.py, health.py, Dockerfile) and the workflows copied into registry-ops
seed/        Launch seed: 11 first-party tools, 27 community wrappers, 10 guides, outreach texts
examples/    Small real packages used by the end-to-end scripts
scripts/     e2e.sh, e2e-real.sh, install/install.sh, install/install.ps1
docs/        publishing-setup.md (operator runbook), typed-inputs-and-results.md (design note)
.github/     release-cli.yml (the only CI workflow in this repo)
.claude/     launch.json: dev-server definitions (`web` on 4321, `web-preview` on 4322)
```

There is no root package manager or monorepo tool. Each of `cli/`, `api/` and `web/` is built on its own, but they
**share files from `spec/`** (see [Spec copies](#spec-is-the-source-of-truth-keep-the-copies-in-sync)), so tests must run
inside a full checkout.

## Requirements

- Go 1.25+ (CLI)
- Node.js 22+ (API and site); dependencies are pinned in each `package-lock.json`, install with `npm install`
- Docker Desktop or Podman (running Docker tools, sandboxed pipx tools, the e2e scripts, the scanner image)
- Python 3.12 (scanner, seed tool unit tests); `cosign` and `git` for some e2e and `ot release` tests

The main development machine is Windows. Use forward slashes in scripts, keep files LF (`.gitattributes` sets
`* text=auto eol=lf`), and don't assume `bash`-only tools exist outside Git Bash.

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
| Regenerate API template copy | `cd api && npm run sync:templates` |
| Site dev server | `cd web && npm run dev` (port 4321; CSP **not** enforced) |
| Site production preview | `cd web && npm run build && npm run preview` (port 4322; CSP enforced) |
| Site typecheck / tests | `cd web && npm run check` / `npm test` |
| Social image | `cd web && npm run og` (re-renders `public/og.png`) |
| Scanner tests | `python -m unittest discover ops/scanner` |
| Seed tool tests | `python -m unittest` inside a `seed/first-party/<tool>/` folder |
| End-to-end (Docker) | `bash scripts/e2e.sh` |
| End-to-end, real artifacts | `bash scripts/e2e-real.sh` (needs Docker, cosign and the local API running) |

There is no linter or formatter config for `api/` or `web/`; match the surrounding style. No CI runs the API or site
tests, so run them yourself before you call a change done.

To point `ot` at a local API: `OT_API_URL=http://127.0.0.1:8787/v1`. To point the site at another API, set
`PUBLIC_API_URL` (copy `web/.env.example` to `web/.env.development`).

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
invalid ones. Digests and hashes in fixtures are fake.

### Spec is the source of truth: keep the copies in sync

| Source | Copy | Regenerate | Drift test |
| --- | --- | --- | --- |
| `spec/schema/v1.json` | `cli/internal/manifest/schema/v1.json` (embedded) | `cd cli && go generate ./...` | `TestEmbeddedSchemaMatchesSpec` |
| `spec/templates/*.yml` | `cli/internal/scaffold/templates/*.yml` (embedded) | `cd cli && go generate ./...` | `TestTemplatesMatchSpec` |
| `spec/templates/*.yml` | `api/src/release-templates.ts` (generated, "Do not edit") | `cd api && npm run sync:templates` | `week7.test.ts` |
| `spec/schema/v1.json` | imported directly by `api/src` and `web/src/pages/schema/v1.json.ts` | nothing to do | — |

Never edit a copy by hand. Edit `spec/`, then regenerate both.

### Release workflow templates (`spec/templates/`)

Used by `ot init`, `ot import` and the import wizard. `github-docker.yml` / `gitlab-docker.yml` build multi-arch images,
push, sign keylessly with cosign, write the digest and version into `otinstaller.yaml`, commit `Release X`, tag `vX`,
push. `github-pipx.yml` / `gitlab-pipx.yml` build and publish to PyPI with trusted publishing and write `package_version`
and `wheel_sha256`. `github-guide.yml` / `gitlab-guide.yml` are optional and lean (bump version, tag, atomic push): guides
are normally released with `ot release` instead.

---

## CLI (`cli/`)

Module `github.com/otinstaller/otinstaller/cli`. Entry point `cli/cmd/ot/main.go` → `cli.Main` in
`cli/internal/cli/root.go`, which runs the cobra root under a Ctrl-C-cancellable context, prints `error: <msg>` on
stderr and returns `ExitCodeFor(err)`.

### Packages (`cli/internal/`)

| Package | Responsibility |
| --- | --- |
| `cli` | Every command. `root.go` has the `App` struct (`Out`, `Err`, `In`, `Config`, `API`, `Runner`, `OpenURL`, `CheckRemovals`, `Updater`, `SelfPath`), exit codes, `ExitError`/`exitErr` and command registration |
| `api` | Registry HTTP client. Decodes `{"error":{...}}` into `*api.Error` (`Status`, `Code`, `Message`, `Hint`, `Docs`, `Problems`, `RequestID`) |
| `manifest` | Typed `Manifest`, `Parse`/`LoadFile`, `Validate(doc, m, Options{Tag, Dir})`, content rules, embedded schema |
| `runner` | Install and run: engine detection (docker, then podman), `Install`, `Run`, `ContainerArgs`, input resolution, typed inputs, command building |
| `envelope` | The normalized result envelope (`Version = 1`) and `ParseOutput` / `Write` (json, raw, csv, table) |
| `results` | Saving each run's raw output plus `.meta.json` (and lazy `.stderr.txt`) |
| `keys` | OS keychain (service `osintverse-ot`); an env var of the same name wins; names indexed in `keys.json` |
| `state` | Data dir (`OT_HOME` → `%APPDATA%\ot` → `~/.ot`), `state.json` (atomic write, 0600), read-only `config.json` |
| `scaffold` | Files written by `ot init` (manifest, Dockerfile, starter tool, READMEs, guide pages) and embedded templates; uses `<<`/`>>` template delimiters |
| `selfupdate` | `ot self-update`: Ed25519-signed `checksums.txt`, archive SHA-256, atomic replace |

### Commands

`init`, `validate`, `search`, `info`, `install`, `run`, `list`, `uninstall`, `keys set|list|rm`, `doctor`, `login`
(`--gitlab`, `--osintverse`), `logout`, `whoami`, `import`, `sync`, `guide search|read|open|get|tools`, `docs`, `report`,
`claim`, `transfer`, `yank`, `deprecate`, `self-update`, `release`. Each is an `(a *App) xxxCmd() *cobra.Command` method;
the file for each is easy to find from the names above (`packages.go` holds search/info/install/list/uninstall,
`init_validate.go` holds init/validate, `run.go` holds keys/doctor, `trust.go` holds report/claim/transfer/yank/deprecate,
`guide.go` holds guide/docs).

- `ot run` disables cobra flag parsing and parses its own args (`run_cmd.go`): ot flags (`-f/--format`, `-o`, `--out-dir`,
  `--native`, `-y`, `--results-dir`, `--case`, `--no-save`, `--all`, `--parallel`), any other `--x v` is a tool input,
  and positionals after the package like `u:johndoe` are typed inputs (`u:` username, `d:` domain, `e:` email,
  `p:` phone, `url:` url). `--all` (`run_all.go`) runs every installed tool with a matching input. See
  [docs/typed-inputs-and-results.md](docs/typed-inputs-and-results.md) for the full behaviour.
- `ot release <version> [path]` (`release.go`) releases **guides only**: checks a clean tree and an unused tag, rewrites
  `version:`, validates, commits `Release X` if changed, creates an annotated tag and runs `git push --atomic`.
  Tools are released by their release workflow, which builds and signs the artifact.
- Commands that need a sign-in (`whoami`, `import`, `sync`, `claim`, `transfer`) fail with exit 2 when there is no token.

### Exit codes (`root.go`)

`0` ok · `1` tool error (default) · `2` bad usage or invalid manifest · `3` missing key · `4` trust refusal · `5` runtime
missing · `124` timeout · `130` interrupted. Typed errors map to them: `runner.UsageError` → 2, `runner.TrustError` → 4,
`runner.RuntimeMissingError` → 5, `runner.TimeoutError` → 124, `*cli.ExitError` → its `Code` (a nil `Err` exits
silently). Wrap registry 4xx errors with `a.requestError(err)` so they exit 2 and print problem lists. These codes are
documented to users; don't repurpose them.

### Security model when running tools (don't weaken it)

- Docker images must be pinned by digest. If the registry returns a signer identity, `cosign verify` must pass
  (missing cosign only warns). Wheels are matched by `wheel_sha256` from PyPI and re-hashed after download.
- Containers run with `--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges --pids-limit 256
  --memory 1g --cpus 2 --user 65534:65534`, and `--network none` unless the manifest says `egress: true`.
- Secrets are passed as `-e NAME` with the value only in the child process environment, so they never appear in argv,
  in `.meta.json` or in logs.
- Sandboxed pipx tools are built into `ot-local/<ns>-<name>:<version>` on `python:3.12-slim`; `--native` uses ot's own
  `PIPX_HOME`/`PIPX_BIN_DIR`.
- Removed packages (`tool_removed`) are refused with exit 4; `cache/removed.json` drives warnings.

### Environment variables

`OT_HOME`, `OT_API_URL`, `OT_SITE_URL`, `OT_NO_TELEMETRY` (disables the anonymous install ping), `OT_RESULTS_DIR`
(legacy `OTINSTALLER_RESULTS_DIR`), `OTINSTALLER_TOKEN` (overrides the keychain token). Build-time only:
`OT_RELEASE_PUBLIC_KEY`, `OT_RELEASE_KEY_FILE`, `RELEASE_OWNER`, `RELEASE_NAME`, `TAP_GITHUB_TOKEN`.

### CLI conventions

- Data goes to `a.Out` (stdout); progress, `note:` and `warning:` lines go to `a.Err`. Never write to `os.Stdout`
  directly: tests capture the `App` writers. `ot run` keeps stdout for the envelope and prints `Saved <path>` on stderr.
- Tables: `text/tabwriter` with `(0, 4, 2, ' ', 0)` and uppercase headers. `--json` output: 2-space indent via
  `writeJSON` / `newJSONEncoder`.
- Messages are plain sentences that suggest the next command in backticks (``run `ot login` ``).
- Every package has a `// Package x ...` comment; exported identifiers have doc comments; comments explain why.
- No logging library. Standard `testing` only (no assertion library), `t.TempDir`, `t.Setenv`, table-driven `t.Run`.
- Tests use `newTestApp` and `fakeExec` (`cli_test.go`), `httptest` fake registries (`guide_test.go`, `import_test.go`,
  `trust_test.go`, `login_test.go`, `sync_test.go`), `keyring.MockInit()` for the keychain, and override `runner.PyPIBase`,
  `pollSleep`, `cli.Version`. `release_test.go` uses real `git` and skips without it. There are no golden files.

### Releasing `ot`

Push a `vX.Y.Z` tag on this repo: `.github/workflows/release-cli.yml` runs GoReleaser (`cli/.goreleaser.yaml`) for
windows/darwin/linux × amd64/arm64, signs `checksums.txt` with the Ed25519 release key and with cosign, builds deb/rpm,
optionally updates the Homebrew tap and Scoop bucket, and publishes to the public `otinstaller/ot` repo with the install
scripts (public key filled in). Archive names `ot_<ver>_<os>_<arch>.tar.gz|.zip` are relied on by `self-update` and the
install scripts. Only tag a release when asked.

---

## API (`api/`)

One Worker, `otinstaller-registry-api`, Hono app with base path `/v1`. Bindings in `api/wrangler.jsonc`: D1 `DB`
(`otinstaller`), R2 `CONTENT` (`otinstaller-content`), queue producer/consumer `PUBLISH_QUEUE` (`otinstaller-publish`),
crons `17 3 * * *` (nightly) and `*/15 * * * *`. There are no wrangler `env` blocks; the file is production config.
Secrets are listed in the wrangler comment and `src/env.ts`; for local runs copy `.dev.vars.example` to `.dev.vars`
(never commit it).

### Source layout (`api/src/`)

| Path | Responsibility |
| --- | --- |
| `index.ts` | App setup, CORS (credentialed only for `SITE_URL`), auth middleware, write rate limit (30/min/user, staff exempt), public read routes, `onError`/`notFound`, default export `{ fetch, queue, scheduled }` |
| `env.ts` | `Env`, `PublishMessage`, `User`, `deps.fetch` (all outbound HTTP), `requireSecret` |
| `catalog.ts` | Shared public-read SQL (`VISIBLE`, `LISTED`, `summary()`, `findTool()` with aliases, `cached()`) |
| `ranking.ts` | Search score (bm25 + installs + stars + health + verified − broken − registry-held) |
| `publish.ts` | Queue consumer `handleBatch` and the release validation pipeline `processJob` |
| `scans.ts` | Scanner dispatch to registry-ops, `verdict`, `applyScanResults`, `publishVersion`, commit statuses, scan timeouts |
| `guides.ts` / `content.ts` | Guide and docs rendering (marked + sanitizer), R2 storage, link checks, URL Scanner, PII heuristics |
| `sync.ts` | Keeping packages in sync with repos: 6-hourly poll, tag queuing, renames/archives/deletes |
| `imports.ts` | Import wizard: detection, draft manifests, finishing as PR/MR, registry-held manifests, community wrappers, bulk (≤50) |
| `trust.ts` / `transfers.ts` | Yank, deprecate, removal, reports, transparency, rate limits; claims and transfers |
| `notify.ts` | Resend email with idempotency keys (`notifications` table); skipped when `RESEND_API_KEY` is unset |
| `ops.ts` | Health targets/results, stuck-job alerts, daily digest, rate-limit purge, Sentry `reportError` |
| `hosts/` | External services: `github.ts`, `gitlab.ts`, `osintverse.ts` (OIDC), `repo.ts` (`RepoHost` over both), `artifacts.ts` (OCI digest and PyPI wheel checks) |
| `lib/` | `errors.ts` (`apiError`), `crypto.ts` (hashing, AES-GCM, RS256 JWT, `ulid()`), `manifest.ts` (validator), `images.ts` (metadata stripping, SVG sanitizing) |
| `routes/` | One `xxxRoutes(app)` registrar per area: auth, device, webhooks, review, sources, imports, guides, trust, transfers, ops |
| `release-templates.ts` | **Generated** from `spec/templates`; don't edit |

Routes only parse input, check permissions and shape responses; domain logic lives in the top-level modules. Route
registration order in `index.ts` matters (guides before `/tools/:ns/:name/:version`).

### Main endpoints (all under `/v1`)

- Public: `GET /health`, `/types`, `/tools` (search: `q`, `input`, `output`, `category`, `runtime`, `kind`, `level`,
  `format`, `lang`, `sort`, `no_keys`, `limit`, `cursor`), `/guides`, `/tools/:ns/:name[/versions|/:version[/manifest|/scans]]`,
  `/namespaces/:ns`, `/pivots`, `/removed`, guide pages, tool docs, readmes, `/assets/:sha256.ext`; `POST /installs`.
- Auth: `/auth/:provider/login|callback` (github, gitlab, osintverse), `/auth/logout`, `/auth/device/start|token`,
  `/me`, `/me/tokens`, `/me/publish-jobs`, `/me/repos`, `/me/transfers`.
- Publishing: `POST /webhooks/github` (HMAC), `POST /webhooks/gitlab` (per-source token), `/imports...`,
  `/sources/gitlab`, `/packages/:ns/:name/sync|sync-log|manifest|manifest/pr`.
- Owners: yank/unyank, deprecate, claim, transfer. Anyone: reports.
- Staff (`/admin/...`): review queue, namespace approve/request-changes/reject/verify/suspend, version approve/reject,
  reports, removals, audit log, transfers, bans.
- Internal: `POST /internal/scans` (scanner callback, single-use bearer scan token), `/internal/health[/targets]`
  (`HEALTH_TOKEN`).

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
5. Every 15 minutes: expire stale scans (1 h), poll due sources, alert on jobs stuck > 30 min. Nightly also: guide link
   rechecks (> 20% dead → needs update), the reviewer digest, rate-limit purge, `installs_30d` recompute.

Queue messages (`PublishMessage` in `env.ts`): `{ jobId }`, `{ importId }`, `{ checkVersionId, attempt? }`,
`{ linkCheckToolId }`, `{ publishVersionId }`. Transient failures retry with backoff up to 5 attempts; a `HostError` with
`transient=false` fails immediately.

### Data model (`api/migrations/`)

`0001_initial.sql` creates the core tables (users, accounts, sessions, api_tokens, namespaces, namespace_members,
installations, tools, versions, tool_io, tool_secrets, sources, sync_events, imports, publish_jobs, scans, health_checks,
pages, tool_guides, stars, install_counts, reports, transfers, aliases, audit_log) and the FTS5 table `tools_fts`. Later
migrations add publish intake (0002), scans/review and `notifications` (0003), sync (0004, 0006), imports (0005), guides and
`page_links` (0007, 0008), trust/takedowns/claims/health and `rate_limits` (0009), and OSINTverse login plus
`device_logins` (0010).

- IDs are ULIDs (`ulid()`), timestamps are Unix **milliseconds**, booleans are 0/1, JSON columns end in `_json`.
- Add schema changes as a new numbered migration (`00NN_description.sql`); never edit an applied one. Some migrations
  rebuild a table to change a CHECK constraint; follow that pattern if you need one.
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
  messages are short lowercase sentences; hints usually name an `ot` command. Multi-problem responses add `problems`.
  Unhandled errors become 500 `internal_error` with a `request_id` (the `cf-ray` header) and go to Sentry. If you add a
  user-facing code, document it in `web/src/pages/docs/errors.md`.
- **All outbound HTTP goes through `deps.fetch`** (passed to host functions as `f: Fetch`). Calling `fetch` directly
  breaks the tests' fake hosts.
- Raw D1 SQL with `?` bindings; multi-statement writes in `db.batch([...])` with `audit(...)` in the same batch.
  Idempotency via `ON CONFLICT` and guarded status transitions (`UPDATE ... WHERE status = 'x'`, then check
  `meta.changes`).
- Bodies: `await c.req.json<T>().catch(() => ({}) as T)`, then validate by hand with `apiError(400, "invalid_body", ...)`.
- Public reads set `cached(c, seconds)`; per-user responses use `private, no-store`.
- camelCase in TS, snake_case in SQL and JSON responses, kebab-case file names. Each file opens with a `//` comment saying
  what it owns and where related logic lives; exported functions get `/** */` docs; sections use
  `// ---------- name ----------`. Double quotes, semicolons, two-space indent, long lines are normal here.

### API tests (`api/test/`)

`vitest.config.ts` uses `@cloudflare/vitest-plugin`, so tests run in workerd against the bindings from `wrangler.jsonc`
with fake secrets. `test/setup.ts` applies the migrations and seeds from `scripts/seed-lib.mjs`. Helpers in
`test/helpers.ts`: `fakeHosts(routes)` (keys like `"GET https://api.github.com/..."`, longest prefix wins, unmatched
requests get status 599), `testEnv()` (fresh App key, fake queue collecting messages into `sent`), `call(path, init, env?)`,
`webhook(event, payload)`. `test/fixtures.ts` has `ghUser`, `installation`, `tagEvent`, `manifestFor`, `fakeRelease`.
Signed-in users are usually inserted directly into D1 with an `ot_test_<id>` token. Test files are named by plan week
(`week4` publish intake, `week5` scans/review, `week6` GitLab/sync, `week7` imports, `week8` guides/content, `week10`
trust/ops) plus `api.test.ts`, `osintverse.test.ts`, `community-provenance.test.ts`; add tests to the file for that area.

### Seed data

`api/scripts/seed-lib.mjs` builds demo SQL (from `spec/fixtures/valid`, `examples/cosign` and some inline packages, with
deterministic IDs like `tool_<ns>_<name>`) for `npm run db:seed` and the tests. It is for **local D1 only**. Never seed
production from it, from `spec/fixtures`, or with SQL: production packages come only through the real pipeline.

---

## Website (`web/`)

Astro 7 with `output: "server"` on `@astrojs/cloudflare`, Preact islands, no CSS framework. Worker
`otinstaller-registry-web` on `otinstaller.com` and `www.otinstaller.com`; deploy with `npm run deploy` (only when asked).

### Layout

- `src/pages/`: SSR pages. Tool pages live under `[ns]/[name]/` (overview, versions, security, docs, report, claim),
  guides under `guides/`, search at `search.astro`, plus `input/[type]`, `category/[slug]`, `[ns]/index.astro` (publisher),
  `dashboard`, `import`, `settings/accounts`, `transfers/[id]`, `admin/[...section]`, `docs/*.md`, `policy/*`,
  `removed.astro`, `404.astro`, `robots.txt.ts`, `sitemap.xml.ts`. Only `schema/v1.json.ts` is prerendered.
- `src/layouts/`: `Base.astro` (HTML shell, header/footer, the one inline script, global client JS for copy buttons,
  reveal-on-scroll, count-up, staff link), `Docs.astro`, `Policy.astro`.
- `src/components/*.astro`: server components (ToolCard, ToolHeader, Results, PageReader, Terminal, InstallTabs, ...).
- `src/islands/*.tsx`: Preact islands for anything signed-in or interactive (AdminConsole, Dashboard, ImportWizard,
  Accounts, ClaimFlow, TransferView, ReportForm, VersionActions, SearchDialog). `shared.tsx` has `useMe`, `SignIn`,
  `ErrorNote`, `Status`.
- `src/lib/`: `api.ts` (the only fetch helper: `api<T>()`, `apiOrNull`, `ApiError`, `signInUrl`, response types),
  `page.ts` (`cacheFor`, `searchFrom`, `withParam`), `tool.ts` (`loadTool` handles 404/410/moved/guide redirects),
  `theme-boot.ts`, `format.ts` (+ `format.test.ts`).
- `src/styles/`: `tokens.css` (all colours, radii, motion, type scale; light and dark), `global.css` (shared classes),
  `admin.css` (admin console only).

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
    (`npm run build && npm run preview`, the `web-preview` launch config on port 4322).
- Colours come from tokens in `tokens.css`, defined for light, dark (`prefers-color-scheme`) and `[data-theme]`; keep
  pairs WCAG 2.2 AA in both themes. Honour `prefers-reduced-motion` (CSS zeroes durations; JS checks `matchMedia`).
- `PUBLIC_API_URL` is read both in `astro.config.mjs` (CSP `connect-src`) and in `src/lib/api.ts`; they must agree.
- SSR pages call the API without cookies and render only public data. Signed-in data loads in islands, and those pages
  send `Cache-Control: private, no-store`. Public pages set caching with `cacheFor`.
- New docs pages need adding to the hardcoded nav in `Docs.astro` (or `Policy.astro`) and to `DOCS` in `sitemap.xml.ts`.
- HTML from the registry (READMEs, guide pages) is already sanitized server-side and rendered with `set:html`; don't
  render other untrusted HTML that way.
- Every component and island file opens with a one-line purpose comment.

### Local environments

- Production API holds the real seed; staging (`staging-api.otinstaller.com`) only works while a tunnel to someone's local
  `wrangler dev` is up, so it's usually down.
- From a `localhost` origin, browser-side calls to the production API with credentials (`/me`, quick search) fail CORS.
  That is expected, not a site bug.
- For a full local check: run the API (`npm run dev` in `api/`, seeded, with `--var SITE_URL:http://127.0.0.1:<site port>`)
  and build the site with `PUBLIC_API_URL=http://127.0.0.1:8787`.

---

## Ops (`ops/`)

- `ops/scanner/scan.py <request.json> [--post]`: the security scan the registry dispatches. Docker: pull, `cosign verify`
  against the expected signer (and a loose verify to tell "signed by someone else" from "unsigned"), Trivy vuln+secret,
  SBOM. pipx: download the wheel by hash, check PEP 740 provenance against the source (or upstream) repo, Trivy on a
  python:3.12-slim image, GuardDog. Then a sandboxed smoke test with `test.input` (network only if egress is declared),
  passing when the exit code equals `test.expect_exit_code`. Results POST to `callback_url`.
- `ops/scanner/health.py`: the nightly health check (each tool's test input, with network); 3 failures in a row mark a tool
  Possibly broken.
- `ops/scanner/Dockerfile`: pinned Docker CLI, Trivy, cosign, GuardDog for local runs.
- `ops/workflows/scan.yml`, `health.yml`: copied into `OTInstaller/registry-ops`, not run from this repo. If you change
  `ops/`, the copies there have to be updated separately.
- The scan payload format is defined by `dispatchScan` in `api/src/scans.ts` and parsed by `parseResults` in
  `api/src/routes/review.ts`; change both sides together.

## Seed (`seed/`)

Each folder becomes its own repository under `osintverse-community`; see [seed/README.md](seed/README.md) for the full
table, publish order (namespace → tools → guides) and health risks.

- `first-party/<tool>/`: a single stdlib-first Python script (`<snake_name>.py`, argparse, `main(argv=None)` returning an
  exit code, prints `{"entities": [...]}`), `test_<snake_name>.py` (unittest, no network), a `python:3.12-slim`
  Dockerfile running as uid 10001, `otinstaller.yaml` with a zero-digest placeholder the release workflow fills in,
  `README.md`, MIT `LICENSE`, and `.github/workflows/otinstaller-release.yml` (identical to
  `spec/templates/github-docker.yml`).
- `community/<tool>/`: wrappers of third-party tools. Docker wrappers pin the upstream version in a Dockerfile; pipx
  wrappers are just a manifest pinning the wheel by `wheel_sha256` plus a README crediting upstream. The upstream license
  must be redistributable (AGPL and unlicensed projects are outreach only).
- `guides/<guide>/`: `otinstaller.yaml` (`kind: guide`, CC-BY-4.0), `docs/index.md` + numbered pages, README, LICENSE.md.
  Guides have no release workflow: release them with `ot release X.Y.Z` (or a plain `git tag vX.Y.Z && git push`), never
  through GitHub Actions.
- `outreach/`: issue and PR texts for upstream maintainers.
- Updating a pipx wrapper: change `version`, `package_version` and `wheel_sha256` (from `https://pypi.org/pypi/<pkg>/json`).

## End-to-end scripts

- `scripts/e2e.sh`: builds `bin/ot`, starts a local `registry:2` on 127.0.0.1:5000, builds and pushes
  `examples/dns-lookup`, fills its digest into the (gitignored) `otinstaller.yaml`, then runs `ot validate`,
  `validate --smoke`, `run` and `list` with a temporary `OT_HOME`.
- `scripts/e2e-real.sh`: against the local API (`cd api && npm run db:seed && npm run dev`), checks that the real signed
  `sigstore/cosign` image installs (exit 0), a wrong signer is refused (exit 4), the real tldextract wheel installs, and a
  tampered wheel hash is refused (exit 4).

---

## Cross-cutting checklists

**Changing the manifest format**
1. Edit `spec/schema/v1.json`; add valid/invalid fixtures (`# expect: <code>`).
2. `cd cli && go generate ./...`; update `cli/internal/manifest` (typed struct, semantic checks, codes).
3. Update `api/src/lib/manifest.ts` (and `publish.ts` if release-time) with the same codes.
4. Update `web/src/pages/docs/manifest.md` and `errors.md`; check `api/scripts/seed-lib.mjs` still validates.
5. `go test ./...` in `cli`, `npm test` in `api`.

**Changing a release template**: edit `spec/templates/`, run `go generate ./...` in `cli` and `npm run sync:templates`
in `api`, and update the copies under `seed/*/.github/workflows/` if the seed should pick it up.

**Adding an API endpoint**: put it in the matching `routes/*.ts`, logic in the domain module, outbound calls through
`deps.fetch`, errors through `apiError`, a test in the matching test file, and if the CLI or site uses it, the client in
`cli/internal/api` or `web/src/lib/api.ts`. User-visible behaviour belongs in `web/src/pages/docs/`.

**Adding a CLI command**: an `xxxCmd()` method registered in `Root()`, output via `a.Out`/`a.Err`, typed errors for exit
codes, a test with `newTestApp`, and an entry in `web/src/pages/docs/cli.md`.

**Changing the site's look or motion**: tokens first, no inline styles or scripts, test both themes and reduced motion,
and verify in the preview build.

## Git and commits

- `main` is the default branch. Work usually happens on a `claude/<topic>` branch merged into `main` with a no-ff merge
  titled `Merge claude/<topic>` or `Merge claude/<topic> (short description)`.
- Commit subjects: imperative, sentence case, no trailing period, no conventional-commit prefixes. An area prefix is
  common: `Seed:`, `Scanner:`, `Web:`, `ot run:`. British spelling is used ("Honour", "organisation"). Backticks for
  commands are fine.
- Bodies: a short paragraph on why, then `- ` bullets in plain prose, wrapped at about 115 characters.
- `Release X.Y.Z` is reserved for release commits made by workflows and `ot release`.
- Don't add AI or tool attribution (no `Co-Authored-By` trailers, no "Generated with ..." lines) anywhere: commits, PRs,
  code, or docs.
- Don't commit `.dev.vars`, `.env.development`, `bin/`, `results/`, `.wrangler/` or `examples/dns-lookup/otinstaller.yaml`
  (all gitignored).

## Things that need explicit permission

These affect production or other people, so do them only when asked: `npm run deploy` / `wrangler deploy` (api or web),
`wrangler d1 ... --remote`, `wrangler secret put`, pushing `v*` tags on this repo (releases `ot`), pushing tags or
running workflows on seed repositories (publishes packages), posting outreach issues or PRs, and changing GitHub App,
OAuth or registry-ops settings. The operator runbook for all of these is [docs/publishing-setup.md](docs/publishing-setup.md).
