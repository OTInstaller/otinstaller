#!/usr/bin/env python3
"""Looks up an IP address, domain, URL or file hash in VirusTotal: how many engines flag it, its reputation and
tags, and what VirusTotal knows around it (network owner, DNS records, file names).

Uses VirusTotal's official client (vt-py). Only existing reports are read: nothing is submitted for analysis, so
the target is never contacted. Needs VIRUSTOTAL_API_KEY; a free public API key works. Prints {"entities": [...]}.
"""
import argparse
import collections.abc
import datetime
import json
import os
import sys

import vt

KEY = "VIRUSTOTAL_API_KEY"
SOURCE = "virustotal"
GUI = "https://www.virustotal.com/gui"
PATHS = {"ip": "/ip_addresses/{}", "domain": "/domains/{}", "url": "/urls/{}", "hash": "/files/{}"}


def plain(value, name=""):
    """vt-py keeps attributes as raw API values in its own dict type; make them JSON, with dates as ISO strings."""
    if isinstance(value, collections.abc.Mapping):
        return {k: plain(v, k) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if (name.endswith("_date") or name == "date") and isinstance(value, (int, float)):
        return datetime.datetime.fromtimestamp(value, datetime.timezone.utc).isoformat()
    return value


def verdict(a):
    """The attributes every report has: engine counts, reputation, tags and when it was last analysed."""
    stats = a.get("last_analysis_stats") or {}
    out = {k: stats.get(k, 0) for k in ("malicious", "suspicious", "harmless", "undetected")}
    out.update({"reputation": a.get("reputation"), "tags": a.get("tags") or [],
                "last_analysis_date": a.get("last_analysis_date")})
    return out


def confidence(a):
    stats = a.get("last_analysis_stats") or {}
    return "high" if stats.get("malicious", 0) >= 3 else "medium" if stats.get("malicious") else "low"


def entities(kind, value, a):
    """Maps a report's attributes (already plain) to entities."""
    if kind == "ip":
        attrs = dict(verdict(a), asn=a.get("asn"), as_owner=a.get("as_owner"), network=a.get("network"),
                     country=a.get("country"), link=f"{GUI}/ip-address/{value}")
        out = [{"type": "ip", "value": value, "source": SOURCE, "confidence": confidence(a), "attrs": attrs}]
        if a.get("as_owner"):
            out.append({"type": "organization", "value": a["as_owner"], "source": SOURCE, "confidence": "medium",
                        "attrs": {"role": "network owner", "asn": a.get("asn"), "network": a.get("network")}})
        if a.get("country"):
            out.append({"type": "location", "value": a["country"], "source": SOURCE, "confidence": "low",
                        "attrs": {"basis": "IP registration", "continent": a.get("continent")}})
        return out
    if kind == "domain":
        attrs = dict(verdict(a), registrar=a.get("registrar"), creation_date=a.get("creation_date"),
                     categories=a.get("categories") or {}, link=f"{GUI}/domain/{value}")
        out = [{"type": "domain", "value": value, "source": SOURCE, "confidence": confidence(a), "attrs": attrs}]
        for record in a.get("last_dns_records") or []:
            if record.get("value"):
                out.append({"type": "dns_record", "value": str(record["value"]), "source": SOURCE,
                            "confidence": "medium",
                            "attrs": {"name": value, "record_type": record.get("type"), "ttl": record.get("ttl"),
                                      "seen": a.get("last_dns_records_date")}})
        return out
    if kind == "url":
        attrs = dict(verdict(a), title=a.get("title"), final_url=a.get("last_final_url"),
                     status=a.get("last_http_response_code"), categories=a.get("categories") or {},
                     first_submission_date=a.get("first_submission_date"), link=f"{GUI}/url/{vt.url_id(value)}")
        return [{"type": "url", "value": value, "source": SOURCE, "confidence": confidence(a), "attrs": attrs}]
    threat = (a.get("popular_threat_classification") or {}).get("suggested_threat_label")
    sha256 = a.get("sha256") or value
    attrs = dict(verdict(a), md5=a.get("md5"), sha1=a.get("sha1"), sha256=sha256,
                 name=a.get("meaningful_name"), names=(a.get("names") or [])[:10],
                 file_type=a.get("type_description"), size=a.get("size"), threat_label=threat,
                 first_submission_date=a.get("first_submission_date"), link=f"{GUI}/file/{sha256}")
    return [{"type": "document", "value": sha256, "source": SOURCE, "confidence": confidence(a), "attrs": attrs}]


def lookup(client, kind, value):
    """Fetches one report; None when VirusTotal has never seen the target."""
    object_id = vt.url_id(value) if kind == "url" else value
    try:
        obj = client.get_object(PATHS[kind].format(object_id))
    except vt.APIError as exc:
        if exc.code == "NotFoundError":
            return None
        raise
    return plain(obj.to_dict().get("attributes") or {})


def main(argv=None):
    parser = argparse.ArgumentParser(prog="virustotal", description="Look up one target in VirusTotal.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--ip")
    target.add_argument("--domain")
    target.add_argument("--url")
    target.add_argument("--hash", help="MD5, SHA-1 or SHA-256 of a file")
    args = parser.parse_args(argv)
    kind = next(k for k in PATHS if getattr(args, k))
    value = getattr(args, kind).strip()
    if kind in ("domain", "hash"):
        value = value.lower().rstrip(".")
    key = os.environ.get(KEY, "").strip()
    if not key:
        print(f"{KEY} is not set: add it with `ot keys set {KEY}`", file=sys.stderr)
        return 3
    try:
        with vt.Client(key) as client:
            report = lookup(client, kind, value)
    except vt.APIError as exc:
        print(f"VirusTotal: {exc.code}: {exc.message}", file=sys.stderr)
        return 1
    if report is None:
        print(f"VirusTotal has no report for {value}", file=sys.stderr)
        found = []
    else:
        found = entities(kind, value, report)
    json.dump({"entities": found}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
