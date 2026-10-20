# Publish your first tool

This guide takes a command-line OSINT tool in a GitHub repository to a published package that anyone can run with
`ot run`. It takes about 20 minutes. You need:

- a public GitHub repository with your tool (GitLab works the same way; see the notes on each page)
- the `ot` CLI: `ot doctor` checks Docker and Python
- Docker, if you want to test the image locally

**Steps**

1. [Write the manifest](01-manifest.md)
2. [Test it locally](02-test.md)
3. [Release](03-release.md)

The example is [osintverse/username-permutations](https://otinstaller.com/osintverse/username-permutations), a small
Python script packaged as a Docker tool.

> [!TIP]
> If your repository is on GitHub or GitLab, the [import wizard](https://otinstaller.com/import) does steps 1 and 3
> for you and opens a pull request you can review.
