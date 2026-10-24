import io
import json
import os
import unittest
import urllib.error
import urllib.parse
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

import opensanctions

RESULTS = [
    {"id": "NK-person1", "caption": "Ivan Petrovich SIDOROV", "schema": "Person",
     "properties": {"name": ["Ivan Sidorov"], "alias": ["Ivan Petrovich Sidorov"], "birthDate": ["1961-02-03"],
                    "nationality": ["ru"], "country": ["ru"], "citizenship": ["ru", "cy"],
                    "position": ["Member of the State Duma"], "programId": ["EU-UKR"],
                    "topics": ["sanction", "role.pep"]},
     "datasets": ["eu_fsf", "ru_duma"], "referents": [], "target": True, "first_seen": "2022-03-01T00:00:00",
     "last_seen": "2026-10-20T00:00:00", "last_change": "2026-01-01T00:00:00", "score": 0.95, "match": True},
    {"id": "NK-company1", "caption": "Sidorov Holding LLC", "schema": "Company",
     "properties": {"name": ["Sidorov Holding LLC"], "jurisdiction": ["ru"], "registrationNumber": ["1027700000000"],
                    "topics": ["sanction.linked"]},
     "datasets": ["us_ofac_sdn"], "target": False, "score": 0.74, "match": True},
    {"id": "NK-vessel1", "caption": "SIDOROV", "schema": "Vessel", "properties": {"topics": ["sanction"]},
     "datasets": ["us_ofac_sdn"], "target": True, "score": 0.5, "match": False},
]


def response(body):
    resp = mock.MagicMock()
    resp.__enter__.return_value.read.return_value = json.dumps(body).encode()
    return resp


def run(argv, env=None):
    out, err = io.StringIO(), io.StringIO()
    with mock.patch.dict(os.environ, env or {}, clear=True), redirect_stdout(out), redirect_stderr(err):
        code = opensanctions.main(argv)
    return code, out.getvalue(), err.getvalue()


class OpenSanctionsTest(unittest.TestCase):
    def test_entities(self):
        found = opensanctions.entities(RESULTS)
        self.assertEqual([(e["type"], e["confidence"]) for e in found],
                         [("person", "high"), ("organization", "medium"), ("other", "low")])
        person = found[0]["attrs"]
        self.assertEqual(person["countries"], ["ru", "cy"])
        self.assertTrue(person["sanctioned"])
        self.assertEqual(person["birth_date"], ["1961-02-03"])
        self.assertEqual(person["link"], "https://www.opensanctions.org/entities/NK-person1/")
        company = found[1]["attrs"]
        self.assertFalse(company["sanctioned"])
        self.assertEqual(company["registration_numbers"], ["1027700000000"])
        self.assertNotIn("birth_date", company)

    def test_missing_key_exits_3(self):
        code, out, err = run(["--name", "Ivan Sidorov"])
        self.assertEqual((code, out), (3, ""))
        self.assertIn("OPENSANCTIONS_API_KEY", err)

    def test_person_query(self):
        body = {"responses": {"q": {"status": 200, "results": RESULTS[:1], "total": {"value": 1}}}, "limit": 3}
        with mock.patch("urllib.request.urlopen", return_value=response(body)) as urlopen:
            code, out, _ = run(["--name", " Ivan Sidorov ", "--birth-date", "1961", "--country", "Russia",
                                "--limit", "3"], {"OPENSANCTIONS_API_KEY": "secret-key"})
        self.assertEqual(code, 0)
        req = urlopen.call_args[0][0]
        self.assertEqual(urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query), {"limit": ["3"]})
        self.assertEqual(req.get_header("Authorization"), "ApiKey secret-key")
        self.assertEqual(json.loads(req.data), {"queries": {"q": {"schema": "Person", "properties": {
            "name": ["Ivan Sidorov"], "birthDate": ["1961"], "country": ["Russia"]}}}})
        self.assertEqual(json.loads(out)["entities"][0]["value"], "Ivan Petrovich SIDOROV")

    def test_company_query(self):
        body = {"responses": {"q": {"status": 200, "results": []}}}
        with mock.patch("urllib.request.urlopen", return_value=response(body)) as urlopen:
            code, out, err = run(["--company", "Example Trading Ltd", "--limit", "99"], {"OPENSANCTIONS_API_KEY": "k"})
        self.assertEqual((code, json.loads(out)), (0, {"entities": []}))
        req = urlopen.call_args[0][0]
        self.assertIn("limit=25", req.full_url)
        self.assertEqual(json.loads(req.data)["queries"]["q"],
                         {"schema": "Organization", "properties": {"name": ["Example Trading Ltd"]}})
        self.assertIn("no match", err)

    def test_birth_date_needs_a_person(self):
        code, _, err = run(["--company", "Example Ltd", "--birth-date", "1990"], {"OPENSANCTIONS_API_KEY": "k"})
        self.assertEqual(code, 2)
        self.assertIn("--birth-date", err)

    def test_refused_key_exits_1(self):
        error = urllib.error.HTTPError(opensanctions.API, 401, "Unauthorized", {},
                                       io.BytesIO(b'{"detail": "Invalid API key."}'))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            code, _, err = run(["--name", "Ivan Sidorov"], {"OPENSANCTIONS_API_KEY": "bad"})
        self.assertEqual(code, 1)
        self.assertIn("refused the key", err)
        self.assertIn("Invalid API key.", err)

    def test_validation_error_detail_is_printed(self):
        detail = [{"loc": ["query", "limit"], "msg": "bad value"}]
        error = urllib.error.HTTPError(opensanctions.API, 422, "Unprocessable", {},
                                       io.BytesIO(json.dumps({"detail": detail}).encode()))
        with mock.patch("urllib.request.urlopen", side_effect=error):
            code, _, err = run(["--name", "Ivan Sidorov"], {"OPENSANCTIONS_API_KEY": "k"})
        self.assertEqual(code, 1)
        self.assertIn("bad value", err)

    def test_needs_exactly_one_name(self):
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as stop:
            opensanctions.main(["--name", "A B", "--company", "C"])
        self.assertEqual(stop.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
