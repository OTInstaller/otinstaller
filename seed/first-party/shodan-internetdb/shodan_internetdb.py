#!/usr/bin/env python3
"""Looks up an IP address in Shodan's InternetDB: the open ports, host names, software (as CPEs), tags and known
vulnerabilities (CVEs) that Shodan's scans last saw on it.

InternetDB is free for non-commercial use and needs no key. Only Shodan's database is read, so the target is not
contacted. Prints {"entities": [...]}.
"""
import argparse
import ipaddress
import json
import sys
import urllib.error
import urllib.request

SOURCE = "shodan-internetdb"
API = "https://internetdb.shodan.io/"
USER_AGENT = "osintverse-shodan-internetdb/0.1 (+https://otinstaller.com)"


def fetch(ip):
    """InternetDB's record for an address, or None when Shodan has no information on it."""
    req = urllib.request.Request(API + ip, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def entities(record):
    """Maps an InternetDB record to entities: the address with its ports, software, tags and CVEs, and each host
    name seen on it."""
    ip = record.get("ip")
    if not ip:
        return []
    names = []
    for name in record.get("hostnames") or []:
        name = name.rstrip(".").lower()
        if name and name not in names:
            names.append(name)
    attrs = {"ports": sorted(record.get("ports") or []), "cpes": record.get("cpes") or [],
             "tags": record.get("tags") or [], "vulns": record.get("vulns") or [], "hostnames": names,
             "link": f"https://www.shodan.io/host/{ip}"}
    out = [{"type": "ip", "value": ip, "source": SOURCE, "confidence": "high", "attrs": attrs}]
    out += [{"type": "domain", "value": name, "source": SOURCE, "confidence": "medium",
             "attrs": {"relation": "host name seen on the address", "ip": ip}} for name in names]
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="shodan-internetdb", description="Look an IP address up in InternetDB.")
    parser.add_argument("ip")
    args = parser.parse_args(argv)
    try:
        ip = ipaddress.ip_address(args.ip.strip())
    except ValueError:
        print(f"{args.ip.strip()!r} is not an IP address", file=sys.stderr)
        return 2
    record = None
    if not ip.is_global:
        print(f"{ip} is a private or reserved address, which Shodan doesn't scan", file=sys.stderr)
    else:
        try:
            record = fetch(str(ip))
        except urllib.error.HTTPError as exc:
            print(f"InternetDB: HTTP {exc.code} {exc.reason}", file=sys.stderr)
            return 1
        except (OSError, ValueError) as exc:
            print(f"InternetDB: {exc}", file=sys.stderr)
            return 1
        if record is None:
            print(f"InternetDB has no information on {ip}", file=sys.stderr)
    json.dump({"entities": entities(record) if record else []}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
