# Pivot

From an email address you can usually reach:

- **The username.** The local part (`janedoe` in `janedoe@example.com`) is often reused as a handle. Run it through the
  [username investigation playbook](https://otinstaller.com/guides/osintverse-community/username-investigation).
- **Other addresses.** People keep the same local part at several providers; `mailcat` checks 25+ of them:
  `ot run osintverse-community/mailcat --username janedoe`.
- **Infrastructure.** For a custom domain, the [domain playbook](https://otinstaller.com/guides/osintverse-community/domain-investigation)
  finds its subdomains, hosting and history.
- **Senders' servers.** The IPs from the headers lead to hosting providers and, sometimes, other domains on the same
  server: see the [IP playbook](https://otinstaller.com/guides/osintverse-community/ip-investigation).

## Write it up

For each finding, keep the source (header field, tool name and version, date) and how confident you are. For
phishing cases, the useful output is usually short: the real sending infrastructure, the authentication result, the
reply-to address, and the domains to block.
