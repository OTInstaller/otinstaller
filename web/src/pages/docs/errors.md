---
layout: ../../layouts/Docs.astro
title: Error codes
description: What each validation, check and API error means and how to fix it.
---

Every error from the registry and `ot validate` has a code. Commit statuses, emails and the [dashboard](/dashboard) link here.

## Manifest

### manifest_yaml_invalid
`otinstaller.yaml` is not valid YAML, or not a mapping. Check indentation and quoting.

### manifest_too_large
The manifest is over 64 KB.

### manifest_schema
A field is missing or has the wrong type or value. The message names the field. See the [manifest reference](/docs/manifest).

### manifest_schema_version
`schema` must be `1`.

### manifest_name_invalid
`name` or `namespace` must be 3–40 lowercase letters, digits and hyphens, not starting or ending with a hyphen.

### manifest_version_invalid
`version` must be semver without a leading `v`, for example `1.2.0`.

### manifest_license_invalid
`license` must be an SPDX identifier such as `MIT` or `Apache-2.0`; `NOASSERTION` is not accepted.

### manifest_image_not_pinned
`runtime.image` must be pinned by digest (`image@sha256:…`). The release workflow from `ot init` does this.

### manifest_platform_missing
`runtime.platforms` must include `linux/amd64`.

### manifest_placeholder_unknown
`runtime.command` uses a `{placeholder}` that is not an input name. Rename the input or the placeholder.

### manifest_input_duplicate
Two inputs have the same name.

### manifest_secret_duplicate
Two secrets have the same name.

### manifest_test_input_unknown
`test.input` sets a value for something that is not an input.

### manifest_test_input_missing
A required input has no value in `test.input`.

### manifest_file_missing
A file the manifest names (the README, a guide or docs page, an image) is not in the repository at the tagged commit, or `otinstaller.yaml` itself is missing. Commit it and tag again.

### manifest_tag_mismatch
The tag must be `v` followed by `version`, for example `v1.2.0` for `version: 1.2.0`.

### manifest_namespace_mismatch
`namespace` must be the GitHub or GitLab owner of the repository the release comes from.

### manifest_version_exists
This version is already published, and versions never change. Bump `version` and tag again.

### manifest_name_taken
Another repository already publishes a package with this name in your namespace.

### namespace_not_allowed
The namespace is suspended or was not approved. Write to abuse@otinstaller.com.

## Artifacts

### artifact_image_not_found
The image digest in `runtime.image` does not exist on its registry, or is not public.

### artifact_platform_missing
The image has no `linux/amd64` variant.

### artifact_package_not_found
The PyPI package or version in `runtime` does not exist.

### artifact_wheel_mismatch
The wheel on PyPI does not match `runtime.wheel_sha256`.

## Guides and docs

### content_raw_html
A page contains a script, iframe, form, style or event handler. Use Markdown.

### content_page_too_large
A page is over 200 KB. Split it.

### content_image_type
An image is not a PNG, JPEG, WebP or SVG file in the repository, or its content does not match its name.

### content_image_too_large
An image is over 2 MB. Resize or compress it.

### content_images_too_large
The images of one version add up to more than 50 MB.

### content_link_malicious
Cloudflare URL Scanner flagged a link as malicious. Remove it and tag again.

### guide_related_tool_unknown
A tool in `related_tools` is not a published tool. Use `namespace/name`, and publish the tool first.

## Scans

### signature_mismatch
The image signature did not verify against the repository's CI identity.

### signature_dropped
Earlier versions were signed and this one is not. Release it with the signing workflow.

### malware_suspected
Malicious-code heuristics matched. A reviewer looks at the report.

### secrets_found
The image or package contains embedded secrets. Rotate them and rebuild.

### smoke_test_failed
The tool failed on its `test.input` (run without network unless `network.egress` is set). Try `ot validate --smoke`.

### scan_timeout
The scan or content checks did not finish within an hour. Push the tag again.

### internal_error
Something failed on the registry's side. Push the tag again; if it keeps failing, write to support@otinstaller.com with the request ID from the message.

## Review

### changes_requested
A reviewer asked for changes to a new publisher's first release; the email has their notes. Tag again once they are made.

### namespace_rejected
The namespace was not approved. The email says why and how to appeal.

### review_rejected
A reviewer rejected this release, for example because a guide's examples contain personal data. The email says why.

## Requests

### unauthenticated
Sign in, or pass an `ot_` token.

### forbidden
Your account cannot do this (for example reviewer actions).

### not_found
The endpoint does not exist, or was removed.

### tool_not_found
The package does not exist, or was removed.

### guide_not_found
The guide does not exist, or was removed.

### version_not_found
The version does not exist, or was removed.

### page_not_found
The page does not exist, or was removed.

### invalid_parameter
A query parameter has a value the API does not accept; the message lists the allowed ones.

### invalid_body
The request body is malformed; the message says what to send.

### tool_removed
The package, or every version it had, was removed from the registry; the message gives the reason category. See the
[transparency page](/policy/transparency).

### too_many_requests
At most 30 changes a minute per account.

### too_many_reports
At most 5 reports an hour from one address, or 20 a day per account. Write to abuse@otinstaller.com for more.

### invalid_reason
Report reasons are malware, policy, impersonation, license, broken and other.

### not_community_packaged
Only community wrappers can be claimed; ask the package's owners for a transfer instead.

### destination_required
Say which of your namespaces should receive the package, or get one first by installing the GitHub App or connecting GitLab.

### upstream_unknown
The wrapper does not name its upstream repository, so the claim cannot be checked automatically. Write to support@otinstaller.com.

### name_taken
The receiving namespace already has a package with this name. Rename one of them first.

### invalid_state
The version or transfer is not in a state that allows this (for example, yanking a version that is already yanked).

### sync_rate_limited
At most 10 manual syncs per package per hour.

### github_permission_required
The GitHub App needs write access to contents, workflows and pull requests to open a pull request. Accept its updated permissions in your GitHub settings.

### gitlab_scope_required
Opening merge requests needs GitLab write access. Sign in again with GitLab from the import page and grant it.

## ot

Codes `ot` itself reports. With `--json` (or `OT_OUTPUT=json`) every error is one line of JSON on stderr with `code`,
`message`, `hint`, `docs` and `exit_code`; see [Scripts, CI and agents](/docs/automation). Registry errors keep the
registry's own code.

### usage
The command line is wrong: an unknown command or flag, a missing argument, or inputs that don't fit the tool. Exit code
2. The message says what to change; `ot <command> --help` lists the flags.

### input_required
`ot` needed an answer but there is no terminal to ask in (piped or closed stdin, CI, an agent, or
`OT_NONINTERACTIVE=1`). `ot` never prompts then. Pass the flag the message names, usually `--yes`. Exit code 2.

### not_installed
`ot run` was given a tool that isn't installed, with no terminal to ask whether to install it. Run `ot install` first, or
pass `--yes`. Exit code 2.

### not_signed_in
The command needs a registry token. Run `ot login`, or set `OTINSTALLER_TOKEN`. Exit code 2.

### manifest_invalid
The manifest has problems, listed one by one in `problems` (each with its own code from this page). Exit code 2.

### secret_missing
The tool needs an API key that isn't set. Set it with `ot keys set NAME`, or as an environment variable of the same
name. Exit code 3.

### trust_refused
`ot` refused to install or run a package: a removed version, an image not pinned by digest, or a signature that doesn't
match. Exit code 4. See the [security model](/docs/security).

### runtime_missing
Docker (or Podman) or pipx isn't available. `ot doctor` says what is missing. Exit code 5.

### registry_unreachable
No answer came back from the registry (DNS, TLS, a timeout). Retrying later may work. Exit code 1.

### timeout
The tool ran past its `timeout_seconds`. Its partial output is saved. Exit code 124.

### interrupted
The run was stopped with Ctrl-C. Its partial output is saved. Exit code 130.

### failed
Anything else, including a tool that exited with an error (its own exit code is in the envelope). Exit code 1.

## Agents and MCP

Codes from `ot mcp` and from runs without a terminal. Set-up and the consent rules are in [AI agents and MCP](/docs/agents).

### consent_required
The run, install or uninstall needs the consent of the person the agent works for. From the MCP server, the error has a `summary` to show them and a `consent_token` for that exact call (valid once, for 10 minutes). Call again with the token only if they say yes. From `ot run` without a terminal, ask them and run again with `--yes`. Exit code 2.

### consent_declined
The person declined. Don't run it again for the same target unless they ask.

### consent_token_invalid
The `consent_token` was for a different call (other arguments), was already used, or has expired. Call without it to get a new one, and ask again.

### consent_expired
A consent answer arrived for a call that changed or is more than 10 minutes old. Call the tool again.

### agent_disabled
The person turned agents off (`enabled: false` in the agent policy). Only they can change it. Exit code 4 from `ot run`.

### tool_not_allowed
The package is in the policy's `deny_tools`, or not in its `allow_tools`. Exit code 4 from `ot run`.

### rate_limited
The session reached one of the policy's run limits (`max_runs_per_hour`, `max_runs_per_target_per_hour`). Wait `retry_after_s` seconds.

### sandbox_unavailable
The policy is in sandbox mode, which runs tools only on their own test input, and this tool has none.

### run_not_found
No saved run, or no run in this session, has that `run_id`. `list_runs` lists them.

### batch_not_found
No batch in this session has that `batch_id`. Its runs are still saved; `list_runs` with the batch's case lists them.

### playbook_not_found
No playbook has that name. `list_playbooks` lists them.

### no_runs
There are no saved runs (or not enough to compare) for that tool, target or case.

## Tokens

### insufficient_scope
The API token has no scope for this call; `required_scope` names the one it needs (see [Registry API](/docs/api#signing-in-tokens-and-scopes)). Create a token with it (`ot token create --scope publish`), or use one that has it. Staff actions need a token made on the website by a signed-in reviewer or admin.

### invalid_scope
A scope in the request is not one of read, publish, manage, feedback and staff.

### token_not_found
No token of yours has that id; `ot token list` lists them.

