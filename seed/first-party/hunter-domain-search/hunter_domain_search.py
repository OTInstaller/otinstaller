#!/usr/bin/env python3
"""Lists the email addresses Hunter has found for a domain: each address with its owner's name, position and
department, how confident Hunter is and where it was seen, plus the domain's usual address pattern and organisation.

Uses Hunter's Python client (pyhunter). Only Hunter's database is read, so nobody at the domain is contacted. Needs
HUNTER_API_KEY; a free Hunter account includes a monthly allowance of searches. Prints {"entities": [...]}.
"""
import argparse
import json
import os
import sys

from pyhunter import PyHunter
from pyhunter.exceptions import PyhunterError

KEY = "HUNTER_API_KEY"
SOURCE = "hunter.io"


def entities(data):
    """Maps a domain search result (Hunter's "data" object) to entities."""
    org, out = data.get("organization"), []
    for e in data.get("emails") or []:
        if not e.get("value"):
            continue
        email = e["value"].lower()
        name = " ".join(p for p in (e.get("first_name"), e.get("last_name")) if p) or None
        sources = [s.get("uri") for s in e.get("sources") or [] if s.get("uri")]
        score = e.get("confidence") or 0
        out.append({"type": "email", "value": email, "source": SOURCE,
                    "confidence": "high" if score >= 90 else "medium" if score >= 50 else "low", "attrs": {
                        "name": name, "position": e.get("position"), "department": e.get("department"),
                        "seniority": e.get("seniority"), "kind": e.get("type"), "hunter_confidence": score,
                        "verification": (e.get("verification") or {}).get("status"), "linkedin": e.get("linkedin"),
                        "twitter": e.get("twitter"), "phone": e.get("phone_number"), "sources": sources[:5],
                        "source_count": len(sources)}})
        if name:
            out.append({"type": "person", "value": name, "source": SOURCE, "confidence": "medium",
                        "attrs": {"email": email, "position": e.get("position"), "organization": org}})
    if org:
        out.append({"type": "organization", "value": org, "source": SOURCE, "confidence": "medium", "attrs": {
            "domain": data.get("domain"), "email_pattern": data.get("pattern"), "accept_all": data.get("accept_all"),
            "webmail": data.get("webmail"), "disposable": data.get("disposable")}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hunter-domain-search", description="List the addresses Hunter knows for a domain.")
    parser.add_argument("domain")
    parser.add_argument("--limit", type=int, default=10, help="most addresses to return (free plans get 10)")
    args = parser.parse_args(argv)
    key = os.environ.get(KEY, "").strip()
    if not key:
        print(f"{KEY} is not set: add it with `ot keys set {KEY}`", file=sys.stderr)
        return 3
    domain = args.domain.strip().lower().rstrip(".")
    try:
        data = PyHunter(key).domain_search(domain=domain, limit=max(1, min(args.limit, 100)))
    except PyhunterError as exc:
        status = getattr(exc, "status_code", None)
        print(f"Hunter: {'HTTP ' + str(status) + ': ' if status else ''}{exc}", file=sys.stderr)
        return 1
    json.dump({"entities": entities(data or {})}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
