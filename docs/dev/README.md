# Developer reference

Deep reference for people and agents working on the code. Start with [AGENTS.md](../../AGENTS.md) at the repository
root: it has the layout, the commands, the rules that are easy to break and the known gaps. These pages hold the
detail it links to.

| Page | What's in it |
| --- | --- |
| [architecture.md](architecture.md) | System diagram and step-by-step flows: publish, scan, guide checks, backup, install/run, sign-in, review, takedown, edge cache, self-update, agents |
| [api.md](api.md) | Every API route with auth and caching, middleware order, rate limits, queue messages, crons, the mirror's OCI routes, every error code |
| [database.md](database.md) | Every migration, the final D1 schema by table, status state machines, seed contents |
| [cli.md](cli.md) | Every `ot` command and flag, exit codes per command, env vars, files under the data dir, packages and tests |
| [ops-payloads.md](ops-payloads.md) | Scan, backup and drill payloads and callbacks; verdict rules; registry-ops workflows; token lifetimes |
| [config.md](config.md) | Bindings, vars and secrets per Worker, registry-ops and the CLI release; values that must match across them |
| [local-setup.md](local-setup.md) | From a clean Windows, macOS or Linux machine to running every part locally |
| [troubleshooting.md](troubleshooting.md) | Recipes: stuck jobs, scans, backups, edge-cache staleness, D1 limits, CORS, email, GitLab, `ot` failures |

They were written from the code in October 2026. The code wins when they disagree: fix the page in the same commit
as the behaviour change. User-facing documentation lives with the website, in its own repository, and the operator runbook is
[publishing-setup.md](../publishing-setup.md).
