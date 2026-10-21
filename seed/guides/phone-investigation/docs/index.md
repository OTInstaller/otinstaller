# Phone number investigation playbook

A phone number carries more than it seems: the country and area, the carrier the range was assigned to, the line
type, and often the accounts registered with it.

**Steps**

1. [Scope and legal](01-scope-and-legal.md)
2. [Parse the number](02-parse.md)
3. [Accounts and mentions](03-accounts-and-mentions.md)

**Tools used** (`ot guide tools osintverse-community/phone-investigation`):

| Tool | Used for |
| --- | --- |
| [osintverse-community/phone-parse](https://otinstaller.com/osintverse-community/phone-parse) | Validity, formats, region, original carrier, line type, time zones (offline) |
| [osintverse-community/phoneinfoga](https://otinstaller.com/osintverse-community/phoneinfoga) | Number scan and search links for where it appears |
| [osintverse-community/ignorant](https://otinstaller.com/osintverse-community/ignorant) | Accounts registered with the number |

All examples use `+1 202-555-0123`, a number in the North American range reserved for fiction.
