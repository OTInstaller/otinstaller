import unittest

from btc_address import ADDRESS_RE, summarize

ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
INFO = {"chain_stats": {"funded_txo_sum": 300_000_000, "spent_txo_sum": 100_000_000, "tx_count": 2},
        "mempool_stats": {"tx_count": 0}}
TXS = [
    {"txid": "aa", "fee": 1000, "status": {"confirmed": True, "block_height": 100, "block_time": 1700000000},
     "vin": [{"prevout": {"scriptpubkey_address": "1Sender", "value": 300_000_000}}],
     "vout": [{"scriptpubkey_address": ADDR, "value": 300_000_000}]},
    {"txid": "bb", "fee": 1000, "status": {"confirmed": False},
     "vin": [{"prevout": {"scriptpubkey_address": ADDR, "value": 300_000_000}}],
     "vout": [{"scriptpubkey_address": "bc1qreceiver", "value": 100_000_000}, {"scriptpubkey_address": ADDR, "value": 199_999_000}]},
]


class BtcAddressTest(unittest.TestCase):
    def test_address_format(self):
        self.assertTrue(ADDRESS_RE.match(ADDR))
        self.assertTrue(ADDRESS_RE.match("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"))
        self.assertFalse(ADDRESS_RE.match("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"))

    def test_summarize(self):
        out = summarize(ADDR, INFO, TXS)
        self.assertEqual(out[0]["attrs"]["balance_btc"], 2.0)
        txs = {e["value"]: e["attrs"] for e in out if e["type"] == "transaction"}
        self.assertEqual(txs["aa"]["net_btc"], 3.0)
        self.assertAlmostEqual(txs["bb"]["net_btc"], -1.00001)
        others = {(e["value"], e["attrs"]["relation"]) for e in out[1:] if e["type"] == "crypto_address"}
        self.assertEqual(others, {("1Sender", "received_from"), ("bc1qreceiver", "sent_to")})


if __name__ == "__main__":
    unittest.main()
