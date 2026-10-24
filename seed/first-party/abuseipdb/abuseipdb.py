#!/usr/bin/env python3
"""Checks an IP address in AbuseIPDB: its abuse confidence score (0 to 100), how many reports and reporters it had
in a period and what it was reported for, and AbuseIPDB's data on its network (ISP, usage type, domain, country,
whether it is a Tor exit node).

Only AbuseIPDB's reports are read, so the target is not contacted. Needs ABUSEIPDB_API_KEY; a free account's key
allows 1,000 checks a day. Prints {"entities": [...]}.
"""
import argparse
import collections
import ipaddress
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

KEY = "ABUSEIPDB_API_KEY"
SOURCE = "abuseipdb"
API = "https://api.abuseipdb.com/api/v2/check"
USER_AGENT = "osintverse-abuseipdb/0.1 (+https://otinstaller.com)"
MAX_REPORTS = 10
CATEGORIES = {
    1: "DNS Compromise", 2: "DNS Poisoning", 3: "Fraud Orders", 4: "DDoS Attack", 5: "FTP Brute-Force",
    6: "Ping of Death", 7: "Phishing", 8: "Fraud VoIP", 9: "Open Proxy", 10: "Web Spam", 11: "Email Spam",
    12: "Blog Spam", 13: "VPN IP", 14: "Port Scan", 15: "Hacking", 16: "SQL Injection", 17: "Spoofing",
    18: "Brute-Force", 19: "Bad Web Bot", 20: "Exploited Host", 21: "Web App Attack", 22: "SSH", 23: "IoT Targeted",
}


class APIError(Exception):
    """An error AbuseIPDB answered with, carrying its own message."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def check(ip, days, key):
    """The check endpoint's data for an address, with its reports from the last `days` days."""
    url = API + "?" + urllib.parse.urlencode({"ipAddress": ip, "maxAgeInDays": days, "verbose": "true"})
    req = urllib.request.Request(url, headers={"Key": key, "Accept": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode() or "{}").get("data") or {}
    except urllib.error.HTTPError as exc:
        try:
            errors = json.loads(exc.read().decode() or "{}").get("errors") or []
        except (OSError, ValueError, AttributeError):
            errors = []
        message = "; ".join(str(e.get("detail")) for e in errors if isinstance(e, dict) and e.get("detail"))
        raise APIError(exc.code, message or f"HTTP {exc.code} {exc.reason}") from exc


def category_names(ids):
    return [CATEGORIES.get(c, str(c)) for c in ids or []]


def entities(d):
    """Maps a check result to entities: the address with its score and reports, its network operator, the
    operator's domain, the address's host names and its country."""
    ip = d.get("ipAddress")
    if not ip:
        return []
    reports = sorted(d.get("reports") or [], key=lambda r: r.get("reportedAt") or "", reverse=True)
    counts = collections.Counter(c for r in reports for c in r.get("categories") or [])
    score = d.get("abuseConfidenceScore") or 0
    attrs = {
        "abuse_confidence_score": score, "total_reports": d.get("totalReports"),
        "distinct_reporters": d.get("numDistinctUsers"), "last_reported": d.get("lastReportedAt"),
        "categories": {CATEGORIES.get(c, str(c)): n for c, n in counts.most_common()},
        "recent_reports": [{"reported_at": r.get("reportedAt"), "categories": category_names(r.get("categories")),
                            "comment": (r.get("comment") or "")[:300] or None,
                            "reporter_country": r.get("reporterCountryCode")} for r in reports[:MAX_REPORTS]],
        "whitelisted": d.get("isWhitelisted"), "tor": d.get("isTor"), "usage_type": d.get("usageType"),
        "isp": d.get("isp"), "domain": d.get("domain"), "hostnames": d.get("hostnames") or [],
        "country": d.get("countryName") or d.get("countryCode"), "link": f"https://www.abuseipdb.com/check/{ip}",
    }
    confidence = "high" if score >= 75 else "medium" if score >= 25 else "low"
    out = [{"type": "ip", "value": ip, "source": SOURCE, "confidence": confidence, "attrs": attrs}]
    if d.get("isp"):
        out.append({"type": "organization", "value": d["isp"], "source": SOURCE, "confidence": "medium",
                    "attrs": {"role": "network operator", "usage_type": d.get("usageType"), "domain": d.get("domain")}})
    if d.get("domain"):
        out.append({"type": "domain", "value": d["domain"].lower(), "source": SOURCE, "confidence": "medium",
                    "attrs": {"relation": "domain of the network operator", "ip": ip}})
    for name in d.get("hostnames") or []:
        out.append({"type": "domain", "value": name.rstrip(".").lower(), "source": SOURCE, "confidence": "high",
                    "attrs": {"relation": "reverse DNS of the address", "ip": ip}})
    if d.get("countryCode"):
        out.append({"type": "location", "value": d.get("countryName") or d["countryCode"], "source": SOURCE,
                    "confidence": "low", "attrs": {"country_code": d["countryCode"], "basis": "IP geolocation"}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="abuseipdb", description="Check an IP address's abuse reports in AbuseIPDB.")
    parser.add_argument("ip")
    parser.add_argument("--days", type=int, default=90, help="count reports from this many days back (1-365)")
    args = parser.parse_args(argv)
    try:
        ip = ipaddress.ip_address(args.ip.strip())
    except ValueError:
        print(f"{args.ip.strip()!r} is not an IP address", file=sys.stderr)
        return 2
    key = os.environ.get(KEY, "").strip()
    if not key:
        print(f"{KEY} is not set: add it with `ot keys set {KEY}`", file=sys.stderr)
        return 3
    if not ip.is_global:
        print(f"{ip} is a private or reserved address, which nobody can report", file=sys.stderr)
        json.dump({"entities": []}, sys.stdout)
        print()
        return 0
    days = max(1, min(args.days, 365))
    try:
        data = check(str(ip), days, key)
    except APIError as exc:
        if exc.status in (401, 403):
            print(f"AbuseIPDB refused the key in {KEY}: {exc}", file=sys.stderr)
        else:
            print(f"AbuseIPDB: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"AbuseIPDB: {exc}", file=sys.stderr)
        return 1
    if not data.get("totalReports"):
        print(f"AbuseIPDB has no reports of {ip} in the last {days} days", file=sys.stderr)
    json.dump({"entities": entities(data)}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
