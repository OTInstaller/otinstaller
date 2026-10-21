# Publishing your tool during the beta (draft)

A step-by-step guide for invited authors. It matches what was tested end to end on production on 21 October 2026
(GitHub: `dheerajydv19/ot-test-tool` 0.3.6; GitLab: `osintversehq/ot-test-tool`). Suggested home: a page on the site
or a pinned issue; until then, link this file.

**About 30 minutes. You need:** the repository's admin (GitHub) or Maintainer (GitLab) role, and a tool that runs
from the command line and prints its results (JSON is best).

During the beta, a new namespace's first release waits for a reviewer, usually less than a day. After that, each
tag you push is published automatically once its checks pass, usually within two minutes.

---

## GitHub

1. **Sign in.** https://otinstaller.com → Dashboard → *Sign in with GitHub*.
2. **Import the repository.** Open https://otinstaller.com/import, stay on the *GitHub* tab and click *Import* next
   to your repository. (Not listed? The page shows repositories where you are an admin.)
   - The registry detects a Dockerfile, a Python console script (`pyproject.toml`) or a `docs/` folder and drafts
     `otinstaller.yaml`. Fill in what it couldn't guess: the inputs your tool takes (email, username, domain, …),
     what it outputs, the command line, and the three ethics questions.
   - Click *Open pull request*. GitHub asks you to install the **OTInstaller** GitHub App on the repository; that is
     how the registry hears about new tags.
   - From the terminal instead: `ot login`, then `ot import https://github.com/you/tool`.
3. **Merge** the pull request. It adds `otinstaller.yaml` and `.github/workflows/otinstaller-release.yml`.
4. **Release.** *Actions* → *otinstaller release* → *Run workflow*, with the version (for example `1.0.0`). The
   workflow builds a multi-arch image (or publishes to PyPI for Python tools), signs it with Sigstore, pins its
   digest in `otinstaller.yaml` and pushes the tag `v1.0.0`.
5. **Watch it.** The commit gets a status check (*OTInstaller Registry*) and your dashboard shows each step:
   validated, scanned, waiting for review (first release only), published.
6. **Try it.** `ot install you/tool`, then `ot run you/tool <input>`.

## GitLab

1. **Sign in.** https://otinstaller.com → Dashboard → *Sign in with GitLab* (or link GitLab under Settings →
   Accounts if you already signed in with GitHub).
2. **Import the project.** Open https://otinstaller.com/import, choose the *GitLab* tab, click *Import* next to
   your project. The page lists public projects where you are at least Maintainer.
   - Connecting creates a webhook on the project, so GitLab asks once for API access (*Authorize*). This is the
     only step that needs it.
   - If the project already has `otinstaller.yaml`, click *Connect*. Otherwise fill in the draft and click *Open
     merge request*; it adds `otinstaller.yaml` and the release job (`.gitlab-ci.yml`, or
     `.gitlab/otinstaller-release.yml` with a note to include it if you already have a pipeline).
3. **Let the pipeline push the release.** Project → *Settings* → *CI/CD* → *Job token permissions* → tick **Allow
   Git push requests to the repository** → *Save changes*. (No token to create. On a paid plan you can instead set
   a `RELEASE_TOKEN` CI/CD variable with `write_repository`.)
4. **Merge** the merge request.
5. **Release.** Set `version:` in `otinstaller.yaml` to the version to release (for example `1.0.0`) and commit.
   Then *Build* → *Pipelines* → *Run pipeline* (no variables needed). The job builds and signs the image with
   GitLab's OIDC token (or publishes to PyPI), pins it in `otinstaller.yaml`, and pushes the tag `v1.0.0`.
6. **Watch it** on your dashboard, then `ot install you/tool` and `ot run you/tool <input>`.

## If something goes wrong

- **The release was rejected.** The commit status and your dashboard name the problem (for example
  `manifest_schema: missing summary`) with a hint. Fix it, bump the version, release again.
- **Scans fail on something you can't fix** (an upstream CVE with no fix, say): tell us with `ot feedback`. A
  reviewer can accept a warning.
- **Nothing happens after the tag.** Run `ot sync you/tool`; it checks the repository right away and
  `ot sync --log you/tool` shows what the registry saw.
- **Anything confusing**, even small: `ot feedback "…"` or https://otinstaller.com/feedback. Blocking bugs:
  https://github.com/OTInstaller/feedback/issues, with the *Bug report* form.

## What we'll ask you afterwards

A five-minute survey ([feedback-survey.md](feedback-survey.md)): how long publishing took, where you got stuck,
and whether you'd recommend it to another tool author.
