# Find registered accounts

Most sites tell you, one way or another, whether an address already has an account. These tools ask in ways that
do not notify the owner.

```
ot run osintverse-community/holehe --email someone@example.com
ot run osintverse-community/socialscan --query someone@example.com
```

`holehe` checks 120+ sites and lists the ones where the address is registered, sometimes with a partly masked
recovery phone or email. `socialscan` covers fewer platforms but uses their own availability checks, so its answers
are reliable.

## Reading the results

- A hit says an account exists. It does not show the profile, and many services allow an address to be registered
  without verification, so someone else may have used it.
- Rate limits produce errors, not "not registered". Re-run later rather than treating an error as a negative.
- Masked recovery details (`+1 ••• ••• ••23`, `j•••@g•••.com`) can be matched against identifiers you already hold.
  Never try to unmask them through the site's recovery flow.

> [!NOTE]
> Breach and paste lookups (Have I Been Pwned and similar) are useful here too, but need API keys and their own legal
> review. Add them only where your scope allows.

Next: [pivot](05-pivot.md).
