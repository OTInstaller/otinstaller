import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import ipinfo
from ipinfo.exceptions import RequestQuotaExceededError

import ipinfo_lookup

DETAILS = {"ip": "8.8.8.8", "hostname": "dns.google", "city": "Mountain View", "region": "California",
           "country": "US", "country_name": "United States", "loc": "38.0088,-122.1175", "org": "AS15169 Google LLC",
           "postal": "94043", "timezone": "America/Los_Angeles", "anycast": True, "latitude": "38.0088",
           "longitude": "-122.1175"}


def handler(result):
    h = mock.Mock()
    if isinstance(result, Exception):
        h.getDetails.side_effect = result
    else:
        h.getDetails.return_value = mock.Mock(all=result)
    return h


class IPinfoTest(unittest.TestCase):
    def test_entities(self):
        found = ipinfo_lookup.entities(DETAILS)
        self.assertEqual([e["type"] for e in found], ["ip", "domain", "organization", "location"])
        self.assertEqual(found[0]["attrs"]["asn"], "AS15169")
        self.assertEqual(found[2]["value"], "Google LLC")
        self.assertEqual(found[3]["value"], "Mountain View, California, United States")

    def test_bogon_has_no_entities(self):
        self.assertEqual(ipinfo_lookup.entities({"ip": "10.0.0.1", "bogon": True}), [])

    def test_works_without_token(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(ipinfo, "getHandler", return_value=handler(DETAILS)) as make, redirect_stdout(out):
            self.assertEqual(ipinfo_lookup.main(["8.8.8.8"]), 0)
        make.assert_called_once_with(None)
        self.assertEqual(json.loads(out.getvalue())["entities"][0]["value"], "8.8.8.8")

    def test_quota_exits_1(self):
        with mock.patch.object(ipinfo, "getHandler", return_value=handler(RequestQuotaExceededError())), \
                redirect_stderr(io.StringIO()) as err:
            self.assertEqual(ipinfo_lookup.main(["8.8.8.8"]), 1)
        self.assertIn("IPINFO_TOKEN", err.getvalue())


if __name__ == "__main__":
    unittest.main()
