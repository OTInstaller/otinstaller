#!/usr/bin/env python3
"""Looks up an IP address, domain or URL in Pulsedive, a community threat intelligence platform: its risk level and
the risk factors behind it, the threats (malware families, campaigns) and feeds that list it, and what Pulsedive's
past scans saw (open ports, protocols, technologies, DNS, network owner, location).

Only Pulsedive's existing record is read: nothing is submitted for scanning, so the target is not contacted. Works
without a key at a low daily limit; PULSEDIVE_API_KEY, free from a Pulsedive account, raises it.
Prints {"entities": [...]}.
"""
import argparse
import ipaddress
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

KEY = "PULSEDIVE_API_KEY"
SOURCE = "pulsedive"
API = "https://pulsedive.com/api/indicator.php"
SITE = "https://pulsedive.com"
USER_AGENT = "osintverse-pulsedive/0.1 (+https://otinstaller.com)"
CONFIDENCE = {"critical": "high", "high": "high", "medium": "medium", "low": "medium"}


class APIError(Exception):
    """An error Pulsedive answered with, carrying its own message."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def lookup(value, key=None):
    """Pulsedive's record of an indicator, or None when it has none."""
    params = {"indicator": value}
    if key:
        params["key"] = key  # Pulsedive takes the key only as a query parameter
    req = urllib.request.Request(API + "?" + urllib.parse.urlencode(params),
                                 headers={"Accept": "application/json", "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            message = json.loads(exc.read().decode() or "{}").get("error")
        except (OSError, ValueError, AttributeError):
            message = None
        if exc.code == 404:
            return None
        raise APIError(exc.code, message or f"HTTP {exc.code} {exc.reason}") from exc


def prop(group, name):
    """A property's value, under its own name or with the "++" prefix Pulsedive puts on some."""
    group = group if isinstance(group, dict) else {}
    value = group.get(name)
    return value if value is not None else group.get("++" + name)


def as_list(value):
    if value is None:
        return []
    return [str(v) for v in value] if isinstance(value, list) else [str(value)]


def dns_records(dns):
    """The DNS property group as {record type: [values]}, merging "A" and "++A"."""
    records = {}
    for name, value in (dns if isinstance(dns, dict) else {}).items():
        name = name.lstrip("+")
        values = records.setdefault(name if name == "ptr" else name.upper(), [])
        values += [v for v in as_list(value) if v not in values]
    return records


def entities(kind, d):
    """Maps a Pulsedive indicator record to entities: the indicator itself, the threats linked to it, where it
    redirects, the addresses its DNS gave, its network owner and location."""
    value = d.get("indicator")
    if not value:
        return []
    props = d.get("properties") or {}
    geo, attributes = props.get("geo") or {}, d.get("attributes") or {}
    dns = dns_records(props.get("dns"))
    risk = d.get("risk") or "unknown"
    factors = d.get("riskfactors") or []
    attrs = {
        "risk": risk, "risk_recommended": d.get("risk_recommended"), "manual_risk": bool(d.get("manualrisk")),
        "risk_factors": [{"description": f.get("description"), "risk": f.get("risk")} for f in factors],
        "threats": [t.get("name") for t in d.get("threats") or [] if t.get("name")],
        "feeds": [{"name": f.get("name"), "organization": f.get("organization"), "category": f.get("category")}
                  for f in d.get("feeds") or []],
        "retired": d.get("retired"), "added": d.get("stamp_added"), "last_seen": d.get("stamp_seen"),
        "last_scanned": d.get("stamp_probed"), "ports": as_list(attributes.get("port")),
        "protocols": as_list(attributes.get("protocol")), "technologies": as_list(attributes.get("technology")),
        "host_types": as_list(attributes.get("hosttype")), "title": prop(props.get("meta"), "title"), "dns": dns,
        "link": f"{SITE}/indicator/?iid={d.get('iid')}",
    }
    if kind == "ip":
        attrs.update(asn=prop(geo, "asn"), country=prop(geo, "country"))
    out = [{"type": kind, "value": value, "source": SOURCE, "confidence": CONFIDENCE.get(risk, "low"), "attrs": attrs}]
    for t in d.get("threats") or []:
        if t.get("name"):
            out.append({"type": "other", "value": t["name"], "source": SOURCE, "confidence": "medium", "attrs": {
                "kind": "Pulsedive threat", "category": t.get("category"), "risk": t.get("risk"),
                "linked": t.get("stamp_linked"), "link": f"{SITE}/threat/?tid={t.get('tid')}"}})
    redirects = d.get("redirects") or {}
    for direction, relation in (("to", "redirects to"), ("from", "redirects here")):
        for r in redirects.get(direction) or []:
            target = r.get("indicator")
            if target:
                out.append({"type": "url" if "://" in target else "domain", "value": target, "source": SOURCE,
                            "confidence": "medium", "attrs": {"relation": relation, "indicator": value}})
    if kind == "ip":
        for name in dict.fromkeys(n.rstrip(".").lower() for n in dns.get("ptr", [])):
            out.append({"type": "domain", "value": name, "source": SOURCE, "confidence": "medium",
                        "attrs": {"relation": "reverse DNS of the address", "ip": value}})
    else:
        for ip in dict.fromkeys(dns.get("A", []) + dns.get("AAAA", [])):
            out.append({"type": "ip", "value": ip, "source": SOURCE, "confidence": "medium",
                        "attrs": {"relation": "DNS address", "indicator": value}})
    org = as_list(prop(geo, "org"))
    if org:
        out.append({"type": "organization", "value": org[0], "source": SOURCE, "confidence": "medium",
                    "attrs": {"role": "network owner", "asn": prop(geo, "asn")}})
    place = ", ".join(str(p) for p in (prop(geo, "city"), prop(geo, "region"), prop(geo, "country")) if p)
    if place:
        out.append({"type": "location", "value": place, "source": SOURCE, "confidence": "low",
                    "attrs": {"latitude": prop(geo, "lat"), "longitude": prop(geo, "long"),
                              "basis": "IP geolocation"}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="pulsedive", description="Look one indicator up in Pulsedive.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--ip")
    target.add_argument("--domain")
    target.add_argument("--url")
    args = parser.parse_args(argv)
    kind = next(k for k in ("ip", "domain", "url") if getattr(args, k))
    value = getattr(args, kind).strip()
    if kind == "domain":
        value = value.lower().rstrip(".")
    if kind == "ip":
        try:
            value = str(ipaddress.ip_address(value))
        except ValueError:
            print(f"{value!r} is not an IP address", file=sys.stderr)
            return 2
    key = os.environ.get(KEY, "").strip() or None
    try:
        record = lookup(value, key)
    except APIError as exc:
        if exc.status == 429:
            hint = "" if key else f"; a free account's key in {KEY} raises the limit"
            print(f"Pulsedive: {exc}{hint}", file=sys.stderr)
        elif exc.status in (401, 403):
            print(f"Pulsedive refused the key in {KEY}: {exc}", file=sys.stderr)
        else:
            print(f"Pulsedive: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"Pulsedive: {exc}", file=sys.stderr)
        return 1
    if record is None:
        print(f"Pulsedive has no record of {value}", file=sys.stderr)
    json.dump({"entities": entities(kind, record) if record else []}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
