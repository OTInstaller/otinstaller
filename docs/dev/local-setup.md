# Local development setup

From a clean machine to running every part of the repository locally. The main development machine is Windows, so the
Windows path is the best tested. [AGENTS.md](../../AGENTS.md) has the short command table; this page has the long form.

## 1. Tools

| Tool | Version | Needed for |
| --- | --- | --- |
| Git (Git Bash on Windows) | any recent | everything; `bash scripts/*.sh` on Windows runs in Git Bash |
| Go | 1.25+ (`cli/go.mod`) | `cli/`, `ot release` tests, `scripts/e2e*.sh` |
| Node.js | 22+ (Astro 7 needs it; there is no `engines` field) | `api/`, `web/` |
| Docker Desktop or Podman | recent | running tools, sandboxed pipx tools, the e2e scripts, the scanner image |
| Python | 3.12 (3.12+ works for the scanner and seed tests); 3.10+ on Linux for `otlite/` | `ops/scanner`, seed tool tests, `scripts/pm-catalog-to-wrappers.py`, `otlite/` |
| cosign | v2 | `scripts/e2e-real.sh`, `scripts/e2e-backups.sh`, signature checks in `ot` (missing cosign only warns) |
| crane | recent | `scripts/e2e-backups.sh` |
| Trivy, GuardDog | as pinned in `ops/scanner/Dockerfile` | only for running the scanner outside its image; normally use the image |

`cosign` and `crane` install the same way everywhere once Go is on the PATH:

```bash
go install github.com/sigstore/cosign/v2/cmd/cosign@latest
```

```bash
go install github.com/google/go-containerregistry/cmd/crane@latest
```

### Windows

- Install Git for Windows (gives Git Bash), Go, Node.js 22 LTS, Python 3.12 and Docker Desktop (WSL 2 backend), for
  example with `winget` or the vendors' installers.
- Keep files LF: the repository's `.gitattributes` sets `* text=auto eol=lf`. Python on Windows writes CRLF in text
  mode; open files with `newline=""` in scripts that write repository files.
- Use `127.0.0.1`, not `localhost`, for local servers that Docker talks to: `localhost` resolves to `::1` and Docker's
  IPv6 port forward hangs.
- `otlite/` is Linux-only; use WSL 2 or a Linux container for it.
- Very long paths can break the Astro prerender in workerd (`SQLITE_CANTOPEN`); a short checkout path avoids it.

### macOS

```bash
brew install git go node@22 python@3.12 cosign crane
```

```bash
brew install --cask docker
```

Stock macOS has LibreSSL, which can't verify Ed25519; the `ot` install script falls back to checksum-only there and
warns. That only matters when testing `scripts/install/install.sh`.

### Linux

Use the distribution's packages for Git, Python and Docker (or Podman). Distribution Go and Node are often too old: take
Go from go.dev and Node 22 from NodeSource or a version manager. Add your user to the `docker` group (or use rootless
Podman), and install `python3-venv` for `otlite/`.

## 2. Clone and check

```bash
git clone https://github.com/OTInstaller/otinstaller.git
```

Then, from the checkout:

| Step | Command |
| --- | --- |
| CLI | `cd cli && go test ./... && go vet ./... && gofmt -l .` |
| Build `ot` | `cd cli && go build -o ../bin/ot ./cmd/ot` |
| API | `cd api && npm install && npm run typecheck && npm test` |
| Site | `cd web && npm install && npm run check && npm test` |
| Scanner | `python -m unittest discover ops/scanner` |
| A seed tool | `cd seed/first-party/<tool> && python -m unittest` |
| otlite/ (Linux) | `cd otlite && pip install -e ".[dev,pipeline]" && ruff check . && ruff format --check . && pytest` |

The API tests need no secrets: `api/vitest.config.ts` gives them fake secrets, builds the seed from
`api/scripts/seed-lib.mjs` and the fixtures and templates from `spec/`, and sets `EDGE_CACHE: "off"`. The `week10`
rate-limit test waits for the start of a minute and is flaky under load; rerun it alone before chasing it.

## 3. Run the API locally

```bash
cd api && npm install && npm run db:migrate && npm run db:seed && npm run dev
```

- `wrangler dev` serves `http://127.0.0.1:8787/v1` with a local D1, R2 and queue under `api/.wrangler/` (gitignored).
  Reset the local state by deleting `api/.wrangler/state`.
- Public reads (`/v1/tools`, `/v1/tools/<ns>/<name>/latest/manifest`, ...) work with no `.dev.vars` at all.
- Sign-in, webhooks, imports, scans and email need secrets: copy `api/.dev.vars.example` to `api/.dev.vars` (never
  commit it) and fill in what you need. Missing secrets answer `503 not_configured` only for the feature that needs
  them. See [config.md](config.md) for every name and what it unlocks.
- `TOKEN_ENC_KEY` is 32 random bytes, base64. Any value works locally.
- The production GitHub and GitLab OAuth apps only accept production callbacks; local sign-in needs your own OAuth
  apps whose callback is `<API_URL>/v1/auth/<provider>/callback` for your local `API_URL` (GitLab with the `api`
  scope). `.dev.vars.example` uses `http://localhost:8787` in its OSINTverse example; whichever host you pick, use it
  consistently in `API_URL` and the provider settings.
- The seed is for local D1 only. Never run it, `spec/fixtures` or hand-written SQL against production.
- `wrangler d1 execute otinstaller --local --command "..."` runs only the first statement when given several; use
  `--file` for scripts.

The mirror runs separately: `cd api && npx wrangler dev -c wrangler.mirror.jsonc` (pick a free port with `--port` if
8787 is taken). `scripts/e2e-backups.sh` shows the full set (API, mirror, a proxy container) on ports 8787 to 8789 and
5001.

## 4. Run the site locally

| Goal | Command | Notes |
| --- | --- | --- |
| Fast dev server | `cd web && npm run dev` | port 4321, hot reload, **no CSP** |
| Production build | `cd web && npm run build && npm run preview -- --port 4322` | CSP enforced; the `web-preview` launch config does the same |
| Against the local API | build with `PUBLIC_API_URL=http://127.0.0.1:8787` in the shell, and start the API with `npx wrangler dev --var SITE_URL:http://127.0.0.1:<site port>` | the site origin must equal the API's `SITE_URL` for credentialed CORS |

The site's default API is production. From a `localhost` origin, credentialed calls to production (`/me`, quick search)
fail CORS; that is expected. `web/.env.example` points at staging, which only works while someone runs a tunnel, so it
is usually down.

`.claude/launch.json` (tracked) defines `web` (4321) and `web-preview` (4322) for the Claude desktop app's preview.

## 5. Point `ot` at a local API

```bash
OT_API_URL=http://127.0.0.1:8787/v1 OT_HOME="$(mktemp -d)" OT_NO_TELEMETRY=1 ./bin/ot search
```

A temporary `OT_HOME` keeps your real installs and keychain index out of the way. `OTINSTALLER_TOKEN` overrides the
keychain token, which is handy with a token minted against the local API.

## 6. End-to-end scripts

| Script | Needs | What it proves |
| --- | --- | --- |
| `bash scripts/e2e.sh` | Docker, Go | build, push to a local `registry:2`, `ot validate`, `validate --smoke`, `run`, `list` |
| `bash scripts/e2e-real.sh` | Docker, cosign, the local API running and seeded | real signed image installs; wrong signer exits 4; real wheel installs; tampered hash exits 4 |
| `bash scripts/e2e-backups.sh` | Docker, cosign, crane, git, Go, Node, Python; ports 8787 to 8789 and 5001 | install from the mirror and the wheel copy while the originals refuse; git bundle restore |
| `bash scripts/install/make-test-release.sh` | Go, openssl 3 (Ed25519), python3, sha256sum or shasum | a release signed with a throwaway key for testing the install scripts |

The Docker VM can't reach host ports directly on Windows and macOS; `e2e-backups.sh` uses an nginx container as a
proxy for that reason.
