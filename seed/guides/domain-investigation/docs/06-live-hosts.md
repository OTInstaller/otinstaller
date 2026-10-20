# Live hosts (active)

> [!WARNING]
> This step sends requests to the target's servers. Do it only within your [scope](01-scope-and-legal.md).

## What a web server runs

```
ot run osintverse-community/httpx --target https://example.com
```

httpx reports the status code, page title, server software and detected technologies (CMS, frameworks, analytics),
the IP and whether a CDN is in front. Titles and technologies are a quick way to sort a long subdomain list into
"login portal", "default page", "marketing site" and "API".

## What certificate it presents

```
ot run osintverse-community/tlsx --host example.com
```

The certificate's subject alternative names often list other domains served from the same machine, a strong pivot
to infrastructure owned by the same operator. The issuer and validity dates help date the setup.

## Wrap-up

You now have the domain's DNS, its subdomains (current and historical), archived content, look-alikes, and what
the live servers run. Continue with the IPs in the [IP playbook](https://otinstaller.com/guides/osintverse-community/ip-investigation).
