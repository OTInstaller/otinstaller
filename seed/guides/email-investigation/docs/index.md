# Email investigation playbook

An email address is one of the strongest identifiers you can get: it is unique, people keep it for years, and most
services use it for sign-up. This playbook covers two common cases:

- **A suspicious message** (phishing, fraud, harassment): where did it really come from?
- **An address of interest**: which services is it registered with, and what else does it lead to?

**Steps**

1. [Scope and legal](01-scope-and-legal.md)
2. [Read the message headers](02-headers.md)
3. [Check the sender's domain](03-domain.md)
4. [Find registered accounts](04-accounts.md)
5. [Pivot](05-pivot.md)

**Tools used** (`ot guide tools osintverse-community/email-investigation` installs them all):

| Tool | Used for |
| --- | --- |
| [osintverse-community/email-header-parser](https://otinstaller.com/osintverse-community/email-header-parser) | Senders, relay hops, IPs and authentication results |
| [osintverse-community/checkdmarc](https://otinstaller.com/osintverse-community/checkdmarc) | The domain's SPF, DMARC and MX setup |
| [osintverse-community/dns-records](https://otinstaller.com/osintverse-community/dns-records) | The domain's other DNS records |
| [osintverse-community/holehe](https://otinstaller.com/osintverse-community/holehe) | Sites where the address has an account |
| [osintverse-community/socialscan](https://otinstaller.com/osintverse-community/socialscan) | Accurate checks on major platforms |
