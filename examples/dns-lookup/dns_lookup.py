"""Resolves a domain's IPv4/IPv6 addresses and prints them as OTInstaller envelope entities."""
import json
import socket
import sys


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: dns-lookup <domain>", file=sys.stderr)
        return 2
    domain = sys.argv[1]
    try:
        infos = socket.getaddrinfo(domain, None)
    except socket.gaierror as exc:
        print(f"lookup failed: {exc}", file=sys.stderr)
        return 1
    ips = sorted({info[4][0] for info in infos})
    entities = [
        {"type": "ip", "value": ip, "source": "dns", "confidence": "high",
         "attrs": {"family": "ipv6" if ":" in ip else "ipv4", "domain": domain}}
        for ip in ips
    ]
    json.dump({"entities": entities}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
