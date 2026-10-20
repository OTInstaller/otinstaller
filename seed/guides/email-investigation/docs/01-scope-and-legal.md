# Scope and legal

- **Purpose first.** Write down the question: "Did this invoice really come from our supplier?" or "Which services
  does this fraud contact use?" Collect only what answers it.
- **Personal data.** An email address usually identifies a person. Check the rules that apply to you (GDPR, the
  journalism exemptions, your employer's policy) before you look up an address that is not yours or your
  organisation's.
- **No contact.** Account checks such as `holehe` use the sign-up and password-reset forms of each site in a way that
  does not send the owner an email. Never trigger real password resets or log-in attempts on someone else's account.
- **Headers are evidence.** If the message may end up in court or with law enforcement, export the original `.eml`
  file and keep it unchanged; work on a copy.

> [!WARNING]
> Everything above the topmost `Received` header your own mail server added can be forged by the sender. Treat
> `From`, `Reply-To` and the older hops as claims to check, not facts.
