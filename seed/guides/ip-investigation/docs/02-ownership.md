# Who holds the address

```
ot run osintverse-community/ipwhois --ip 1.1.1.1
```

RDAP, the structured successor to WHOIS, returns:

- **The network block** (`asn_cidr`, `network.cidr`) and its name.
- **The ASN** and its description: the organisation that routes the block. `AS13335 CLOUDFLARENET` is Cloudflare.
- **The registry** (ARIN, RIPE, APNIC, LACNIC, AFRINIC) and country.
- **Entities**: the holder, administrative and abuse contacts, often with an organisation name and address.

Then check whether the address belongs to an intermediary:

```
ot run osintverse-community/cdncheck --target 1.1.1.1
```

If it is a CDN, WAF or cloud provider, the IP tells you about the provider, not the site behind it. Pivot back to
the domain instead (historical DNS, certificates); see the
[domain playbook](https://otinstaller.com/guides/osintverse-community/domain-investigation).

> [!TIP]
> Hosting providers that sell small VPSs (DigitalOcean, OVH, Hetzner, Vultr and others) are common for both
> legitimate projects and throwaway infrastructure. The provider alone tells you little; what runs on it does.

Next: [what it exposes](03-exposure.md).
