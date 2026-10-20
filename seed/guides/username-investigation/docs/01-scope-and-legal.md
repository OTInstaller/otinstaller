# Scope and legal

Username searches only read public pages, but the result is a profile of a person, and that is personal data in most
jurisdictions. Decide these before you run anything:

- **Purpose.** Write down why you are looking and what question you need answered. "Is this seller the same person
  as that forum account?" is a scope; "everything about them" is not.
- **Lawful basis.** Journalism, an employer's fraud investigation, due diligence and a security assessment you were
  hired for each have their own rules (GDPR Article 6 and the journalism exemptions in the EU and UK, privacy and
  anti-stalking laws elsewhere). If you are not sure, ask before you collect.
- **Terms of service.** The tools here make ordinary, unauthenticated requests. Do not log in to platforms with
  fake accounts to see more, and do not use the results to contact or harass anyone.
- **Minimisation.** Keep the accounts that answer your question, with the date you found them and how. Delete the
  rest when the case closes.

> [!WARNING]
> A matching username is a lead, not an identification. Common handles (`alex`, `admin`, `john_smith`) belong to
> many people. Never act on a match you have not [verified](04-verify-and-pivot.md).

## Operational security

These tools send requests from your machine, so the sites see your IP address, though not the person you are
looking for. If that matters for your case, run them from a VPS or through a VPN you are allowed to use.
`ot run` keeps each tool in a sandbox with no access to your files.
