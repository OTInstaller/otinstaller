# Show HN (draft, not posted)

Post from a personal account with some HN history, on a weekday morning US Eastern (Tuesday–Thursday). Link to the
site, not to the blog post. Write the first comment immediately after submitting. No marketing words, no asking
for upvotes anywhere (HN penalises it). Reply to every question for the first few hours.

Planned for **Thursday 22 October 2026**, 13:00–14:00 UTC (09:00–10:00 US Eastern). The source is public
(Apache-2.0) at https://github.com/OTInstaller/otinstaller; HN readers will look at it.

---

**Title** (80 characters max):

> Show HN: OTInstaller – a package registry and CLI for OSINT tools

**URL:** https://otinstaller.com

**First comment:**

> Hi HN, I'm {name}. OSINT tools are mostly small scripts on GitHub, each with its own install steps, Python version
> and output format, and many quietly break when a target site changes. OTInstaller is a free registry for them,
> plus `ot`, a CLI that installs and runs any of them the same way:
>
>     ot install osintverse-community/holehe
>     ot run osintverse-community/holehe e:you@example.com
>
> Some details that may be interesting:
>
> - The registry indexes, it doesn't host: code stays on GitHub or GitLab, images on ghcr.io or registry.gitlab.com,
>   wheels on PyPI. Authors tag a release; their CI builds and signs it (cosign keyless, using the repo's OIDC
>   identity); the registry pins the image digest or wheel hash, runs Trivy/GuardDog and a no-network smoke test, and
>   a person reviews every new publisher's first release.
> - `ot` refuses an image whose signature doesn't match the identity recorded at publish. Tools run in containers:
>   read-only, no capabilities, non-root, no host mounts, inputs passed as arguments, never through a shell. Python
>   tools run in a container too unless you ask for a native install.
> - Tools run on your machine. Inputs and results never reach the registry; install counts are anonymous daily totals
>   (opt out with OT_NO_TELEMETRY=1).
> - Every tool declares whether it contacts the target, logs in to accounts or collects personal data, and the
>   acceptable use policy bans stalkerware, credential attacks and leaked data. Reviewers check the answers.
> - A nightly job runs each tool's test input, so a tool page tells you whether it worked last night.
> - Results come back as one JSON envelope with typed entities, so `ot auto`, playbooks and `ot extract` can chain
>   tools ("run everything that takes an email").
> - Because GitHub and GitLab sometimes ban OSINT repositories, the registry keeps backups: the image with its
>   signatures on our own mirror (same digest), the wheel, and a git bundle. If the original disappears, `ot` falls
>   back to the mirror and checks the same signature.
>
> It launches with 37 tools and 10 guides, many of them community-packaged wrappers of well-known tools (sherlock,
> maigret, holehe, theHarvester, subfinder…) that their authors can claim. The stack is Cloudflare Workers, D1, R2 and
> Queues for the registry, Astro for the site, Go for `ot`. It's all Apache-2.0:
> https://github.com/OTInstaller/otinstaller
>
> I'd love feedback on the trust model and on what would make you publish your own tool here.

---

**Answers to have ready** (short, factual):

- *Why not just pipx / Docker Hub?* Those install things; the registry adds a common manifest (typed inputs and
  outputs), signature checks tied to the source repo's CI, scans, review, health checks and a common result format.
- *Isn't this a stalking toolkit?* The tools are the same open-source tools already on GitHub. The registry adds
  declarations, review, takedowns and a public transparency page; it never sees what anyone investigates.
- *Can I self-host it?* The code is all there (API on Cloudflare Workers, D1, R2, Queues; scanner on GitHub
  Actions); `docs/publishing-setup.md` walks through the setup. It isn't packaged for self-hosting yet.
- *Who runs it / business model?* OSINTverse. The registry is free; a hosted "run in the cloud" tier may come later.
  No ads, no tracking cookies.
- *GitLab?* Yes, sign-in, publishing, import and sync.
- *Windows?* Yes: `irm https://get.otinstaller.com/ot.ps1 | iex`. Docker Desktop (or Podman) is needed for most tools.
