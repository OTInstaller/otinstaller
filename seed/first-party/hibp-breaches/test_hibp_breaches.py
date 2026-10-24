import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import pyhibp

import hibp_breaches

BREACH = {"Name": "Adobe", "Title": "Adobe", "Domain": "adobe.com", "BreachDate": "2013-10-04",
          "AddedDate": "2013-12-04T00:00:00Z", "PwnCount": 152445165, "IsVerified": True,
          "DataClasses": ["Email addresses", "Password hints", "Passwords", "Usernames"],
          "Description": 'In October 2013, <a href="https://example.org">153 million</a> Adobe accounts were breached.'}


class HibpBreachesTest(unittest.TestCase):
    def test_entities(self):
        found = hibp_breaches.entities("jane@example.com", [BREACH, dict(BREACH, Name="X", Title="X", IsVerified=False)])
        self.assertEqual([e["type"] for e in found], ["breach", "breach"])
        self.assertEqual(found[0]["value"], "Adobe")
        self.assertEqual(found[0]["confidence"], "high")
        self.assertEqual(found[1]["confidence"], "medium")
        self.assertNotIn("<a", found[0]["attrs"]["description"])
        self.assertEqual(found[0]["attrs"]["link"], "https://haveibeenpwned.com/PwnedWebsites#Adobe")

    def test_missing_key_exits_3(self):
        with mock.patch.dict(os.environ, {}, clear=True), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(hibp_breaches.main(["jane@example.com"]), 3)
        self.assertIn("HIBP_API_KEY", err.getvalue())

    def test_lookup_sends_user_agent_and_key(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"HIBP_API_KEY": "k"}), \
                mock.patch.object(pyhibp, "get_account_breaches", return_value=[BREACH]) as get, \
                mock.patch.object(pyhibp, "set_user_agent") as ua, mock.patch.object(pyhibp, "set_api_key") as key, \
                redirect_stdout(out):
            self.assertEqual(hibp_breaches.main(["Jane@Example.com"]), 0)
        ua.assert_called_once()
        key.assert_called_once_with(key="k")
        get.assert_called_once_with(account="jane@example.com", truncate_response=False, include_unverified=True)
        self.assertEqual(json.loads(out.getvalue())["entities"][0]["attrs"]["accounts"], 152445165)

    def test_not_found_prints_nothing(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"HIBP_API_KEY": "k"}), \
                mock.patch.object(pyhibp, "get_account_breaches", return_value=False), \
                redirect_stdout(out), redirect_stderr(io.StringIO()):
            self.assertEqual(hibp_breaches.main(["jane@example.com"]), 0)
        self.assertEqual(json.loads(out.getvalue()), {"entities": []})

    def test_refused_key_exits_1(self):
        error = RuntimeError("HTTP 401 - Unauthorised - The API key provided was not valid.")
        with mock.patch.dict(os.environ, {"HIBP_API_KEY": "k"}), \
                mock.patch.object(pyhibp, "get_account_breaches", side_effect=error), \
                redirect_stderr(io.StringIO()) as err:
            self.assertEqual(hibp_breaches.main(["jane@example.com"]), 1)
        self.assertIn("401", err.getvalue())


if __name__ == "__main__":
    unittest.main()
