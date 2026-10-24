import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from pyhunter.exceptions import HunterApiError

import hunter_domain_search

DATA = {
    "domain": "example.com", "organization": "Example Inc", "pattern": "{first}.{last}", "accept_all": False,
    "emails": [
        {"value": "Jane.Doe@example.com", "type": "personal", "confidence": 94, "first_name": "Jane", "last_name": "Doe",
         "position": "CTO", "department": "it", "verification": {"status": "valid"},
         "sources": [{"uri": "https://example.com/team"}, {"uri": "https://blog.example.com/"}]},
        {"value": "info@example.com", "type": "generic", "confidence": 60, "sources": []},
        {"value": None},
    ],
}


class HunterDomainSearchTest(unittest.TestCase):
    def test_entities(self):
        found = hunter_domain_search.entities(DATA)
        self.assertEqual([e["type"] for e in found], ["email", "person", "email", "organization"])
        self.assertEqual(found[0]["value"], "jane.doe@example.com")
        self.assertEqual(found[0]["confidence"], "high")
        self.assertEqual(found[0]["attrs"]["source_count"], 2)
        self.assertEqual(found[1]["value"], "Jane Doe")
        self.assertEqual(found[2]["confidence"], "medium")
        self.assertEqual(found[3]["attrs"]["email_pattern"], "{first}.{last}")

    def test_missing_key_exits_3(self):
        with mock.patch.dict(os.environ, {}, clear=True), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(hunter_domain_search.main(["example.com"]), 3)
        self.assertIn("HUNTER_API_KEY", err.getvalue())

    def test_search(self):
        client, out = mock.Mock(), io.StringIO()
        client.domain_search.return_value = DATA
        with mock.patch.dict(os.environ, {"HUNTER_API_KEY": "k"}), \
                mock.patch.object(hunter_domain_search, "PyHunter", return_value=client), redirect_stdout(out):
            self.assertEqual(hunter_domain_search.main(["Example.COM.", "--limit", "500"]), 0)
        client.domain_search.assert_called_once_with(domain="example.com", limit=100)
        self.assertEqual(len(json.loads(out.getvalue())["entities"]), 4)

    def test_api_error_exits_1(self):
        client = mock.Mock()
        client.domain_search.side_effect = HunterApiError("No user found for the API key supplied", status_code=401)
        with mock.patch.dict(os.environ, {"HUNTER_API_KEY": "k"}), \
                mock.patch.object(hunter_domain_search, "PyHunter", return_value=client), \
                redirect_stderr(io.StringIO()) as err:
            self.assertEqual(hunter_domain_search.main(["example.com"]), 1)
        self.assertIn("HTTP 401", err.getvalue())


if __name__ == "__main__":
    unittest.main()
