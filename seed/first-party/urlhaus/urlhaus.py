#!/usr/bin/env python3
"""Looks up a URL, a host (domain or IP address) or a file hash in abuse.ch URLhaus, the shared database of URLs used
to spread malware: whether a URL is listed and still online, its threat, tags and reporter, the malware URLs on a
host, and the files (payloads) a URL served or the URLs that served a file.

Only URLhaus's database is read, so the target is not contacted. Needs ABUSECH_AUTH_KEY, the free abuse.ch Auth-Key
that MalwareBazaar and ThreatFox use too. Prints {"entities": [...]}.
"""
import argparse
import ipaddress
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

KEY = "ABUSECH_AUTH_KEY"
SOURCE = "urlhaus"
API = "https://urlhaus-api.abuse.ch/v1/"
SITE = "https://urlhaus.abuse.ch"
USER_AGENT = "osintverse-urlhaus/0.1 (+https://otinstaller.com)"
INVALID = {"invalid_url": "not a valid URL", "invalid_host": "not a valid host",
           "invalid_md5": "not a valid MD5 hash", "invalid_sha256": "not a valid SHA-256 hash"}


class InvalidQuery(ValueError):
    """URLhaus can't look up the value as given."""


def request(kind, value):
    """The endpoint and form fields for a target."""
    if kind == "url":
        return "url", {"url": value}
    if kind in ("domain", "ip"):
        return "host", {"host": value}
    if re.fullmatch(r"[0-9a-f]{32}", value):
        return "payload", {"md5_hash": value}
    if re.fullmatch(r"[0-9a-f]{64}", value):
        return "payload", {"sha256_hash": value}
    raise InvalidQuery("URLhaus looks files up by MD5 or SHA-256 only")


def query(endpoint, form, key):
    """One API answer; None when URLhaus has no record."""
    req = urllib.request.Request(API + endpoint + "/", data=urllib.parse.urlencode(form).encode(),
                                 headers={"Auth-Key": key, "Accept": "application/json", "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        doc = json.loads(resp.read().decode() or "{}")
    status = doc.get("query_status")
    if status == "ok":
        return doc
    if status == "no_results":
        return None
    if status in INVALID:
        raise InvalidQuery(INVALID[status])
    raise RuntimeError(f"unexpected answer: {status or doc}")


def url_attrs(u):
    return {"status": u.get("url_status"), "threat": u.get("threat"), "tags": u.get("tags") or [],
            "date_added": u.get("date_added"), "reporter": u.get("reporter"), "link": u.get("urlhaus_reference")}


def url_entities(value, doc):
    """A listed URL, then the files it served."""
    attrs = dict(url_attrs(doc), last_online=doc.get("last_online"), host=doc.get("host"),
                 blacklists=doc.get("blacklists") or {}, takedown_time_seconds=doc.get("takedown_time_seconds"),
                 payloads=len(doc.get("payloads") or []))
    out = [{"type": "url", "value": doc.get("url") or value, "source": SOURCE, "confidence": "high", "attrs": attrs}]
    for p in doc.get("payloads") or []:
        sha256 = p.get("response_sha256")
        if sha256:
            out.append({"type": "document", "value": sha256, "source": SOURCE, "confidence": "high", "attrs": {
                "relation": "served by the URL", "filename": p.get("filename"), "file_type": p.get("file_type"),
                "size": p.get("response_size"), "md5": p.get("response_md5"), "signature": p.get("signature"),
                "first_seen": p.get("firstseen"), "virustotal": (p.get("virustotal") or {}).get("result"),
                "link": f"{SITE}/browse.php?search={sha256}"}})
    return out


def host_entities(kind, value, doc):
    """A listed host, then the malware URLs on it."""
    urls = doc.get("urls") or []
    attrs = {"urls": doc.get("url_count"), "online": sum(u.get("url_status") == "online" for u in urls),
             "first_seen": doc.get("firstseen"), "blacklists": doc.get("blacklists") or {},
             "link": doc.get("urlhaus_reference")}
    out = [{"type": kind, "value": value, "source": SOURCE, "confidence": "high", "attrs": attrs}]
    out += [{"type": "url", "value": u.get("url"), "source": SOURCE, "confidence": "high",
             "attrs": dict(url_attrs(u), relation="malware URL on the host")} for u in urls if u.get("url")]
    return out


def payload_entities(value, doc):
    """A known file, then the URLs that served it."""
    sha256 = doc.get("sha256_hash") or value
    attrs = {"md5": doc.get("md5_hash"), "sha256": sha256, "file_type": doc.get("file_type"),
             "size": doc.get("file_size"), "signature": doc.get("signature"), "first_seen": doc.get("firstseen"),
             "last_seen": doc.get("lastseen"), "urls": doc.get("url_count"),
             "virustotal": (doc.get("virustotal") or {}).get("result"), "imphash": doc.get("imphash"),
             "ssdeep": doc.get("ssdeep"), "tlsh": doc.get("tlsh"), "link": f"{SITE}/browse.php?search={sha256}"}
    out = [{"type": "document", "value": sha256, "source": SOURCE, "confidence": "high", "attrs": attrs}]
    for u in doc.get("urls") or []:
        if u.get("url"):
            out.append({"type": "url", "value": u["url"], "source": SOURCE, "confidence": "high", "attrs": {
                "relation": "served the file", "status": u.get("url_status"), "filename": u.get("filename"),
                "first_seen": u.get("firstseen"), "last_seen": u.get("lastseen"), "link": u.get("urlhaus_reference")}})
    return out


def entities(kind, value, doc):
    if kind == "url":
        return url_entities(value, doc)
    if kind == "hash":
        return payload_entities(value, doc)
    return host_entities(kind, value, doc)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="urlhaus", description="Look one target up in abuse.ch URLhaus.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--url")
    target.add_argument("--domain")
    target.add_argument("--ip")
    target.add_argument("--hash", help="MD5 or SHA-256 of a file")
    args = parser.parse_args(argv)
    kind = next(k for k in ("url", "domain", "ip", "hash") if getattr(args, k))
    value = getattr(args, kind).strip()
    if kind in ("domain", "hash"):
        value = value.lower().rstrip(".")
    try:
        if kind == "ip":
            value = str(ipaddress.ip_address(value))
        endpoint, form = request(kind, value)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    key = os.environ.get(KEY, "").strip()
    if not key:
        print(f"{KEY} is not set: add it with `ot keys set {KEY}`", file=sys.stderr)
        return 3
    try:
        doc = query(endpoint, form, key)
    except InvalidQuery as exc:
        print(f"URLhaus: {value} is {exc}", file=sys.stderr)
        return 2
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            print(f"abuse.ch refused the key in {KEY}", file=sys.stderr)
        else:
            print(f"URLhaus: HTTP {exc.code} {exc.reason}", file=sys.stderr)
        return 1
    except (OSError, ValueError, RuntimeError) as exc:
        print(f"URLhaus: {exc}", file=sys.stderr)
        return 1
    if doc is None:
        print(f"URLhaus has no record of {value}", file=sys.stderr)
    json.dump({"entities": entities(kind, value, doc) if doc else []}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
