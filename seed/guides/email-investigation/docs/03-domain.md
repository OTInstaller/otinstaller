# Check the sender's domain

The part after the `@` tells you who runs the mailbox: a free provider, a company, or a domain someone registered
for this purpose.

```
ot run osintverse-community/checkdmarc --domain example.com
ot run osintverse-community/dns-records --domain example.com --types MX,TXT,NS
```

Read the results with these questions:

- **Who handles the mail?** MX records pointing at `google.com`, `outlook.com` or `protonmail.ch` show the provider.
  No MX at all, or a null MX, means the domain does not receive mail, so a reply would bounce.
- **Is spoofing possible?** No DMARC record, or `p=none`, means anyone can send as this domain and most receivers will
  accept it. `p=reject` with a pass in your headers means the message really came through an authorised server.
- **What else does the domain run?** TXT records often hold verification tokens for Google Workspace, Microsoft 365,
  Atlassian, Facebook and others, which tells you which services the organisation uses.
- **Is it new or a look-alike?** A domain registered last week, or one letter away from a real brand, is a phishing
  sign. Check with the [domain investigation playbook](https://otinstaller.com/guides/osintverse-community/domain-investigation),
  which covers registration history and look-alikes with `dnstwist`.

Next: [find registered accounts](04-accounts.md).
