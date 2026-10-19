# OTInstaller Registry

A free, public registry of OSINT tools and guides, and `ot`, the CLI that installs and runs them.
This repository holds weeks 1–5 of the plan: the manifest spec, the `ot` CLI, the registry API's read side,
publishing intake (GitHub/GitLab sign-in, the GitHub App webhook, the queue that validates tagged releases), and
security scans with the review queue (scanner, verdicts, publishing, reviewer decisions, emails).
To connect real GitHub and GitLab apps, follow [docs/publishing-setup.md](docs/publishing-setup.md).

| Folder | What it is |
| --- | --- |
| `spec/` | Manifest JSON Schema (`schema/v1.json`) and example manifests: 3 valid, 24 invalid with expected error codes |
| `cli/` | The `ot` CLI (Go): `init`, `validate`, `search`, `info`, `install`, `run`, `list`, `uninstall`, `keys`, `doctor`, `login`, `logout`, `whoami` |
| `api/` | Registry API (Cloudflare Workers + Hono + D1 + Queues): search and read endpoints, GitHub/GitLab sign-in and device flow, API tokens, GitHub App webhooks, publish validation |
| `ops/` | The scanner (`scanner/scan.py` + its Docker image) and the GitHub Actions workflow for the registry-ops repo |
| `examples/dns-lookup/` | A tiny real tool used by the end-to-end test |
| `examples/tldextract/`, `examples/cosign/` | Real packages (a PyPI wheel and Sigstore's signed image) used by `scripts/e2e-real.sh` |
| `scripts/e2e.sh` | Builds the example, pushes it to a local registry, then validates, smoke-tests and runs it with `ot` |

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

Exit codes: 0 success, 1 tool error, 2 bad usage or invalid manifest, 3 missing key, 4 trust refusal, 5 runtime missing, 124 timeout.

The CLI embeds a copy of `spec/schema/v1.json`. After changing the spec, run `go generate ./...` in `cli/`; a test fails if the copies drift.

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

## Notes on the plan

- Guide manifests use `topics:` (not `inputs:`) for what a guide helps investigate, so `inputs` always means tool inputs.
- `ot` drives the `docker` (or `podman`) CLI rather than the Engine API, which keeps it working with Docker Desktop, OrbStack, Colima and Podman.
- Sandboxed pipx tools are built into a local image (`ot-local/<namespace>-<name>:<version>`) from a verified wheel on `python:3.12-slim`.
- An extra `tool_secrets` table powers the "no API keys needed" search filter.
- Config is `config.json` in the data directory.
- Smoke tests run offline unless the manifest declares `network.egress: true`; then they keep the network, on a disposable
  runner with no secrets in the container. Fully offline smoke tests would fail most OSINT tools.
- Wheels are scanned for vulnerabilities in their Python packages only; the base image the scanner wraps them in is not the author's.
- Docker images are not run through GuardDog (it reads Python packages); Trivy and the smoke test cover them.
