#!/usr/bin/env python3
"""Shows what Censys has seen on an IP address: open ports and the services and software on them, the network that
announces it, its location, the host names that point at it and the labels Censys gives it.

Uses Censys's official Platform client (censys-platform), the API that replaced Censys Search in 2026. Censys scans
the internet on its own schedule; this only reads what it already has, so the target is not contacted. Needs a
Censys personal access token in CENSYS_API_TOKEN; free accounts get monthly credits, and CENSYS_ORG_ID makes
lookups use an organisation's credits instead. Prints {"entities": [...]}.
"""
import argparse
import json
import os
import sys

import httpx
from censys_platform import SDK, models
from censys_platform.models.sdkbaseerror import SDKBaseError

KEY = "CENSYS_API_TOKEN"
ORG = "CENSYS_ORG_ID"
SOURCE = "censys"


def software(service):
    names = []
    for s in service.get("software") or []:
        name = " ".join(p for p in (s.get("vendor"), s.get("product"), s.get("version")) if p)
        if name and name not in names:
            names.append(name)
    return names


def entities(host):
    """Maps a host record (the Platform API's host resource as a plain dict) to entities."""
    ip = host.get("ip")
    asys, loc, dns = host.get("autonomous_system") or {}, host.get("location") or {}, host.get("dns") or {}
    services = host.get("services") or []
    attrs = {"asn": asys.get("asn"), "as_name": asys.get("name"), "bgp_prefix": asys.get("bgp_prefix"),
             "country": loc.get("country"), "city": loc.get("city"),
             "service_count": host.get("service_count", len(services)),
             "ports": sorted({s["port"] for s in services if s.get("port")}),
             "labels": [label.get("value") for label in host.get("labels") or [] if label.get("value")],
             "operating_system": " ".join(p for p in ((host.get("operating_system") or {}).get(k)
                                                      for k in ("vendor", "product", "version")) if p) or None,
             "link": f"https://platform.censys.io/hosts/{ip}"}
    out = [{"type": "ip", "value": ip, "source": SOURCE, "confidence": "high", "attrs": attrs}]
    for s in services:
        label = f"{s.get('port')}/{(s.get('transport_protocol') or 'tcp').lower()} {s.get('protocol') or 'unknown'}"
        out.append({"type": "other", "value": label, "source": SOURCE, "confidence": "high", "attrs": {
            "kind": "service", "port": s.get("port"), "protocol": s.get("protocol"),
            "transport": s.get("transport_protocol"), "software": software(s),
            "labels": [label.get("value") for label in s.get("labels") or [] if label.get("value")],
            "vulnerabilities": len(s.get("vulns") or []), "scanned": s.get("scan_time")}})
    owner = asys.get("name") or (((host.get("whois") or {}).get("organization") or {}).get("name"))
    if owner:
        out.append({"type": "organization", "value": owner, "source": SOURCE, "confidence": "medium",
                    "attrs": {"role": "network owner", "asn": asys.get("asn"), "bgp_prefix": asys.get("bgp_prefix")}})
    place = ", ".join(p for p in (loc.get("city"), loc.get("province"), loc.get("country")) if p)
    if place:
        coords = loc.get("coordinates") or {}
        out.append({"type": "location", "value": place, "source": SOURCE, "confidence": "low",
                    "attrs": {"latitude": coords.get("latitude"), "longitude": coords.get("longitude"),
                              "basis": "IP geolocation"}})
    reverse = (dns.get("reverse_dns") or {}).get("names") or []
    names = list(dict.fromkeys(n.rstrip(".").lower() for n in (dns.get("names") or []) + reverse))
    for name in names[:50]:
        out.append({"type": "domain", "value": name, "source": SOURCE, "confidence": "medium",
                    "attrs": {"relation": "points at this IP address"}})
    return out


def lookup(sdk, ip, organization_id=None):
    """The host record, or None when Censys has nothing on the address."""
    res = sdk.global_data.get_host(host_id=ip, organization_id=organization_id)
    resource = res.result.resource if res.result else None
    return resource.model_dump(mode="json", exclude_none=True) if resource else None


def main(argv=None):
    parser = argparse.ArgumentParser(prog="censys-host", description="Look an IP address up in Censys.")
    parser.add_argument("ip")
    args = parser.parse_args(argv)
    token = os.environ.get(KEY, "").strip()
    if not token:
        print(f"{KEY} is not set: add it with `ot keys set {KEY}`", file=sys.stderr)
        return 3
    try:
        with SDK(personal_access_token=token) as sdk:
            host = lookup(sdk, args.ip.strip(), os.environ.get(ORG, "").strip() or None)
    except SDKBaseError as exc:
        if exc.status_code == 404:
            host = None
        else:
            print(f"Censys: HTTP {exc.status_code}: {exc.message}", file=sys.stderr)
            return 1
    except (models.NoResponseError, httpx.HTTPError) as exc:
        print(f"Censys: {exc}", file=sys.stderr)
        return 1
    if host is None:
        print(f"Censys has no record of {args.ip}", file=sys.stderr)
    json.dump({"entities": entities(host) if host else []}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
