#!/usr/bin/env python3
"""Lists the data breaches an email address appears in, from Have I Been Pwned: each breach's name, site, date,
number of accounts and the kinds of data it exposed.

Uses the pyhibp client for HIBP's API. Only breach metadata comes back, never breached data such as passwords, and
the address's owner is not contacted. Needs HIBP_API_KEY, which HIBP sells as a monthly subscription.
Prints {"entities": [...]}.
"""
import argparse
import json
import os
import re
import sys

import pyhibp
import requests

KEY = "HIBP_API_KEY"
SOURCE = "haveibeenpwned"
USER_AGENT = "osintverse-hibp-breaches/0.1 (+https://otinstaller.com)"
TAGS = re.compile(r"<[^>]+>")


def entities(email, breaches):
    """Maps HIBP breach models to breach entities."""
    out = []
    for b in breaches:
        out.append({"type": "breach", "value": b.get("Title") or b.get("Name"), "source": SOURCE,
                    "confidence": "high" if b.get("IsVerified") else "medium", "attrs": {
                        "name": b.get("Name"), "domain": b.get("Domain") or None, "breach_date": b.get("BreachDate"),
                        "added": b.get("AddedDate"), "accounts": b.get("PwnCount"),
                        "data_classes": b.get("DataClasses") or [], "verified": b.get("IsVerified"),
                        "fabricated": b.get("IsFabricated"), "spam_list": b.get("IsSpamList"),
                        "malware": b.get("IsMalware"), "description": TAGS.sub("", b.get("Description") or "")[:500] or None,
                        "email": email, "link": f"https://haveibeenpwned.com/PwnedWebsites#{b.get('Name')}"}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="hibp-breaches", description="List the breaches an address appears in.")
    parser.add_argument("email")
    args = parser.parse_args(argv)
    key = os.environ.get(KEY, "").strip()
    if not key:
        print(f"{KEY} is not set: add it with `ot keys set {KEY}`", file=sys.stderr)
        return 3
    email = args.email.strip().lower()
    pyhibp.set_user_agent(ua=USER_AGENT)
    pyhibp.set_api_key(key=key)
    try:
        breaches = pyhibp.get_account_breaches(account=email, truncate_response=False, include_unverified=True)
    except (RuntimeError, NotImplementedError, requests.RequestException) as exc:
        print(f"Have I Been Pwned: {exc}", file=sys.stderr)
        return 1
    if not breaches:
        print(f"Have I Been Pwned lists no breach for {email}", file=sys.stderr)
    json.dump({"entities": entities(email, breaches or [])}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
