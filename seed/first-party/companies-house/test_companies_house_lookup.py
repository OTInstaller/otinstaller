import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

from companies_house import AuthError, NotFound

import companies_house_lookup

PROFILE = {"company_name": "TESCO PLC", "company_number": "00445790", "company_status": "active", "type": "plc",
           "date_of_creation": "1947-11-27", "sic_codes": ["47110"],
           "registered_office_address": {"address_line_1": "Tesco House", "address_line_2": "Shire Park",
                                         "locality": "Welwyn Garden City", "postal_code": "AL7 1GA"}}
OFFICERS = {"items": [{"name": "DOE, Jane", "officer_role": "director", "appointed_on": "2020-01-01",
                       "date_of_birth": {"month": 4, "year": 1970}, "nationality": "British",
                       "address": {"locality": "Welwyn Garden City"}},
                      {"name": "EXAMPLE SECRETARIES LIMITED", "officer_role": "corporate-secretary"}]}
PSC = {"items": [{"name": "Example Holdings Ltd", "kind": "corporate-entity-person-with-significant-control",
                  "natures_of_control": ["ownership-of-shares-75-to-100-percent"]}]}
SEARCH = {"items": [{"title": "TESCO PLC", "company_number": "00445790", "company_status": "active",
                     "address_snippet": "Tesco House, Shire Park, Welwyn Garden City, AL7 1GA"}, {"title": None}]}


class CompaniesHouseTest(unittest.TestCase):
    def test_company_entities(self):
        found = companies_house_lookup.company_entities("00445790", PROFILE, OFFICERS, PSC)
        self.assertEqual([e["type"] for e in found], ["organization", "location", "person", "organization", "organization"])
        self.assertEqual(found[0]["attrs"]["link"],
                         "https://find-and-update.company-information.service.gov.uk/company/00445790")
        self.assertEqual(found[1]["value"], "Tesco House, Shire Park, Welwyn Garden City, AL7 1GA")
        self.assertEqual(found[2]["attrs"]["birth_month"], "1970-04")
        self.assertEqual(found[4]["attrs"]["relation"], "person with significant control")

    def test_search_entities(self):
        found = companies_house_lookup.search_entities(SEARCH)
        self.assertEqual([e["value"] for e in found], ["TESCO PLC"])
        self.assertEqual(found[0]["confidence"], "medium")

    def test_missing_key_exits_3(self):
        with mock.patch.dict(os.environ, {}, clear=True), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(companies_house_lookup.main(["--company", "tesco"]), 3)
        self.assertIn("COMPANIES_HOUSE_API_KEY", err.getvalue())

    def test_number_reads_officers_and_psc(self):
        client, out = mock.Mock(), io.StringIO()
        client.company.return_value, client.officers.return_value, client.psc.return_value = PROFILE, OFFICERS, PSC
        with mock.patch.dict(os.environ, {"COMPANIES_HOUSE_API_KEY": "k"}), \
                mock.patch.object(companies_house_lookup, "CompaniesHouse", return_value=client), redirect_stdout(out):
            self.assertEqual(companies_house_lookup.main(["--number", "445790"]), 0)
        client.officers.assert_called_once_with("00445790", items_per_page=100)
        self.assertEqual(len(json.loads(out.getvalue())["entities"]), 5)

    def test_unknown_number_prints_nothing(self):
        client, out = mock.Mock(), io.StringIO()
        client.company.side_effect = NotFound("not found", 404)
        with mock.patch.dict(os.environ, {"COMPANIES_HOUSE_API_KEY": "k"}), \
                mock.patch.object(companies_house_lookup, "CompaniesHouse", return_value=client), \
                redirect_stdout(out), redirect_stderr(io.StringIO()):
            self.assertEqual(companies_house_lookup.main(["--number", "99999999"]), 0)
        self.assertEqual(json.loads(out.getvalue()), {"entities": []})

    def test_refused_key_exits_1(self):
        client = mock.Mock()
        client.search.side_effect = AuthError("bad key", 401)
        with mock.patch.dict(os.environ, {"COMPANIES_HOUSE_API_KEY": "k"}), \
                mock.patch.object(companies_house_lookup, "CompaniesHouse", return_value=client), \
                redirect_stderr(io.StringIO()) as err:
            self.assertEqual(companies_house_lookup.main(["--company", "tesco"]), 1)
        self.assertIn("HTTP 401", err.getvalue())


if __name__ == "__main__":
    unittest.main()
