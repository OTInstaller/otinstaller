# Write the manifest

In your repository, run:

```
ot init --kind docker      # or --kind pipx for a tool published on PyPI
```

`ot init` writes `otinstaller.yaml`, a README if you have none, a release workflow
(`.github/workflows/otinstaller-release.yml`, or `.gitlab-ci.yml`) and, for Docker tools without a `Dockerfile`, an
example one.

## Fill it in

```yaml
schema: 1
name: username-permutations
namespace: your-github-name          # the owner of the repository
version: 0.1.0
summary: Generates likely usernames from a person's name
readme: README.md
license: MIT                          # an SPDX identifier
categories: [username]
inputs:
  - name: name
    type: name                        # email, username, domain, ip, url, phone, … or string
    required: true
outputs:
  - type: username
runtime:
  kind: docker
  image: ghcr.io/your-github-name/username-permutations@sha256:000…   # the release workflow fills this in
  platforms: [linux/amd64, linux/arm64]
  command: ["username-permutations", "{name}"]
  output_format: json                 # json, jsonl, csv or text
network:
  egress: false                       # true if the tool needs the internet
ethics:
  touches_target: false               # does it send anything to the subject's own systems?
  auth_required: false                # does it need an account or API key?
  collects_personal_data: false
test:
  input: { name: "Ada Lovelace" }     # safe values; used for checks and nightly health
```

## The parts that matter most

- **`command`**: the first word is the program, run as the container's entrypoint. Each `{input}` is replaced with
  the user's value as a single argument (never through a shell). An optional input left out drops its argument, and
  the flag just before it: `["--region", "{region}"]` disappears as a pair.
- **Output**: if your tool prints `{"entities": [{"type": "username", "value": "…"}]}` as JSON, `ot` turns it into
  the standard result envelope, so results chain into other tools. Any other output still works and is kept as is.
- **`ethics`**: answer honestly. These flags are shown on your package page and checked at review.
- **`test.input`**: values that are safe to run every night, such as public organisations, `example.com`, or
  fictional people. The registry runs the tool with them before publishing and every night after.
- **Secrets**: list API keys under `secrets:`. Users store them with `ot keys set`, and they reach your tool as
  environment variables, never in the command line.

Next: [test it locally](02-test.md).
