#!/usr/bin/env python3
"""Searches urlscan.io for scans other people already made of a domain, IP address or URL, or for any urlscan.io
search query: each scanned page's address, title, server, IP address, network and country, with links to the scan
and its screenshot.

Uses urlscan.io's official client (urlscan-python). It only searches existing scans and never submits one, so the
target is not contacted. Works without a key, at lower rate limits; URLSCAN_API_KEY raises them.
Prints {"entities": [...]}.
"""
import argparse
import json
import os
import sys

import httpx
import urlscan

KEY = "URLSCAN_API_KEY"
SOURCE = "urlscan.io"
KINDS = ("domain", "ip", "url", "query")


def quoted(value):
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def build_query(kind, value):
    """Scans *of* the target: the page itself was on that domain, IP address or URL."""
    if kind == "domain":
        return "page.domain:" + quoted(value.lower().rstrip("."))
    if kind == "ip":
        return "page.ip:" + quoted(value)
    if kind == "url":
        return "page.url:" + quoted(value)
    return value


def entities(results):
    out, ips, hosts = [], {}, {}
    for r in results:
        page, task = r.get("page") or {}, r.get("task") or {}
        url = page.get("url") or task.get("url")
        if not url:
            continue
        out.append({"type": "url", "value": url, "source": SOURCE, "confidence": "medium", "attrs": {
            "scanned": task.get("time"), "submitted_url": task.get("url"), "title": page.get("title"),
            "status": page.get("status"), "server": page.get("server"), "ip": page.get("ip"), "asn": page.get("asn"),
            "asn_name": page.get("asnname"), "country": page.get("country"), "tls_issuer": page.get("tlsIssuer"),
            "domain_age_days": page.get("domainAgeDays"),
            "scan": f"https://urlscan.io/result/{r.get('_id') or task.get('uuid')}/", "screenshot": r.get("screenshot")}})
        if page.get("ip"):
            seen = ips.setdefault(page["ip"], {"asn": page.get("asn"), "asn_name": page.get("asnname"),
                                               "country": page.get("country"), "ptr": page.get("ptr"), "scans": 0})
            seen["scans"] += 1
        if page.get("domain"):
            seen = hosts.setdefault(page["domain"], {"apex_domain": page.get("apexDomain"), "scans": 0})
            seen["scans"] += 1
    out += [{"type": "ip", "value": ip, "source": SOURCE, "confidence": "medium", "attrs": a} for ip, a in ips.items()]
    for host, a in hosts.items():
        kind = "domain" if host == a["apex_domain"] else "subdomain"
        out.append({"type": kind, "value": host, "source": SOURCE, "confidence": "medium", "attrs": a})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="urlscan-search", description="Search urlscan.io's existing scans.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--domain")
    target.add_argument("--ip")
    target.add_argument("--url")
    target.add_argument("--query", help="any urlscan.io search query, such as page.asn:AS15169")
    parser.add_argument("--limit", type=int, default=50, help="most scans to return (1-1000)")
    args = parser.parse_args(argv)
    kind = next(k for k in KINDS if getattr(args, k))
    query = build_query(kind, getattr(args, kind).strip())
    limit = max(1, min(args.limit, 1000))
    try:
        with urlscan.Client(os.environ.get(KEY, "").strip()) as client:
            results = list(client.search(query, size=min(limit, 100), limit=limit))
    except urlscan.APIError as exc:
        print(f"urlscan.io: HTTP {exc.status}: {exc.message}", file=sys.stderr)
        return 1
    except httpx.HTTPError as exc:
        print(f"urlscan.io: {exc}", file=sys.stderr)
        return 1
    json.dump({"entities": entities(results)}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
