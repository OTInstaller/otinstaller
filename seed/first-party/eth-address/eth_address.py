#!/usr/bin/env python3
"""Looks up an Ethereum address on the public Blockscout API: balance, ENS name, contract details and recent
transactions.

Prints {"entities": [...]}: the address, its recent transactions and the addresses on the other side of
them. Amounts are in ETH. No API key is needed.
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request

API = "https://eth.blockscout.com/api/v2"
USER_AGENT = "osintverse-eth-address/0.1 (+https://otinstaller.com)"
ADDRESS_RE = re.compile(r"^0x[0-9a-fA-F]{40}$")
WEI = 10**18


def get(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.load(resp)


def eth(value):
    try:
        return int(value or 0) / WEI
    except (TypeError, ValueError):
        return None


def summarize(address, info, counters, txs, limit=25):
    address = info.get("hash") or address
    attrs = {"chain": "ethereum", "balance_eth": eth(info.get("coin_balance")), "is_contract": info.get("is_contract", False),
             "ens_name": info.get("ens_domain_name"), "name": info.get("name"),
             "tx_count": int(counters.get("transactions_count") or 0),
             "token_transfer_count": int(counters.get("token_transfers_count") or 0),
             "url": f"https://eth.blockscout.com/address/{address}"}
    if token := info.get("token"):
        attrs["token"] = {k: token.get(k) for k in ("name", "symbol", "type")}
    out = [{"type": "crypto_address", "value": address, "source": "blockscout", "confidence": "high",
            "attrs": {k: v for k, v in attrs.items() if v is not None}}]
    others = {}
    for tx in txs[:limit]:
        frm, to = (tx.get("from") or {}).get("hash"), (tx.get("to") or {}).get("hash")
        out.append({"type": "transaction", "value": tx["hash"], "source": "blockscout", "confidence": "high",
                    "attrs": {"chain": "ethereum", "from": frm, "to": to, "value_eth": eth(tx.get("value")),
                              "timestamp": tx.get("timestamp"), "status": tx.get("status"), "method": tx.get("method"),
                              "url": f"https://eth.blockscout.com/tx/{tx['hash']}"}})
        outgoing = (frm or "").lower() == address.lower()
        other = to if outgoing else frm
        if other and other.lower() != address.lower():
            others.setdefault((other, "sent_to" if outgoing else "received_from"), []).append(tx["hash"])
    for (other, relation), hashes in others.items():
        out.append({"type": "crypto_address", "value": other, "source": "blockscout", "confidence": "medium",
                    "attrs": {"chain": "ethereum", "relation": relation, "transactions": hashes[:5]}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="eth-address")
    parser.add_argument("--limit", type=int, default=25, help="recent transactions to include (at most 50)")
    parser.add_argument("address")
    args = parser.parse_args(argv)
    address = args.address.strip()
    if not ADDRESS_RE.match(address):
        print(f"{address} is not an Ethereum address", file=sys.stderr)
        return 2
    try:
        info = get(f"/addresses/{address}")
        counters = get(f"/addresses/{address}/counters")
        txs = get(f"/addresses/{address}/transactions").get("items", []) if args.limit > 0 else []
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            info, counters, txs = {"hash": address}, {}, []
        else:
            print(f"Blockscout API error: {exc}", file=sys.stderr)
            return 1
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"Blockscout API error: {exc}", file=sys.stderr)
        return 1
    json.dump({"entities": summarize(address, info, counters, txs, min(args.limit, 50))}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
