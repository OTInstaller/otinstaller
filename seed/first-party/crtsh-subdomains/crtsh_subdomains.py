#!/usr/bin/env python3
"""Finds a domain's subdomains in Certificate Transparency logs through crt.sh, or Cert Spotter when crt.sh
is down.

Prints {"entities": [...]}: one subdomain entity per name, with the first and last certificate dates
and the issuers seen. Passive: only the log search services are contacted, never the target.
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request

USER_AGENT = "osintverse-crtsh-subdomains/0.1 (+https://otinstaller.com)"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode() or "[]")


def certspotter(domain):
    """Cert Spotter rows in crt.sh's shape."""
    url = "https://api.certspotter.com/v1/issuances?" + urllib.parse.urlencode(
        [("domain", domain), ("include_subdomains", "true"), ("expand", "dns_names"), ("expand", "issuer")])
    return [{"name_value": "\n".join(r.get("dns_names", [])), "issuer_name": (r.get("issuer") or {}).get("name"),
             "not_before": r.get("not_before"), "not_after": r.get("not_after")} for r in get_json(url)]


def fetch(domain, attempts=3, sleep=time.sleep):
    url = "https://crt.sh/?" + urllib.parse.urlencode({"q": "%." + domain, "output": "json"})
    errors = []
    for attempt in range(attempts):
        try:
            return get_json(url), "crt.sh"
        except (OSError, ValueError) as exc:  # crt.sh often answers 502 or times out under load
            errors.append(f"crt.sh: {exc}")
            if attempt + 1 < attempts:
                sleep(5 * (attempt + 1))
    try:
        return certspotter(domain), "certspotter"
    except (OSError, ValueError) as exc:
        errors.append(f"Cert Spotter: {exc}")
    raise RuntimeError("no Certificate Transparency search answered (" + "; ".join(errors) + ")")


def subdomains(domain, rows, source="crt.sh"):
    found = {}
    for row in rows:
        for name in str(row.get("name_value", "")).lower().split("\n"):
            name = name.strip().lstrip("*.").rstrip(".")
            if not name or not (name == domain or name.endswith("." + domain)):
                continue
            entry = found.setdefault(name, {"first_seen": None, "last_seen": None, "issuers": set(), "certificates": 0})
            entry["certificates"] += 1
            nb, na = row.get("not_before"), row.get("not_after")
            if nb and (entry["first_seen"] is None or nb < entry["first_seen"]):
                entry["first_seen"] = nb
            if na and (entry["last_seen"] is None or na > entry["last_seen"]):
                entry["last_seen"] = na
            if row.get("issuer_name"):
                entry["issuers"].add(row["issuer_name"])
    return [
        {"type": "subdomain", "value": name, "source": source, "confidence": "medium",
         "attrs": {"first_seen": e["first_seen"], "last_seen": e["last_seen"], "certificates": e["certificates"],
                   "issuers": sorted(e["issuers"])[:5]}}
        for name, e in sorted(found.items())
    ]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="crtsh-subdomains")
    parser.add_argument("domain")
    args = parser.parse_args(argv)
    domain = args.domain.strip().rstrip(".").lower()
    try:
        rows, source = fetch(domain)
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1
    json.dump({"entities": subdomains(domain, rows, source), "source": source}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
