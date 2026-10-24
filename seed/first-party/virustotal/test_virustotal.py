import io
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import vt

import virustotal

IP_REPORT = {
    "last_analysis_stats": {"malicious": 0, "suspicious": 0, "harmless": 62, "undetected": 30},
    "reputation": 532, "tags": [], "asn": 15169, "as_owner": "GOOGLE", "network": "8.8.8.0/24", "country": "US",
    "continent": "NA", "last_analysis_date": 1729700000,
}


class FakeObject:
    def __init__(self, attributes):
        self.attributes = attributes

    def to_dict(self):
        return {"type": "x", "attributes": self.attributes}


class FakeClient:
    def __init__(self, result):
        self.result, self.paths = result, []

    def get_object(self, path):
        self.paths.append(path)
        if isinstance(self.result, Exception):
            raise self.result
        return FakeObject(self.result)


class VirusTotalTest(unittest.TestCase):
    def test_ip(self):
        report = virustotal.lookup(FakeClient(IP_REPORT), "ip", "8.8.8.8")
        self.assertEqual(report["last_analysis_date"], "2024-10-23T16:13:20+00:00")
        found = virustotal.entities("ip", "8.8.8.8", report)
        self.assertEqual([e["type"] for e in found], ["ip", "organization", "location"])
        self.assertEqual(found[0]["attrs"]["harmless"], 62)
        self.assertEqual(found[0]["confidence"], "low")
        self.assertEqual(found[1]["value"], "GOOGLE")

    def test_domain_dns_records(self):
        report = {"last_analysis_stats": {"malicious": 4}, "registrar": "Example Registrar",
                  "last_dns_records": [{"type": "A", "value": "93.184.215.14", "ttl": 300}, {"type": "NS"}]}
        found = virustotal.entities("domain", "example.com", report)
        self.assertEqual(found[0]["confidence"], "high")
        self.assertEqual([e["value"] for e in found[1:]], ["93.184.215.14"])
        self.assertEqual(found[1]["attrs"]["record_type"], "A")

    def test_url_uses_url_id(self):
        client = FakeClient({"title": "Example"})
        virustotal.lookup(client, "url", "https://example.com/")
        self.assertEqual(client.paths, ["/urls/" + vt.url_id("https://example.com/")])

    def test_file(self):
        report = {"sha256": "a" * 64, "names": [f"n{i}" for i in range(20)],
                  "popular_threat_classification": {"suggested_threat_label": "trojan.x"}}
        found = virustotal.entities("hash", "A" * 64, report)
        self.assertEqual(found[0]["type"], "document")
        self.assertEqual(found[0]["value"], "a" * 64)
        self.assertEqual(len(found[0]["attrs"]["names"]), 10)
        self.assertEqual(found[0]["attrs"]["threat_label"], "trojan.x")

    def test_not_found_is_none(self):
        self.assertIsNone(virustotal.lookup(FakeClient(vt.APIError("NotFoundError", "x")), "ip", "8.8.8.8"))

    def test_missing_key_exits_3(self):
        with mock.patch.dict(os.environ, {}, clear=True), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(virustotal.main(["--ip", "8.8.8.8"]), 3)
        self.assertIn("VIRUSTOTAL_API_KEY", err.getvalue())

    def test_needs_exactly_one_target(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stop:
            virustotal.main(["--ip", "8.8.8.8", "--domain", "example.com"])
        self.assertEqual(stop.exception.code, 2)

    def test_api_error_exits_1(self):
        client = mock.MagicMock()
        client.__enter__.return_value = FakeClient(vt.APIError("WrongCredentialsError", "bad key"))
        with mock.patch.dict(os.environ, {"VIRUSTOTAL_API_KEY": "k"}), \
                mock.patch.object(vt, "Client", return_value=client), redirect_stderr(io.StringIO()):
            self.assertEqual(virustotal.main(["--ip", "8.8.8.8"]), 1)

    def test_prints_entities(self):
        client = mock.MagicMock()
        client.__enter__.return_value = FakeClient(IP_REPORT)
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"VIRUSTOTAL_API_KEY": "k"}), \
                mock.patch.object(vt, "Client", return_value=client), redirect_stdout(out):
            self.assertEqual(virustotal.main(["--ip", "8.8.8.8"]), 0)
        self.assertIn('"type": "ip"', out.getvalue())


if __name__ == "__main__":
    unittest.main()
