# Test it locally

## Validate

```
ot validate
```

This checks the manifest exactly as the registry will: required fields, names, the command's placeholders against
your inputs, the files it names, and that `test.input` covers every required input. Each problem comes with an
[error code](https://otinstaller.com/docs/errors) and a hint.

## Try the image in the same sandbox

Before your first release there is no published image yet, so build it yourself and run it the way `ot` will: as an
unprivileged user, on a read-only file system, without capabilities, and with no network unless `network.egress` is
true.

```
docker build -t username-permutations-test .
docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --user 65534:65534 --network none \
  username-permutations-test "Ada Lovelace"
```

Common problems:

| Problem | Fix |
| --- | --- |
| The tool writes files and fails on a read-only file system | Write to `/tmp`, or print to standard output |
| It works as root and fails as a normal user | Don't depend on root; `ot` always runs tools as an unprivileged user |
| It needs the internet but `egress` is false | Set `network.egress: true` and, if you can, list the `domains` it contacts |
| The output isn't parsed | Print one JSON document (or one per line with `jsonl`) and nothing else on standard output; logs go to standard error |

## The smoke test

```
ot validate --smoke
```

This installs the package exactly as the manifest describes it (pulling the pinned image, or the pinned wheel from
PyPI) and runs `test.input`, as the registry's scanner does. Use it on a pipx tool at any time, and on a Docker tool
once the release workflow has pinned a real image digest. You can also run a local manifest like a published package:

```
ot run . --name "Ada Lovelace" --format table
```

Next: [release](03-release.md).
