#!/usr/bin/env python3
"""Looks up an IP address, domain, URL or file hash in AlienVault OTX: how many community threat reports ("pulses")
mention it, with each report's name, tags, malware families, adversary and references, plus OTX's network and
location data for an IP address.

Uses AlienVault's official client (OTXv2). Only OTX's own data is read, so the target is not contacted. Works without
a key; OTX_API_KEY, free from an OTX account, raises the rate limits. Prints {"entities": [...]}.
"""
import argparse
import json
import os
import sys

import IndicatorTypes
import requests
from OTXv2 import OTXv2, BadRequest, InvalidAPIKey, NotFound, RetryError

KEY = "OTX_API_KEY"
SOURCE = "alienvault-otx"
SITE = "https://otx.alienvault.com"
MAX_PULSES = 20
HASHES = {32: IndicatorTypes.FILE_HASH_MD5, 40: IndicatorTypes.FILE_HASH_SHA1, 64: IndicatorTypes.FILE_HASH_SHA256}
ENTITY = {"ip": "ip", "domain": "domain", "url": "url", "hash": "document"}


def indicator_types(kind, value):
    """The OTX indicator types to ask about. OTX files subdomains under "hostname", so a name with more than two
    labels is looked up both ways."""
    if kind == "ip":
        return [IndicatorTypes.IPv6 if ":" in value else IndicatorTypes.IPv4]
    if kind == "domain":
        return [IndicatorTypes.DOMAIN] + ([IndicatorTypes.HOSTNAME] if value.count(".") >= 2 else [])
    if kind == "url":
        return [IndicatorTypes.URL]
    if len(value) not in HASHES:
        raise ValueError("the hash must be an MD5, SHA-1 or SHA-256 in hex")
    return [HASHES[len(value)]]


def pulse_entity(p):
    return {"type": "other", "value": p.get("name") or p.get("id"), "source": SOURCE, "confidence": "medium", "attrs": {
        "kind": "OTX pulse", "id": p.get("id"), "created": p.get("created"), "modified": p.get("modified"),
        "tags": (p.get("tags") or [])[:20], "malware_families": [m.get("display_name") or m.get("id")
                                                                 for m in p.get("malware_families") or []
                                                                 if isinstance(m, dict)][:10],
        "adversary": p.get("adversary") or None, "targeted_countries": p.get("targeted_countries") or [],
        "references": (p.get("references") or [])[:5], "author": (p.get("author") or {}).get("username"),
        "link": f"{SITE}/pulse/{p.get('id')}"}}


def entities(kind, value, details):
    """Maps OTX "general" sections (one per indicator type asked) to entities."""
    first = details[0]
    pulses = {}
    for d in details:
        for p in (d.get("pulse_info") or {}).get("pulses") or []:
            pulses.setdefault(p.get("id"), p)
    related = {}
    for d in details:
        for group in ((d.get("pulse_info") or {}).get("related") or {}).values():
            for field in ("malware_families", "adversary", "industries"):
                related.setdefault(field, [])
                related[field] += [x for x in group.get(field) or [] if x and x not in related[field]]
    count = max((d.get("pulse_info") or {}).get("count", 0) for d in details)
    validation = [v.get("name") for d in details for v in d.get("validation") or [] if v.get("name")]
    otx_type = str(first.get("type") or kind)
    page = "ip" if otx_type.startswith("IP") else "file" if otx_type.startswith("FileHash") else otx_type.lower()
    attrs = {"pulses": count, "malware_families": related.get("malware_families", [])[:20],
             "adversaries": related.get("adversary", [])[:10], "industries": related.get("industries", [])[:10],
             "validation": validation, "link": f"{SITE}/indicator/{page}/{value}"}
    if kind == "ip":
        attrs.update(reputation=first.get("reputation"), asn=first.get("asn"), country=first.get("country_name"))
    confidence = "high" if count >= 3 and not validation else "medium" if count else "low"
    out = [{"type": ENTITY[kind], "value": value, "source": SOURCE, "confidence": confidence, "attrs": attrs}]
    out += [pulse_entity(p) for p in list(pulses.values())[:MAX_PULSES]]
    if kind == "ip" and first.get("asn"):
        out.append({"type": "organization", "value": first["asn"], "source": SOURCE, "confidence": "medium",
                    "attrs": {"role": "network owner"}})
    if kind == "ip" and first.get("country_name"):
        place = ", ".join(p for p in (first.get("city"), first.get("region"), first.get("country_name")) if p)
        out.append({"type": "location", "value": place, "source": SOURCE, "confidence": "low",
                    "attrs": {"latitude": first.get("latitude"), "longitude": first.get("longitude"),
                              "basis": "IP geolocation"}})
    return out


def lookup(otx, kind, value):
    """The "general" section for each indicator type; empty when OTX doesn't know the indicator."""
    details = []
    for t in indicator_types(kind, value):
        try:
            details.append(otx.get_indicator_details_by_section(t, value, "general"))
        except NotFound:
            continue
    return details


def main(argv=None):
    parser = argparse.ArgumentParser(prog="otx-indicators", description="Look one indicator up in AlienVault OTX.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--ip")
    target.add_argument("--domain")
    target.add_argument("--url")
    target.add_argument("--hash", help="MD5, SHA-1 or SHA-256 of a file")
    args = parser.parse_args(argv)
    kind = next(k for k in ENTITY if getattr(args, k))
    value = getattr(args, kind).strip()
    if kind in ("domain", "hash"):
        value = value.lower().rstrip(".")
    otx = OTXv2(os.environ.get(KEY, "").strip() or None, project="osintverse-otx-indicators")
    try:
        details = lookup(otx, kind, value)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    except InvalidAPIKey:
        print(f"OTX refused the key in {KEY}", file=sys.stderr)
        return 1
    except (BadRequest, RetryError, requests.RequestException) as exc:
        print(f"OTX: {exc}", file=sys.stderr)
        return 1
    if not details:
        print(f"OTX has no record of {value}", file=sys.stderr)
    json.dump({"entities": entities(kind, value, details) if details else []}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
