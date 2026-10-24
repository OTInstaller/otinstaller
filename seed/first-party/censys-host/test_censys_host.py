import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import httpx
from censys_platform import models

import censys_host

HOST = {
    "ip": "8.8.8.8",
    "autonomous_system": {"asn": 15169, "name": "GOOGLE", "bgp_prefix": "8.8.8.0/24"},
    "location": {"city": "Mountain View", "province": "California", "country": "United States",
                 "coordinates": {"latitude": 37.4, "longitude": -122.1}},
    "dns": {"names": ["dns.google."], "reverse_dns": {"names": ["dns.google", "DNS.GOOGLE"]}},
    "labels": [{"value": "DNS"}],
    "services": [
        {"port": 53, "protocol": "DNS", "transport_protocol": "udp", "software": [{"vendor": "google", "product": "dns"}]},
        {"port": 443, "protocol": "HTTP", "transport_protocol": "tcp", "vulns": [{"id": "x"}]},
    ],
}


class FakeSDK:
    def __init__(self, result):
        self.result, self.calls = result, []
        self.global_data = self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_host(self, host_id, organization_id=None):
        self.calls.append((host_id, organization_id))
        if isinstance(self.result, Exception):
            raise self.result
        resource = models.Host(**self.result)
        return mock.Mock(result=mock.Mock(resource=resource))


def auth_error():
    response = httpx.Response(401, request=httpx.Request("GET", "https://api.platform.censys.io/v3/global/asset/host/x"))
    return models.SDKError("Access credentials are invalid", response)


class CensysHostTest(unittest.TestCase):
    def test_entities(self):
        found = censys_host.entities(HOST)
        self.assertEqual([e["type"] for e in found], ["ip", "other", "other", "organization", "location", "domain"])
        self.assertEqual(found[0]["attrs"]["ports"], [53, 443])
        self.assertEqual(found[0]["attrs"]["labels"], ["DNS"])
        self.assertEqual(found[1]["value"], "53/udp DNS")
        self.assertEqual(found[1]["attrs"]["software"], ["google dns"])
        self.assertEqual(found[2]["attrs"]["vulnerabilities"], 1)
        self.assertEqual(found[4]["value"], "Mountain View, California, United States")
        self.assertEqual(found[5]["value"], "dns.google")

    def test_lookup_passes_organisation(self):
        sdk = FakeSDK(HOST)
        host = censys_host.lookup(sdk, "8.8.8.8", "org-1")
        self.assertEqual(sdk.calls, [("8.8.8.8", "org-1")])
        self.assertEqual(host["autonomous_system"]["name"], "GOOGLE")

    def test_missing_token_exits_3(self):
        with mock.patch.dict(os.environ, {}, clear=True), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(censys_host.main(["8.8.8.8"]), 3)
        self.assertIn("CENSYS_API_TOKEN", err.getvalue())

    def test_auth_error_exits_1(self):
        with mock.patch.dict(os.environ, {"CENSYS_API_TOKEN": "t"}, clear=True), \
                mock.patch.object(censys_host, "SDK", return_value=FakeSDK(auth_error())), \
                redirect_stderr(io.StringIO()) as err:
            self.assertEqual(censys_host.main(["8.8.8.8"]), 1)
        self.assertIn("HTTP 401", err.getvalue())

    def test_prints_entities(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"CENSYS_API_TOKEN": "t"}, clear=True), \
                mock.patch.object(censys_host, "SDK", return_value=FakeSDK(HOST)), redirect_stdout(out):
            self.assertEqual(censys_host.main(["8.8.8.8"]), 0)
        self.assertEqual(json.loads(out.getvalue())["entities"][0]["value"], "8.8.8.8")


if __name__ == "__main__":
    unittest.main()
