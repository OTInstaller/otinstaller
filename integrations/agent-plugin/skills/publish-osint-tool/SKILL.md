---
name: publish-osint-tool
description: Package an OSINT tool for the OTInstaller Registry, as a Docker image or a PyPI wheel, with a valid otinstaller.yaml, honest ethics flags and a release workflow. Use when the user wants to publish, package, list or release a tool on OTInstaller, or asks about otinstaller.yaml, ot init or ot import.
license: Apache-2.0
---

# Publishing a tool to OTInstaller

A tool is published from its own GitHub or GitLab repository. The repository gets an `otinstaller.yaml` manifest, a
Dockerfile (or a PyPI package) and a release workflow. Pushing a `vX.Y.Z` tag makes the registry validate the release,
security-scan it, send a new publisher to human review, and publish it. Read these first:

- https://otinstaller.com/docs/publishing.md
- https://otinstaller.com/docs/manifest.md (and the schema, https://otinstaller.com/schema/v1.json)
- https://otinstaller.com/policy/acceptable-use.md: what may be published

## Steps

1. **Start the manifest.**
   - For a tool in this folder, run `ot init` (`--kind docker` or `--kind pipx`).
   - For an existing public repository, `ot import <repository URL>` drafts one.
   - Run them with `--yes` and flags when there is no terminal.
2. **Fill in the manifest** (`otinstaller.yaml`):
   - `inputs`, each with a real `type` (email, username, phone, domain, ip, url, name, ...), so `ot run u:alice` and
     agents can fill them
   - `outputs`, the entity types the tool finds
   - `runtime.command` as an array, never a shell string, using `{input}` placeholders
   - `output_format`
   - `ethics`, answered honestly: `touches_target` (does it send requests about the target?), `auth_required`,
     `collects_personal_data`. Wrong answers are a policy violation, and they decide when agents must ask for consent.
   - `network.egress` with its `domains`, only if the tool needs the internet
   - `secrets` for API keys, with the URL where users get one
   - `test.input`, a harmless input the scanner and health checks run
3. **Write the Dockerfile.**
   - Pin the base image.
   - Run as a non-root user.
   - Write only to `/tmp`: containers run read-only with no capabilities.
   - Print results to stdout. JSON with an `entities` array lets `ot` read them:
     `{"entities": [{"type": "account", "value": "...", "source": "site"}]}`.
4. **Check it** with `validate_manifest` (MCP) or `ot validate`, then `ot validate --smoke`, which builds it and runs
   `test.input` in the sandbox. Fix every problem; each code is explained at https://otinstaller.com/docs/errors.
5. **Release.** The release workflow `ot init` wrote builds, signs (cosign, keyless) and tags. Only push a release tag
   or run the workflow when the user explicitly says so. That publishes to a public registry.

Never put secrets in the manifest, the image or the repository. Credit the upstream project when packaging someone
else's tool, and keep its license.
