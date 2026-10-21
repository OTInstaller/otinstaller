# r/OSINT (draft, not posted)

Read the subreddit's sidebar rules on the day and follow them; many OSINT subreddits limit self-promotion and remove
posts that look like ads. Post from a personal account that already takes part there, as a text post, and say you
built it. Message the moderators first if the rules ask for it. Don't cross-post the same text to several
subreddits on the same day. Never use a real private person in an example.

**Title:**

> I built a free registry + CLI that installs and runs OSINT tools the same way (sherlock, holehe, theHarvester, subfinder…). Feedback wanted

**Body:**

> Disclosure: I work on this at OSINTverse. It's free, open source (Apache-2.0,
> https://github.com/OTInstaller/otinstaller) and there's nothing to buy.
>
> Most of us keep a folder of half-working tool installs: different Python versions, tools that broke when a site
> changed, output in five formats. OTInstaller (https://otinstaller.com) is a registry of OSINT tools and guides, and
> `ot` is a CLI that installs and runs any of them in the same way:
>
> ```
> ot run osintverse-community/sherlock u:johndoe
> ot run osintverse-community/holehe e:you@example.com
> ot auto you@example.com          # runs every installed tool that takes an email
> ```
>
> What might matter to this sub:
>
> - **Runs locally.** Tools run on your machine in a locked-down container. Your targets and results never reach
>   the registry.
> - **Does it still work?** Each tool's test runs every night; the tool page shows Healthy or Possibly broken.
> - **Trust.** Releases are pinned and signed by the author's CI, scanned, and a person reviews every new publisher.
>   Each tool declares whether it contacts the target, logs in to accounts or collects personal data.
> - **Same output.** Every tool returns one JSON format with typed entities (accounts, emails, domains…), saved with
>   a SHA-256 and metadata sidecar, which helps with notes and reporting.
> - **Guides.** 8 playbooks (email, username, domain, IP, phone, image, social media, crypto) that install the tools they use.
> - **Backups.** If a tool's repo is taken down on GitHub, installs keep working from the registry's mirror.
>
> Many tools are community-packaged wrappers of existing projects, credited to their authors, who can claim them.
> Rules: no stalkerware, credential attacks or leaked data; reports go to people who act on them, and every removal
> is listed publicly.
>
> Windows, macOS and Linux; most tools need Docker or Podman. Install:
> `curl -fsSL https://get.otinstaller.com/ot | sh` or, on Windows, `irm https://get.otinstaller.com/ot.ps1 | iex`.
>
> What tool should be on it that isn't? And if you maintain a tool, I'd like to help you publish it.
