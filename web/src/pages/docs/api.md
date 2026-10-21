---
layout: ../../layouts/Docs.astro
title: Registry API
description: "The OTInstaller Registry API: the OpenAPI description, signing in with scoped tokens, rate limits, caching, ETags, pagination and errors."
---

`ot` and the website use the same public API, at `https://api.otinstaller.com/v1`, and so can your scripts, CI and
agents. It is described in full by an **OpenAPI 3.1 document** at
[`/v1/openapi.json`](https://api.otinstaller.com/v1/openapi.json). Tools that turn OpenAPI into client code or agent
tools can use it directly. For running tools rather than reading the registry, use `ot` ([automation](/docs/automation))
or its [MCP server](/docs/agents).

## Reading needs no sign-in

Search, package pages, manifests, scans, guides, docs, `/types` and `/pivots` are public. Useful calls:

| Call | What it gives |
| --- | --- |
| `GET /tools?q=whois&input=domain&passive_only=1` | Search. Filters: `input`, `output`, `category`, `runtime`, `kind`, `no_keys`, `passive_only` (tools that run offline, touch no target and collect no personal data), `sort` (`relevance`, `installs`, `stars`, `updated`, `health`), `limit`, `cursor` |
| `GET /facets?kind=tool` | How many visible packages match each input, output, category and runtime, and how many need no key |
| `GET /tools/{ns}/{name}` | A package, its trust status and its manifest |
| `GET /tools/{ns}/{name}/{version}/manifest` | What `ot install` uses: the manifest, signer, scan status and backup locations. `manifest` leaves out optional fields added after `ot` v0.12; when it does, `manifest_full` has them |
| `GET /types` | Input types, entity types, categories and the pivot map |
| `GET /pivots?from=email,subdomain` | For each entity type, the input types it can feed and the best tools taking them; types that feed nothing are listed in `unmapped` |

Search results and package pages include each tool's `ethics` (`touches_target`, `auth_required`,
`collects_personal_data`, and `notifies_target` when the publisher sets it) and `egress`. Those decide whether an agent
must ask before running it.

Agents that speak MCP can use the same reads through the [remote MCP server](/docs/agents#remote-server) at
`https://api.otinstaller.com/mcp`.

Don't send a token on public reads: anonymous reads are served from the edge cache.

## Signing in: tokens and scopes

Calls about your account, publishing and your packages need a token, sent as `Authorization: Bearer ot_...`. Get one
with `ot login` (a device code; add `--scope` to limit it), or create one with `ot token create` or `POST /me/tokens`.
Tokens created that way expire after 90 days unless you choose otherwise (1 to 365 days).

Each token has scopes. A call outside them gets `403 insufficient_scope`, naming the scope it needs
(`required_scope`, and a `WWW-Authenticate` header). Each operation's `x-scope` in the OpenAPI document says which.

| Scope | Allows |
| --- | --- |
| `read` | Your account, tokens and publish history (always included) |
| `publish` | Imports, manifest edits, syncs and sources |
| `manage` | Yanks, deprecations, claims, transfers, backup settings, and creating or revoking tokens |
| `feedback` | Reports and feedback |
| `staff` | The review queue and admin actions; only a signed-in reviewer or admin can create such a token, on the website |

- **Give each agent or CI job its own token** with only what it needs. For example, `ot token create ci --scope publish
  --expires 30`, or `--scope read` for an agent that only looks.
- **A token can't create one with more scopes than it has.**
- **Every write made with a token is recorded** in the registry's audit log against that token, so a leaked token can
  be traced. Revoke it with `ot token revoke <id>`.
- **Older tokens** (from before scopes) keep every power their user has. `ot token list` shows them as "all (older
  token)"; replace them when you can.

## Caching and ETags

- **Cache-Control:** every public read says how long it may be cached, and the edge serves it from cache for that
  long. A change can take up to that long to show.
- **ETags:** every successful JSON read has an `ETag`. Send it back in `If-None-Match` and an unchanged answer is
  `304 Not Modified` with no body, signed in or not. Poll this way rather than downloading the same answer again.

## Rate limits

| Limit | Applies to |
| --- | --- |
| 30 writes a minute | each signed-in user (reviewers and admins exempt) |
| 10 manual syncs an hour | each package |
| 5 reports an hour per address, 20 a day per account | reports |
| 10 messages an hour | feedback |
| 1 install count per address, version and day | `POST /installs` (more are accepted but not counted) |

A `429` carries `Retry-After` and `RateLimit-Policy` headers and `retry_after_s` in the body. Wait that long.

## Pagination

`GET /tools` pages with `limit` (1 to 100) and the `next_cursor` of the previous page. Treat the cursor as opaque.
Search ranks the best 200 matches for a query (1000 without one), and `total_capped: true` says the total stopped
there.

## Errors

Every error is `{"error": {"code", "message", "hint", "docs"}}`, the
[error schema](/schema/error-v1.json) `ot`'s JSON errors share.

- `code` is stable and explained at [error codes](/docs/errors).
- Errors about a manifest add `problems`, a 400 for a bad parameter adds `allowed`, and a 5xx adds `request_id` to
  quote when you report it.
- A removed package answers `410 tool_removed` on every URL under it.

Times are Unix milliseconds. IDs are opaque strings.
