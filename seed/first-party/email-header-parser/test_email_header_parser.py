import unittest

from email_header_parser import parse

HEADERS = """Received: from mail.example.org (mail.example.org [93.184.216.34])
\tby mx.example.net (Postfix) with ESMTPS id 4AB;
\tMon, 6 Jan 2025 10:00:05 +0000
Received: from [10.0.0.5] (unknown [198.51.100.7])
\tby mail.example.org with ESMTPSA; Mon, 6 Jan 2025 10:00:01 +0000
Authentication-Results: mx.example.net; spf=pass smtp.mailfrom=example.org; dkim=pass header.d=example.org; dmarc=fail
From: "Sales Team" <sales@example.org>
Reply-To: billing@example.com
Message-ID: <abc123@mail.example.org>
Subject: Invoice
X-Originating-IP: [8.8.8.8]
"""


class EmailHeaderParserTest(unittest.TestCase):
    def test_parse(self):
        out = parse(HEADERS)
        values = {(e["type"], e["value"]) for e in out["entities"]}
        self.assertIn(("email", "sales@example.org"), values)
        self.assertIn(("email", "billing@example.com"), values)
        self.assertIn(("domain", "mail.example.org"), values)
        self.assertIn(("ip", "93.184.216.34"), values)
        self.assertIn(("ip", "8.8.8.8"), values)
        # Private and documentation-only addresses are not reported.
        self.assertNotIn(("ip", "10.0.0.5"), values)
        self.assertEqual(out["auth"], {"spf": "pass", "dkim": "pass", "dmarc": "fail"})
        self.assertEqual([h["hop"] for h in out["hops"]], [1, 2])
        self.assertEqual(out["hops"][1]["by"], "mx.example.net")
        self.assertTrue(out["hops"][0]["date"].startswith("2025-01-06T10:00:01"))

    def test_host_before_date_without_space(self):
        out = parse("Received: from mail.example.org (mail.example.org [93.184.216.34]) by mx.example.net; Mon, 6 Jan 2025 10:00:05 +0000")
        self.assertEqual(out["hops"][0]["from"], "mail.example.org")
        self.assertEqual(out["hops"][0]["by"], "mx.example.net")
        self.assertTrue(out["hops"][0]["date"].startswith("2025-01-06T10:00:05"))

    def test_escaped_newlines(self):
        out = parse("From: a@example.com\\nReply-To: b@example.net")
        self.assertEqual([e["value"] for e in out["entities"] if e["type"] == "email"], ["a@example.com", "b@example.net"])


if __name__ == "__main__":
    unittest.main()
