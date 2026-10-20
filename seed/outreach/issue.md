<!--
Outreach issue for a third-party tool's repository. Replace {{…}} before posting. Post it yourself, from your own
account, one repository at a time; read the project's CONTRIBUTING file first and skip projects that ask for no
packaging requests. Open the pull request (pr.md) only after the issue, or together with it if the project prefers PRs.
-->

**Title:** Publishing {{tool}} on the OTInstaller Registry?

Hi {{maintainer}}, thanks for {{tool}}. It's one of the tools OSINT investigators reach for first when they {{use case}}.

We're launching the [OTInstaller Registry](https://otinstaller.com), a free, open registry of OSINT tools and guides.
Users run `ot install {{namespace}}/{{tool}}` and `ot run {{namespace}}/{{tool}} --{{input}} …` and get the same
sandboxed install on Windows, macOS and Linux. Results come back in a common JSON format, so they can be chained with other
tools.

If you're interested, it takes one file, `otinstaller.yaml`, which says what inputs the tool takes and how to run it.
{{route}}

What you get:
- Your project stays the source of truth. The registry publishes releases when you push a version tag and links back here.
- Every release is checked: signature, malware heuristics, secrets and a smoke test on a safe test input. A nightly health
  check opens a notice if the tool stops working.
- Your package page shows the license, the ethics flags you set (does it contact the target, does it need an account),
  and install counts.

No account or payment is needed; installing the OTInstaller GitHub App on the repository is what lets tags publish.

I'm happy to open a pull request with a working `otinstaller.yaml`{{ and a release workflow}} you can review, or to answer
questions here. If it's not something you want, just close this issue; no follow-ups.

<!--
{{route}} is one of:

- PyPI (pipx) tool: "Because {{tool}} is already on PyPI, the manifest only points at your published wheel by version and
  hash; nothing new needs to be built."
- Docker tool: "The PR would add a small Dockerfile and a GitHub Actions workflow that builds a multi-arch image, signs
  it with Sigstore (keyless, tied to this repository) and pins its digest in the manifest when you run it."
-->
