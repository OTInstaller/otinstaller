# Username investigation playbook

A username is often the thread that ties someone's accounts together: people reuse handles across forums, code
hosts, games and social networks for years. This playbook takes you from a name or one known handle to a verified
list of accounts, without contacting the person.

**You will:**

1. [Set the scope](01-scope-and-legal.md) and decide what you may collect.
2. [Build a list of candidate usernames](02-candidates.md) from a name or a known handle.
3. [Find accounts](03-find-accounts.md) with three complementary tools.
4. [Verify each hit and pivot](04-verify-and-pivot.md) to the next identifier.

**Tools used** (install them all with `ot guide tools osintverse-community/username-investigation`):

| Tool | Used for |
| --- | --- |
| [osintverse-community/username-permutations](https://otinstaller.com/osintverse-community/username-permutations) | Turning a name into likely handles |
| [osintverse-community/sherlock](https://otinstaller.com/osintverse-community/sherlock) | Fast check of 400+ sites |
| [osintverse-community/maigret](https://otinstaller.com/osintverse-community/maigret) | Deeper check of 3,000+ sites, with profile details |
| [osintverse-community/socialscan](https://otinstaller.com/osintverse-community/socialscan) | Accurate checks on the big platforms |
| [osintverse-community/naminter](https://otinstaller.com/osintverse-community/naminter) | A second opinion from the WhatsMyName list |
| [osintverse-community/mailcat](https://otinstaller.com/osintverse-community/mailcat) | Email addresses that share the handle |

> [!NOTE]
> Every example here uses `github`, an organisation's public handle, or fictional people. Replace them with your
> own subject only when your scope allows it.
