#!/usr/bin/env python3
"""Looks up a Bitcoin address on the public Blockstream Esplora API: balance, totals and recent transactions.

Prints {"entities": [...]}: the address with its totals, its recent transactions, and the addresses it
sent to or received from in them (counterparties). Amounts are in BTC.
"""
import argparse
import json
import re
import sys
import urllib.error
import urllib.request

API = "https://blockstream.info/api"
USER_AGENT = "osintverse-btc-address/0.1 (+https://otinstaller.com)"
ADDRESS_RE = re.compile(r"^(?:[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[ac-hj-np-z02-9]{11,71})$")
SAT = 100_000_000


def get(path):
    req = urllib.request.Request(API + path, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def summarize(address, info, txs, limit=25):
    chain, pool = info.get("chain_stats", {}), info.get("mempool_stats", {})
    received = chain.get("funded_txo_sum", 0)
    sent = chain.get("spent_txo_sum", 0)
    out = [{"type": "crypto_address", "value": address, "source": "blockstream", "confidence": "high",
            "attrs": {"chain": "bitcoin", "balance_btc": (received - sent) / SAT, "received_btc": received / SAT,
                      "sent_btc": sent / SAT, "tx_count": chain.get("tx_count", 0),
                      "unconfirmed_tx_count": pool.get("tx_count", 0)}}]
    counterparties = {}
    for tx in txs[:limit]:
        status = tx.get("status", {})
        ins = [v.get("prevout") or {} for v in tx.get("vin", [])]
        outs = tx.get("vout", [])
        delta = sum(o.get("value", 0) for o in outs if o.get("scriptpubkey_address") == address) \
            - sum(i.get("value", 0) for i in ins if i.get("scriptpubkey_address") == address)
        out.append({"type": "transaction", "value": tx["txid"], "source": "blockstream", "confidence": "high",
                    "attrs": {"chain": "bitcoin", "confirmed": status.get("confirmed", False),
                              "block_height": status.get("block_height"), "block_time": status.get("block_time"),
                              "net_btc": delta / SAT, "fee_btc": tx.get("fee", 0) / SAT,
                              "url": f"https://blockstream.info/tx/{tx['txid']}"}})
        sides = [("received_from", i.get("scriptpubkey_address")) for i in ins] if delta > 0 else \
            [("sent_to", o.get("scriptpubkey_address")) for o in outs]
        for relation, other in sides:
            if other and other != address:
                counterparties.setdefault((other, relation), []).append(tx["txid"])
    for (other, relation), txids in counterparties.items():
        out.append({"type": "crypto_address", "value": other, "source": "blockstream", "confidence": "medium",
                    "attrs": {"chain": "bitcoin", "relation": relation, "transactions": txids[:5]}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="btc-address")
    parser.add_argument("--limit", type=int, default=25, help="recent transactions to include (at most 25)")
    parser.add_argument("address")
    args = parser.parse_args(argv)
    address = args.address.strip()
    if not ADDRESS_RE.match(address):
        print(f"{address} is not a Bitcoin address", file=sys.stderr)
        return 2
    try:
        info = get(f"/address/{address}")
        txs = get(f"/address/{address}/txs") if args.limit > 0 else []
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"Blockstream API error: {exc}", file=sys.stderr)
        return 1
    json.dump({"entities": summarize(address, info, txs, min(args.limit, 25))}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
