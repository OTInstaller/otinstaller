import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import urlscan

import urlscan_search

RESULT = {
    "_id": "01a16e9b-3096-77cc-8bb0-eed0ea9665cf",
    "task": {"time": "2026-10-24T15:50:33.985Z", "url": "http://www.example.com/", "uuid": "x"},
    "page": {"url": "https://www.example.com/", "domain": "www.example.com", "apexDomain": "example.com",
             "ip": "93.184.215.14", "asn": "AS15133", "asnname": "EDGECAST", "country": "US", "title": "Example Domain",
             "status": "200"},
    "screenshot": "https://urlscan.io/screenshots/01a16e9b-3096-77cc-8bb0-eed0ea9665cf.png",
}


class FakeClient:
    def __init__(self, results):
        self.results, self.calls = results, []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def search(self, q, size=100, limit=None):
        self.calls.append((q, size, limit))
        if isinstance(self.results, Exception):
            raise self.results
        return iter(self.results)


class UrlscanSearchTest(unittest.TestCase):
    def test_queries(self):
        self.assertEqual(urlscan_search.build_query("domain", "Example.COM."), 'page.domain:"example.com"')
        self.assertEqual(urlscan_search.build_query("url", 'https://a/"b'), 'page.url:"https://a/\\"b"')
        self.assertEqual(urlscan_search.build_query("query", "page.asn:AS15169"), "page.asn:AS15169")

    def test_entities(self):
        found = urlscan_search.entities([RESULT, RESULT, {"page": {}, "task": {}}])
        self.assertEqual([e["type"] for e in found], ["url", "url", "ip", "subdomain"])
        self.assertEqual(found[0]["attrs"]["scan"], "https://urlscan.io/result/01a16e9b-3096-77cc-8bb0-eed0ea9665cf/")
        self.assertEqual(found[2]["attrs"]["scans"], 2)

    def test_search_without_key(self):
        client, out = FakeClient([RESULT]), io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(urlscan, "Client", return_value=client) as make, redirect_stdout(out):
            self.assertEqual(urlscan_search.main(["--domain", "example.com", "--limit", "5"]), 0)
        make.assert_called_once_with("")
        self.assertEqual(client.calls, [('page.domain:"example.com"', 5, 5)])
        self.assertEqual(json.loads(out.getvalue())["entities"][0]["value"], "https://www.example.com/")

    def test_api_error_exits_1(self):
        client = FakeClient(urlscan.APIError("Too Many Requests", status=429))
        with mock.patch.object(urlscan, "Client", return_value=client), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(urlscan_search.main(["--ip", "8.8.8.8"]), 1)
        self.assertIn("HTTP 429", err.getvalue())

    def test_needs_exactly_one_target(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stop:
            urlscan_search.main([])
        self.assertEqual(stop.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
