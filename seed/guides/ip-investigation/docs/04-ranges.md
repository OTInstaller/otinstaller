# Ranges and neighbours

Organisations with their own address space (an ASN of their own, a `/24` registered to them) usually put related
systems close together.

## Work with the range

```
ot run osintverse-community/mapcidr --cidr 192.0.2.0/28
```

mapcidr expands a range into its addresses, and with its other options counts, splits or aggregates ranges. Use it to
turn the block from [ownership](02-ownership.md) into a list you can look up one by one with the passive tools in
[exposure](03-exposure.md).

## Neighbours

- Addresses in the same block registered to the same organisation are likely theirs.
- In shared hosting blocks, neighbours are unrelated customers; do not attribute them.
- Certificates and host names found on neighbours (step 3) confirm or rule out a link.

## Wrap-up

Record for each address: holder and ASN, whether it is an intermediary (CDN, cloud), the services seen with their
dates, and the domains it leads to. Continue with those domains in the
[domain playbook](https://otinstaller.com/guides/osintverse-community/domain-investigation).
