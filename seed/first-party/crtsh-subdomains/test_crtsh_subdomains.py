import unittest
from unittest import mock

import crtsh_subdomains
from crtsh_subdomains import fetch, subdomains

ROWS = [
    {"name_value": "www.example.com\nexample.com", "issuer_name": "C=US, O=DigiCert Inc",
     "not_before": "2024-01-01T00:00:00", "not_after": "2025-01-01T00:00:00"},
    {"name_value": "*.dev.example.com", "issuer_name": "C=US, O=Let's Encrypt",
     "not_before": "2023-05-01T00:00:00", "not_after": "2023-08-01T00:00:00"},
    {"name_value": "WWW.example.com", "issuer_name": "C=US, O=Let's Encrypt",
     "not_before": "2022-01-01T00:00:00", "not_after": "2022-04-01T00:00:00"},
    {"name_value": "example.com.evil.net\nnotexample.com", "issuer_name": "x",
     "not_before": "2022-01-01T00:00:00", "not_after": "2022-04-01T00:00:00"},
]


class CrtshSubdomainsTest(unittest.TestCase):
    def test_subdomains(self):
        out = {e["value"]: e["attrs"] for e in subdomains("example.com", ROWS)}
        self.assertEqual(sorted(out), ["dev.example.com", "example.com", "www.example.com"])
        www = out["www.example.com"]
        self.assertEqual(www["certificates"], 2)
        self.assertEqual(www["first_seen"], "2022-01-01T00:00:00")
        self.assertEqual(www["last_seen"], "2025-01-01T00:00:00")
        self.assertEqual(len(www["issuers"]), 2)

    def test_falls_back_to_certspotter(self):
        calls = []

        def fake_get(url):
            calls.append(url)
            if url.startswith("https://crt.sh/"):
                raise OSError("HTTP Error 502: Bad Gateway")
            return [{"dns_names": ["*.example.com", "api.example.com"], "issuer": {"name": "C=US, O=Let's Encrypt"},
                     "not_before": "2026-01-01T00:00:00Z", "not_after": "2026-04-01T00:00:00Z"}]

        with mock.patch.object(crtsh_subdomains, "get_json", fake_get):
            rows, source = fetch("example.com", sleep=lambda s: None)
        self.assertEqual(source, "certspotter")
        self.assertEqual(sum(u.startswith("https://crt.sh/") for u in calls), 3)
        self.assertEqual([e["value"] for e in subdomains("example.com", rows, source)], ["api.example.com", "example.com"])


if __name__ == "__main__":
    unittest.main()
