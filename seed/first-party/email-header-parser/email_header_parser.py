#!/usr/bin/env python3
"""Parses raw email headers into senders, relay hops, IPs and authentication results.

Prints {"entities": [...], "hops": [...], "auth": {...}}. Runs offline.
"""
import argparse
import ipaddress
import json
import re
import sys
from email.parser import HeaderParser
from email.utils import getaddresses, parsedate_to_datetime

IP_RE = re.compile(r"\[?((?:\d{1,3}\.){3}\d{1,3}|[0-9a-fA-F:]*:[0-9a-fA-F:]+)\]?")
# A host name ends at a space, or at the ";" before the date, which some servers write without a space.
FROM_RE = re.compile(r"\bfrom\s+([^\s;]+)", re.I)
BY_RE = re.compile(r"\bby\s+([^\s;]+)", re.I)
AUTH_RE = re.compile(r"\b(spf|dkim|dmarc|arc)=(\w+)", re.I)


def public_ips(text):
    out = []
    for m in IP_RE.finditer(text):
        try:
            ip = ipaddress.ip_address(m.group(1))
        except ValueError:
            continue
        if ip.is_global and str(ip) not in out:
            out.append(str(ip))
    return out


def parse(raw):
    # Inputs often arrive with literal "\n" when pasted on one line.
    if "\n" not in raw and "\\n" in raw:
        raw = raw.replace("\\r\\n", "\n").replace("\\n", "\n")
    msg = HeaderParser().parsestr(raw.strip() + "\n\n", headersonly=True)
    entities, seen = [], set()

    def add(kind, value, **attrs):
        key = (kind, value.lower())
        if value and key not in seen:
            seen.add(key)
            entities.append({"type": kind, "value": value, "source": "email-header-parser", "confidence": "high",
                             "attrs": {k: v for k, v in attrs.items() if v}})

    for header in ["From", "Reply-To", "Return-Path", "Sender", "To", "Cc"]:
        for name, addr in getaddresses(msg.get_all(header, [])):
            if "@" in addr:
                add("email", addr.lower(), header=header.lower(), display_name=name)
                add("domain", addr.rsplit("@", 1)[1].lower(), header=header.lower())

    message_id = msg.get("Message-ID", "")
    if "@" in message_id:
        add("domain", message_id.strip("<> ").rsplit("@", 1)[1].lower(), header="message-id")

    # Received headers are added on top, so the oldest hop is last.
    hops = []
    for i, received in enumerate(reversed(msg.get_all("Received", []))):
        received = " ".join(received.split())
        hop = {"hop": i + 1, "from": None, "by": None, "ips": public_ips(received.split(";")[0]), "date": None}
        if m := FROM_RE.search(received):
            hop["from"] = m.group(1).strip("()")
        if m := BY_RE.search(received):
            hop["by"] = m.group(1).strip("()")
        if ";" in received:
            try:
                hop["date"] = parsedate_to_datetime(received.rsplit(";", 1)[1].strip()).isoformat()
            except (TypeError, ValueError):
                pass
        hops.append(hop)
        for ip in hop["ips"]:
            add("ip", ip, header="received", hop=hop["hop"])

    for header in ["X-Originating-IP", "X-Sender-IP", "X-Forwarded-For"]:
        for ip in public_ips(msg.get(header, "")):
            add("ip", ip, header=header.lower())

    auth = {}
    for header in ["Authentication-Results", "ARC-Authentication-Results"]:
        for value in msg.get_all(header, []):
            for kind, result in AUTH_RE.findall(value):
                auth.setdefault(kind.lower(), result.lower())
    return {"entities": entities, "hops": hops, "auth": auth,
            "subject": msg.get("Subject"), "date": msg.get("Date"), "message_id": message_id or None}


def main(argv=None):
    parser = argparse.ArgumentParser(prog="email-header-parser")
    parser.add_argument("headers", help="raw headers; '-' reads them from stdin")
    args = parser.parse_args(argv)
    raw = sys.stdin.read() if args.headers == "-" else args.headers
    json.dump(parse(raw), sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
