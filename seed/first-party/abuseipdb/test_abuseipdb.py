import io
import json
import os
import unittest
import urllib.error
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import abuseipdb

DATA = {
    "ipAddress": "203.0.113.9", "isPublic": True, "ipVersion": 4, "isWhitelisted": False, "abuseConfidenceScore": 87,
    "countryCode": "NL", "countryName": "Netherlands", "usageType": "Data Center/Web Hosting/Transit",
    "isp": "Example Hosting B.V.", "domain": "Example-Hosting.nl", "hostnames": ["vps9.example-hosting.nl."],
    "isTor": False, "totalReports": 3, "numDistinctUsers": 2, "lastReportedAt": "2026-10-23T08:00:00+00:00",
    "reports": [
        {"reportedAt": "2026-10-20T08:00:00+00:00", "comment": "SSH login attempts", "categories": [18, 22],
         "reporterId": 1, "reporterCountryCode": "DE", "reporterCountryName": "Germany"},
        {"reportedAt": "2026-10-23T08:00:00+00:00", "comment": "x" * 500, "categories": [14],
         "reporterId": 2, "reporterCountryCode": "US", "reporterCountryName": "United States"},
        {"reportedAt": "2026-10-21T08:00:00+00:00", "comment": "", "categories": [18, 99],
         "reporterId": 1, "reporterCountryCode": "DE", "reporterCountryName": "Germany"},
    ],
}


def response(body):
    resp = mock.MagicMock()
    resp.__enter__.return_value.read.return_value = json.dumps(body).encode()
    return resp


def run(argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=True), redirect_stdout(out), redirect_stderr(err):
        code = abuseipdb.main(argv)
    return code, out.getvalue(), err.getvalue()


class AbuseIPDBTest(unittest.TestCase):
    def test_entities(self):
        found = abuseipdb.entities(DATA)
        self.assertEqual([e["type"] for e in found], ["ip", "organization", "domain", "domain", "location"])
        ip = found[0]
        self.assertEqual(ip["confidence"], "high")
        self.assertEqual(ip["attrs"]["categories"], {"Brute-Force": 2, "SSH": 1, "Port Scan": 1, "99": 1})
        recent = ip["attrs"]["recent_reports"]
        self.assertEqual([r["reported_at"][:10] for r in recent], ["2026-10-23", "2026-10-21", "2026-10-20"])
        self.assertEqual(len(recent[0]["comment"]), 300)
        self.assertIsNone(recent[1]["comment"])
        self.assertEqual(recent[2]["categories"], ["Brute-Force", "SSH"])
        self.assertEqual(found[2]["value"], "example-hosting.nl")
        self.assertEqual(found[3]["value"], "vps9.example-hosting.nl")
        self.assertEqual(found[4]["value"], "Netherlands")

    def test_clean_address_is_low_confidence(self):
        found = abuseipdb.entities({"ipAddress": "8.8.8.8", "abuseConfidenceScore": 0, "totalReports": 0})
        self.assertEqual((len(found), found[0]["confidence"]), (1, "low"))

    def test_missing_key_exits_3(self):
        code, out, err = run(["8.8.8.8"])
        self.assertEqual((code, out), (3, ""))
        self.assertIn("ABUSEIPDB_API_KEY", err)

    def test_check_request(self):
        with mock.patch("urllib.request.urlopen", return_value=response({"data": DATA})) as urlopen:
            code, out, _ = run(["8.8.8.8", "--days", "400"], {"ABUSEIPDB_API_KEY": "secret-key"})
        self.assertEqual(code, 0)
        req = urlopen.call_args[0][0]
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)
        self.assertEqual(query["ipAddress"], ["8.8.8.8"])
        self.assertEqual(query["maxAgeInDays"], ["365"])
        self.assertEqual(req.get_header("Key"), "secret-key")
        self.assertNotIn("secret-key", req.full_url)
        self.assertEqual(json.loads(out)["entities"][0]["attrs"]["abuse_confidence_score"], 87)

    def test_refused_key_exits_1(self):
        body = {"errors": [{"detail": "Authentication failed. Your API key is either missing, incorrect, or revoked.",
                            "status": 401}]}
        error = urllib.error.HTTPError(abuseipdb.API, 401, "Unauthorized", {}, io.BytesIO(json.dumps(body).encode()))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            code, _, err = run(["8.8.8.8"], {"ABUSEIPDB_API_KEY": "bad"})
        self.assertEqual(code, 1)
        self.assertIn("refused the key", err)
        self.assertIn("Authentication failed", err)

    def test_daily_limit_exits_1(self):
        body = b'{"errors":[{"detail":"Daily rate limit of 1000 requests exceeded for this endpoint.","status":429}]}'
        error = urllib.error.HTTPError(abuseipdb.API, 429, "Too Many Requests", {}, io.BytesIO(body))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            code, _, err = run(["8.8.8.8"], {"ABUSEIPDB_API_KEY": "k"})
        self.assertEqual(code, 1)
        self.assertIn("Daily rate limit", err)

    def test_private_address_is_not_checked(self):
        with mock.patch.object(abuseipdb, "check") as check:
            code, out, _ = run(["10.1.2.3"], {"ABUSEIPDB_API_KEY": "k"})
        check.assert_not_called()
        self.assertEqual((code, json.loads(out)), (0, {"entities": []}))

    def test_not_an_address_exits_2(self):
        self.assertEqual(run(["example.com"], {"ABUSEIPDB_API_KEY": "k"})[0], 2)


if __name__ == "__main__":
    unittest.main()
