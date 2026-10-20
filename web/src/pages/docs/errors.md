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

### sync_rate_limited
At most 10 manual syncs per package per hour.

### github_permission_required
The GitHub App needs write access to contents, workflows and pull requests to open a pull request. Accept its updated permissions in your GitHub settings.

### gitlab_scope_required
Opening merge requests needs GitLab write access. Sign in again with GitLab from the import page and grant it.
