#!/usr/bin/env python3
"""Looks up an IP address in IPinfo: its host name, location, time zone, network owner and ASN, and whether it is
anycast.

Uses IPinfo's official client (ipinfo). Only IPinfo's data is read, so the target is not contacted. Works without a
token at a lower request limit; IPINFO_TOKEN, free from an IPinfo account, raises it. Prints {"entities": [...]}.
"""
import argparse
import json
import os
import sys

import ipinfo
import requests
from ipinfo.exceptions import RequestQuotaExceededError, TimeoutExceededError

KEY = "IPINFO_TOKEN"
SOURCE = "ipinfo"


def entities(d):
    """Maps an IPinfo details record (a plain dict) to entities."""
    ip = d.get("ip")
    if not ip or d.get("bogon"):
        return []
    org = d.get("org") or ""
    asn, _, owner = org.partition(" ") if org.startswith("AS") else ("", "", org)
    place = ", ".join(p for p in (d.get("city"), d.get("region"), d.get("country_name") or d.get("country")) if p)
    out = [{"type": "ip", "value": ip, "source": SOURCE, "confidence": "high", "attrs": {
        "hostname": d.get("hostname"), "asn": asn or None, "network_owner": owner or None, "location": place or None,
        "timezone": d.get("timezone"), "anycast": d.get("anycast", False), "link": f"https://ipinfo.io/{ip}"}}]
    if d.get("hostname"):
        out.append({"type": "domain", "value": d["hostname"].rstrip(".").lower(), "source": SOURCE,
                    "confidence": "medium", "attrs": {"relation": "reverse DNS of the address"}})
    if owner:
        out.append({"type": "organization", "value": owner, "source": SOURCE, "confidence": "medium",
                    "attrs": {"role": "network owner", "asn": asn or None}})
    if place:
        out.append({"type": "location", "value": place, "source": SOURCE, "confidence": "low",
                    "attrs": {"latitude": d.get("latitude"), "longitude": d.get("longitude"),
                              "postal": d.get("postal"), "basis": "IP geolocation"}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="ipinfo", description="Look an IP address up in IPinfo.")
    parser.add_argument("ip")
    args = parser.parse_args(argv)
    handler = ipinfo.getHandler(os.environ.get(KEY, "").strip() or None)
    try:
        details = handler.getDetails(args.ip.strip()).all
    except RequestQuotaExceededError:
        print(f"IPinfo: request limit reached; a free token in {KEY} raises it", file=sys.stderr)
        return 1
    except (TimeoutExceededError, requests.RequestException) as exc:
        print(f"IPinfo: {exc}", file=sys.stderr)
        return 1
    if details.get("bogon"):
        print(f"{args.ip} is a reserved or private address", file=sys.stderr)
    json.dump({"entities": entities(details)}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
