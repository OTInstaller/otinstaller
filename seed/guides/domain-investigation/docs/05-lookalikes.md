# Look-alike domains

Phishing and fraud campaigns register domains one letter, one TLD or one homoglyph away from the real brand.

```
ot run osintverse-community/dnstwist --domain example.com
```

dnstwist generates thousands of variants (typos, swapped letters, homoglyphs such as `rn` for `m`, other TLDs, added
words) and reports the ones that are registered, with their A, NS and MX records.

## Triage

| Signal | Why it matters |
| --- | --- |
| Has MX records | It can send and receive email, the most common use for fraud |
| Resolves to the same hosting as other suspicious domains | Same operator |
| Registered recently | Recent registrations are rarely defensive |
| Has a certificate for the name (check with `osintverse-community/crtsh-subdomains`) | Someone set up HTTPS, so it is likely in use |

> [!NOTE]
> Many look-alikes are registered defensively by the brand itself, or parked by domain resellers. Check the name
> servers and the registrant before you call one malicious.

Next: [live hosts](06-live-hosts.md).
