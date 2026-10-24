import io
import json
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import shodan_internetdb

RECORD = {"cpes": ["cpe:/a:cloudflare:cloudflare"], "hostnames": ["one.one.one.one", "ONE.one.one.one."],
          "ip": "1.1.1.1", "ports": [443, 53, 80], "tags": [], "vulns": ["CVE-2023-44487"]}


def run(argv):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = shodan_internetdb.main(argv)
    return code, out.getvalue(), err.getvalue()


class ShodanInternetDBTest(unittest.TestCase):
    def test_entities(self):
        found = shodan_internetdb.entities(RECORD)
        self.assertEqual([e["type"] for e in found], ["ip", "domain"])
        self.assertEqual(found[0]["attrs"]["ports"], [53, 80, 443])
        self.assertEqual(found[0]["attrs"]["vulns"], ["CVE-2023-44487"])
        self.assertEqual(found[0]["attrs"]["hostnames"], ["one.one.one.one"])
        self.assertEqual(found[1]["value"], "one.one.one.one")

    def test_prints_entities(self):
        with mock.patch.object(shodan_internetdb, "fetch", return_value=RECORD) as fetch:
            code, out, _ = run([" 1.1.1.1 "])
        self.assertEqual(code, 0)
        fetch.assert_called_once_with("1.1.1.1")
        self.assertEqual(json.loads(out)["entities"][0]["value"], "1.1.1.1")

    def test_unknown_address_has_no_entities(self):
        with mock.patch.object(shodan_internetdb, "fetch", return_value=None):
            code, out, err = run(["8.8.4.4"])
        self.assertEqual((code, json.loads(out)), (0, {"entities": []}))
        self.assertIn("no information on 8.8.4.4", err)

    def test_private_address_is_not_looked_up(self):
        with mock.patch.object(shodan_internetdb, "fetch") as fetch:
            code, out, err = run(["10.0.0.1"])
        fetch.assert_not_called()
        self.assertEqual((code, json.loads(out)), (0, {"entities": []}))
        self.assertIn("private or reserved", err)

    def test_not_an_address_exits_2(self):
        code, _, err = run(["example.com"])
        self.assertEqual(code, 2)
        self.assertIn("not an IP address", err)

    def test_404_is_none(self):
        error = urllib.error.HTTPError(shodan_internetdb.API + "8.8.8.8", 404, "Not Found", {}, io.BytesIO(b"{}"))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            self.assertIsNone(shodan_internetdb.fetch("8.8.8.8"))

    def test_http_error_exits_1(self):
        error = urllib.error.HTTPError(shodan_internetdb.API + "8.8.8.8", 429, "Too Many Requests", {}, io.BytesIO())
        with mock.patch("urllib.request.urlopen", side_effect=error):
            code, _, err = run(["8.8.8.8"])
        self.assertEqual(code, 1)
        self.assertIn("429", err)


if __name__ == "__main__":
    unittest.main()
