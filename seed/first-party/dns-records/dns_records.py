#!/usr/bin/env python3
"""Looks up a domain's A, AAAA, CNAME, MX, NS, TXT, SOA and CAA records.

Prints {"entities": [...], "records": {...}}: one dns_record entity per record, plus ip and domain
entities for the addresses and hosts the records point to.
"""
import argparse
import json
import sys

import dns.exception
import dns.resolver

TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT", "SOA", "CAA"]


def lookup(domain, types=TYPES, resolver=None):
    resolver = resolver or dns.resolver.Resolver()
    resolver.lifetime = 10
    records = {}
    for rtype in types:
        try:
            answer = resolver.resolve(domain, rtype)
        except (dns.resolver.NXDOMAIN, dns.resolver.NoNameservers):
            if rtype == types[0]:
                raise
            continue
        except (dns.resolver.NoAnswer, dns.exception.Timeout):
            continue
        records[rtype] = [{"value": r.to_text(), "ttl": answer.rrset.ttl} for r in answer]
    return records


def entities(domain, records):
    out, seen = [], set()

    def add(kind, value, **attrs):
        if (kind, value) not in seen:
            seen.add((kind, value))
            out.append({"type": kind, "value": value, "source": "dns", "confidence": "high", "attrs": attrs})

    for rtype, rows in records.items():
        for row in rows:
            value = row["value"]
            add("dns_record", f"{rtype} {value}", domain=domain, record_type=rtype, ttl=row["ttl"])
            if rtype in ("A", "AAAA"):
                add("ip", value, domain=domain, family="ipv4" if rtype == "A" else "ipv6")
            elif rtype in ("CNAME", "NS"):
                add("domain", value.rstrip("."), relation=rtype.lower(), domain=domain)
            elif rtype == "MX":
                add("domain", value.split()[-1].rstrip("."), relation="mx", domain=domain)
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="dns-records")
    parser.add_argument("--types", default=",".join(TYPES), help="comma-separated record types")
    parser.add_argument("domain")
    args = parser.parse_args(argv)
    domain = args.domain.strip().rstrip(".").lower()
    types = [t.strip().upper() for t in args.types.split(",") if t.strip()]
    try:
        records = lookup(domain, types)
    except dns.resolver.NXDOMAIN:
        print(f"{domain} does not exist", file=sys.stderr)
        return 1
    except dns.resolver.NoNameservers as exc:
        print(f"no name server answered for {domain}: {exc}", file=sys.stderr)
        return 1
    json.dump({"entities": entities(domain, records), "records": records}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
