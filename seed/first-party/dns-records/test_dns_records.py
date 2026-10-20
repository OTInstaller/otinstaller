import unittest

from dns_records import entities


class DnsRecordsTest(unittest.TestCase):
    def test_entities(self):
        records = {
            "A": [{"value": "93.184.216.34", "ttl": 300}],
            "AAAA": [{"value": "2606:2800:220:1::248", "ttl": 300}],
            "MX": [{"value": "10 mail.example.com.", "ttl": 300}, {"value": "20 mail.example.com.", "ttl": 300}],
            "NS": [{"value": "a.iana-servers.net.", "ttl": 300}],
            "TXT": [{"value": '"v=spf1 -all"', "ttl": 300}],
        }
        out = entities("example.com", records)
        values = [(e["type"], e["value"]) for e in out]
        self.assertIn(("ip", "93.184.216.34"), values)
        self.assertIn(("ip", "2606:2800:220:1::248"), values)
        self.assertIn(("dns_record", 'TXT "v=spf1 -all"'), values)
        # Both MX records point at the same host, which is reported once.
        self.assertEqual(values.count(("domain", "mail.example.com")), 1)
        self.assertIn(("domain", "a.iana-servers.net"), values)
        ip6 = next(e for e in out if e["value"] == "2606:2800:220:1::248")
        self.assertEqual(ip6["attrs"]["family"], "ipv6")


if __name__ == "__main__":
    unittest.main()
