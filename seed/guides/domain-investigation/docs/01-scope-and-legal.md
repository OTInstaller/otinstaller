# Scope and legal

- **Passive vs active.** DNS lookups, certificate logs and archives never touch the target's servers, and are fine
  for almost any purpose. [Probing live hosts](06-live-hosts.md) sends requests to the target and needs a reason
  you can defend; port scanning and vulnerability testing need written permission from the owner.
- **Stay in scope.** Subdomain lists often include third-party services (`status.`, `mail.`, a CDN). Being listed under
  a domain does not make a server part of your authorised scope.
- **Personal data.** Registration records and archived pages can contain names, addresses and phone numbers. Collect
  them only if your question needs them.

> [!TIP]
> Note the date of every lookup. DNS answers and certificates change; your notes should say what was true when.
