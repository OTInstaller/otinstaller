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

### manifest_example_invalid
An input's `example` doesn't suit its type: text for an `integer` or `boolean` input, a number for a text input, a value that isn't one of an `enum`'s `values`, or an email address without `@`. Give a value as a user would type it.

### manifest_secret_duplicate
Two secrets have the same name.

### manifest_test_input_unknown
`test.input` sets a value for something that is not an input.

### manifest_test_input_missing
A required input has no value in `test.input`.

### manifest_file_missing
A file the manifest names (the README, a guide or docs page, an image) is not in the repository at the tagged commit, or not in the upload, or `otinstaller.yaml` itself is missing. Commit it and tag again, or run `ot publish` again.

### manifest_tag_mismatch
The tag must be `v` followed by `version`, for example `v1.2.0` for `version: 1.2.0`.

### manifest_namespace_mismatch
`namespace` must be the GitHub or GitLab owner of the repository the release comes from.

### manifest_version_exists
This version is already published (or being published), and versions never change. Bump `version` and tag or upload again.

### manifest_name_taken
Another repository already publishes a package with this name in your namespace. Uploads with `ot publish` are refused for a package a repository publishes: release it from that repository.

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
The image signature did not verify against the repository's CI identity. For a package published directly, the signature is not from the identity that signed its earlier versions.

### signature_dropped
Earlier versions were signed and this one is not. Release it with the signing workflow, or sign it as before.

### signature_ambiguous
The first signed version of a package published directly has signatures from more than one identity. Later versions are held to the first signer, so it must have exactly one. Sign once and upload again.

### malware_suspected
Malicious-code heuristics matched. A reviewer looks at the report.

### secrets_found
The image or package contains embedded secrets. Rotate them and rebuild.

### smoke_test_failed
The tool failed on its `test.input` (run without network unless `network.egress` is set). Try `ot validate --smoke`.

### scan_timeout
The scan or content checks did not finish within an hour. Push the tag again (or run `ot publish` again).

### internal_error
Something failed on the registry's side. Push the tag again (or run `ot publish` again); if it keeps failing, write to support@otinstaller.com with the request ID from the message.

## Uploading with ot publish

### namespace_unknown
The manifest's `namespace` doesn't exist on the registry. Create it with `ot namespace create <name>`, or use one you belong to.

### namespace_taken
That namespace already exists. Pick another name, or ask its owners to add you.

### namespace_reserved
The name is one the registry uses for its own pages and paths (such as `docs` or `private`). Pick another.

### namespace_account_required
The name is a GitHub or GitLab account's. A person's name needs that account linked to yours (Settings → Accounts). An organisation's or group's namespace comes from installing the GitHub App on it or connecting one of its GitLab projects.

### namespace_limit
One account can create at most three namespaces. Publish into one you have, or write to support@otinstaller.com.

### account_check_failed
The registry could not ask GitHub or GitLab whether the name is an account's. Try again in a minute.

### bundle_invalid
The upload is not what `ot publish` sends. It must be multipart, with one part per file named by its relative path and `otinstaller.yaml` among them, at most 300 files, and the query naming the manifest's namespace, name and version.

### bundle_too_large
The upload is over 25 MB. Only the manifest, its README and pages, and their images are needed; leave other files out.

### publish_in_progress
The same version is already being validated. Wait for it (`ot publish --wait`, or the dashboard).

### publish_rate_limited
A namespace can upload at most 20 releases an hour. Wait and try again.

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

## Signing in and accounts

### unknown_provider
Sign in with `github`, `gitlab` or `osintverse`; device sign-in and imports accept `github` or `gitlab`.

### oauth_state_mismatch
The sign-in took too long or the callback was tampered with. Start the sign-in again from the same browser.

### account_already_linked
That GitHub, GitLab or OSINTverse account is already linked to another OTInstaller user. Sign in as that user, or unlink it there first.

### provider_already_linked
Your account already has a different account from that provider. Unlink it in [Settings](/settings/accounts) before linking another.

### github_not_linked
Importing from GitHub or opening a pull request needs a linked GitHub account. Sign in with GitHub from [Settings](/settings/accounts).

### gitlab_not_linked
Importing from GitLab or connecting a GitLab project needs a linked GitLab account. Sign in with GitLab from [Settings](/settings/accounts).

### no_email
Your account has no email address, so the registry cannot send you anything. Add one on the provider you signed in with and sign in again.

### invalid_email
The email address on a feedback message does not look like one. Leave it empty if you don't want a reply.

### invalid_kind
Feedback is `bug`, `idea`, `question` or `other`; an import is `docker`, `pipx` or `guide`.

### feedback_not_found
No feedback message has that id.

## Importing and connecting repositories

### invalid_repo
Give the repository as a URL such as `https://github.com/owner/name` or `https://gitlab.com/group/name`, or as `owner/name` for GitHub.

### too_many_repos
A bulk import takes at most 50 repositories at once.

### repo_not_found
The GitHub repository does not exist, or your account cannot see it.

### repo_not_public
Only public repositories can publish to the registry. Make it public, or keep it off the registry.

### project_not_found
The GitLab project does not exist, or your account cannot see it.

### project_not_public
Only public GitLab projects can publish to the registry.

### not_admin
Importing a GitHub repository needs admin access to it. If it is someone else's tool, an `osintverse-community` admin can package it as a community wrapper instead.

### not_maintainer
Importing or connecting a GitLab project needs Maintainer access or above.

### not_repo_owner
Only the repository's owner, or an owner of its organisation or group, can keep its manifest on the registry. Finish the import as a pull or merge request instead.

### not_community_admin
Only `osintverse-community` admins can package tools they don't own as community wrappers.

### community_namespace_missing
The `osintverse-community` namespace does not exist on this registry yet. An operator installs the GitHub App on its organisation first.

### app_not_installed
The OTInstaller GitHub App is not installed on that repository, so the registry cannot read tags or open pull requests there. The message links to the install page; pick the repository when GitHub asks.

### already_published
That repository already publishes a package. Edit the package from its [dashboard](/dashboard) page instead of importing it again.

### upstream_has_manifest
The upstream repository already has an `otinstaller.yaml`, so its maintainer can publish it directly and it needs no community wrapper.

### license_not_redistributable
Community wrappers only package tools whose license lets the registry redistribute them (OSI-approved licenses and the AGPL). The repository has no such license, or none at all. Ask its maintainer to publish it themselves.

### import_not_detected
Detection of the repository has not finished, or failed. Wait for it, or start the import again.

### import_finished
That import is finished. Change the package from its dashboard page, or edit `otinstaller.yaml` in the repository.

### import_not_found
No import of yours has that id.

### invalid_mode
An import finishes as `pr` (a pull or merge request adding `otinstaller.yaml`), `registry` (the manifest is kept on the registry), `connect` (the repository already has a manifest) or `wrapper` (a community wrapper, only for community imports).

### manifest_in_repo
The repository already has `otinstaller.yaml`, so the registry does not hold a manifest for it. Edit the file in the repository, or finish the import with mode `connect`.

### manifest_name_mismatch
A registry-held manifest cannot change the package's `namespace` or `name`. To move it to another namespace, use `ot transfer` instead.

### wrapper_required
Finishing a community import needs the wrapper repository, for example `{"mode": "wrapper", "wrapper_repo": "https://github.com/osintverse-community/<name>"}`.

### wrapper_not_community
The wrapper repository must belong to the `osintverse-community` organisation.

### mirror_already_imported
A wrapper for that upstream repository already exists; the message names it.

### source_not_found
The package has no connected source repository, or no source has that id.

### same_source
That repository is already the package's source.

### source_in_use
That repository is already the source of another package. A repository publishes one package.

### already_connected
Someone else connected that GitLab project to the registry; only they, or an admin, can change its connection.

## Publisher profiles

### profile_sync_rate_limited
At most 10 profile syncs per namespace per hour. The registry also refreshes every profile from GitHub and GitLab every 6 hours.

### host_account_not_linked
To show a GitHub or GitLab account, org or group on your profile, first link that host to your OTInstaller account: sign in with it from [Accounts and sync](https://otinstaller.com/settings/accounts) while signed in.

### host_not_found
The org or group does not exist, is not public, or your account cannot see it. Check the spelling (GitLab subgroups are paths such as `acme/osint`).

### host_not_owned
Only an owner of a GitHub organization, or an Owner of a GitLab group, can show it on a profile. Ask one of them to link it.

### host_already_primary
The namespace already belongs to that host. A profile can link the other host (GitLab for a GitHub namespace, GitHub for a GitLab one).

## Transfers and claims

### namespace_not_found
No namespace has that name. Namespaces come from installing the GitHub App or connecting GitLab.

### same_namespace
The package is already in the namespace you named.

### transfer_not_found
No transfer or claim has that id, or your account is not part of it.

### not_a_claim
Only claims are verified against the upstream repository; transfers are accepted by the receiving namespace.

### not_a_transfer
Claims are completed by an admin once they are verified; only transfers are accepted by the receiving namespace.

### not_accepted
The receiving namespace has not accepted the transfer yet.

### not_verified
The claim has not been verified yet. Add the verification file to the upstream repository and run the check again.

## Reviewers and admins

### not_pending
The namespace or version is not waiting for review, so it cannot be approved or rejected again; the message gives its state.

### namespace_in_review
The version belongs to a namespace that is not active. Approve or reject the namespace instead; its waiting versions follow.

### report_not_found
No report has that id.

### user_not_found
No user has that id.

### cannot_ban_admin
Admins cannot be banned. Remove the admin role first.

### invalid_category
Removal categories are those on the [transparency page](/policy/transparency); the message lists them.

### invalid_replacement
A deprecation's replacement must be a published package, given as `namespace/name`.

### not_configured
This server is missing a secret the request needs (for example the health token or the email key), so the feature is off here. Operators: see the configuration reference.

## Pages and assets

### readme_not_found
The package has no rendered README. It is rendered when a version is published.

### docs_not_found
The tool ships no docs. Tools add pages with the `docs:` field in `otinstaller.yaml`; guides are read from `/guides`.

### page_not_rendered
The page is listed in the manifest but was not rendered for that version. Publishing the next version renders it; if that fails too, write to support@otinstaller.com.

### asset_not_found
No image with that hash and extension exists.

## Backups and internal calls

### backup_not_found
There is no public wheel copy for that version. Backups exist only for published versions of public repositories with a redistributable license.

### too_large
A backup item was over its limit (git bundles 500 MiB, images 2 GiB, wheels 1 GiB), so it was not stored. Shrink the artifact or repository; the registry still serves the original.

### url_expired
The signed upload or download link has passed its expiry. Ask for a fresh link; backup jobs get new ones on each run.

### invalid_signature
The signed link's signature does not match its path and expiry, or the path is not a backup object. Use the link exactly as the registry gave it.

### length_required
Uploads to a signed link must send `Content-Length`.

### invalid_scan_token
The scan token is unknown, has expired (an hour after dispatch) or was already used. The registry dispatches a new scan when the tag is pushed again.

### invalid_scan_results
The scan results body does not match what the registry expects; the message names the field.

### payload_too_large
A webhook body over 5 MB, or scan results over their limit, is refused.

### bad_signature
The webhook's signature or token does not match the registry's. Check the webhook secret on the GitHub App or the GitLab project.

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
A tool the command needs isn't installed, and there is no terminal to ask whether to install it (or you said no). Exit
code 2. The `hint` names the command that fixes it:

- `ot run` on a tool that isn't installed: run `ot install` first, or pass `--yes`.
- `ot playbook` with tools missing: `ot install` them, or pass `--yes`.
- `ot run --all` or `ot auto` when no installed tool takes the target, as on a fresh machine:
  `ot playbook <playbook> <type>:<value> --yes` installs a bundled playbook's tools for that type and runs them. At a
  terminal, `ot` offers this itself. For a URL there is no bundled playbook; find tools with `ot search --input url`.
- Through `ot mcp`, `run_all` and `run_playbook` never install anything: install the tools with `install_tool`, which
  asks the person. `run_all` lists the bundled playbook's tools in `suggested_tools`.

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
The `consent_token` was for a different call (other arguments), was already used, or has expired. Tokens also die with the server: one from before `ot mcp` restarted (a new client session, or a client that starts the server for each call) never works. Call without it to get a new one, and ask again.

### consent_expired
A consent answer arrived for a call that changed or is more than 10 minutes old. Call the tool again.

### agent_disabled
The person turned agents off (`enabled: false` in the agent policy). Only they can change it. Exit code 4 from `ot run`.

### policy_invalid
The agent policy file (`<ot home>/agent-policy.json`) is not valid JSON or has a bad value, so agents may do nothing until it is fixed. `ot mcp policy` shows the problem; `ot mcp policy reset` writes the defaults.

### tool_not_allowed
The package is in the policy's `deny_tools`, or not in its `allow_tools`. Exit code 4 from `ot run`.

### rate_limited
The session reached one of the policy's run limits (`max_runs_per_hour`, `max_runs_per_target_per_hour`). Wait `retry_after_s` seconds.

### sandbox_unavailable
The policy is in sandbox mode, which runs tools only on their own test input, and this tool has none.

### run_not_found
No saved run, or no run in this session, has that `run_id` (eight letters and digits, as `ot run` and `run_tool` print
it). `ot runs` lists the saved runs, and so does `list_runs` through `ot mcp`. From `ot runs <run-id>`, exit code 2.

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

