import unittest

from eth_address import ADDRESS_RE, summarize

ADDR = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
INFO = {"hash": ADDR, "coin_balance": "2500000000000000000", "is_contract": True, "name": "WETH9",
        "token": {"name": "Wrapped Ether", "symbol": "WETH", "type": "ERC-20", "holders": "1"}}
COUNTERS = {"transactions_count": "1000", "token_transfers_count": "50"}
TXS = [
    {"hash": "0x01", "from": {"hash": "0xaaaa000000000000000000000000000000000001"}, "to": {"hash": ADDR},
     "value": "1000000000000000000", "timestamp": "2024-01-01T00:00:00Z", "status": "ok", "method": "deposit"},
    {"hash": "0x02", "from": {"hash": ADDR.lower()}, "to": {"hash": "0xbbbb000000000000000000000000000000000002"},
     "value": "0", "timestamp": "2024-01-02T00:00:00Z", "status": "ok", "method": "transfer"},
]


class EthAddressTest(unittest.TestCase):
    def test_address_format(self):
        self.assertTrue(ADDRESS_RE.match(ADDR))
        self.assertFalse(ADDRESS_RE.match("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"))

    def test_summarize(self):
        out = summarize(ADDR, INFO, COUNTERS, TXS)
        self.assertEqual(out[0]["attrs"]["balance_eth"], 2.5)
        self.assertEqual(out[0]["attrs"]["tx_count"], 1000)
        self.assertEqual(out[0]["attrs"]["token"], {"name": "Wrapped Ether", "symbol": "WETH", "type": "ERC-20"})
        self.assertNotIn("ens_name", out[0]["attrs"])
        others = {(e["value"], e["attrs"]["relation"]) for e in out[1:] if e["type"] == "crypto_address"}
        self.assertEqual(others, {("0xaaaa000000000000000000000000000000000001", "received_from"),
                                  ("0xbbbb000000000000000000000000000000000002", "sent_to")})


if __name__ == "__main__":
    unittest.main()
