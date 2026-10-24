import io
import json
import os
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest import mock

import edgar
import httpx

import sec_edgar

ROWS = [{"cik": 320193, "ticker": "AAPL", "company": "Apple Inc.", "score": 100.0},
        {"cik": 1418121, "ticker": "APLE", "company": "Apple Hospitality REIT, Inc.", "score": 72.4}]
ADDRESS = SimpleNamespace(street1="ONE APPLE PARK WAY", street2="", city="CUPERTINO", state_or_country="CA",
                          state_or_country_desc="CA", zipcode="95014")
FILING = SimpleNamespace(form="10-K", filing_date="2026-10-31", accession_no="0000320193-26-000105",
                         homepage_url="https://www.sec.gov/Archives/edgar/data/320193/000032019326000105/0000320193-26-000105-index.html")


class FakeCompany:
    name, cik, tickers, sic, industry, fiscal_year_end = "Apple Inc.", 320193, ["AAPL"], "3571", "Electronic Computers", "0927"
    data = SimpleNamespace(state_of_incorporation="CA", entity_type="operating")

    def get_exchanges(self):
        return ["Nasdaq"]

    def business_address(self):
        return ADDRESS

    def mailing_address(self):
        return ADDRESS

    def get_filings(self):
        return mock.Mock(head=mock.Mock(return_value=[FILING]))


def search(rows):
    frame = mock.Mock()
    frame.to_dict.return_value = rows
    return SimpleNamespace(empty=not rows, results=frame)


class SecEdgarTest(unittest.TestCase):
    def test_lookup(self):
        with mock.patch.object(edgar, "find_company", return_value=search(ROWS)) as find, \
                mock.patch.object(edgar, "Company", return_value=FakeCompany()) as company:
            found = sec_edgar.lookup("apple", 5, 10)
        find.assert_called_once_with("apple", top_n=5)
        company.assert_called_once_with(320193)
        self.assertEqual([e["type"] for e in found], ["organization", "location", "document", "organization"])
        self.assertEqual(found[0]["attrs"]["exchanges"], ["Nasdaq"])
        self.assertEqual(found[1]["value"], "ONE APPLE PARK WAY, CUPERTINO, CA, 95014")
        self.assertEqual(found[2]["value"], "10-K 2026-10-31")
        self.assertEqual(found[3]["confidence"], "low")
        self.assertEqual(found[3]["attrs"]["link"], "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1418121")

    def test_no_match(self):
        with mock.patch.object(edgar, "find_company", return_value=search([])):
            self.assertEqual(sec_edgar.lookup("zzzz", 5, 10), [])

    def test_missing_identity_exits_3(self):
        with mock.patch.dict(os.environ, {}, clear=True), redirect_stderr(io.StringIO()) as err:
            self.assertEqual(sec_edgar.main(["apple"]), 3)
        self.assertIn("EDGAR_IDENTITY", err.getvalue())

    def test_prints_entities(self):
        out = io.StringIO()
        with mock.patch.dict(os.environ, {"EDGAR_IDENTITY": "Jane Doe jane@example.com"}), \
                mock.patch.object(edgar, "find_company", return_value=search(ROWS[:1])), \
                mock.patch.object(edgar, "Company", return_value=FakeCompany()), redirect_stdout(out):
            self.assertEqual(sec_edgar.main(["apple", "--filings", "1"]), 0)
        self.assertEqual(json.loads(out.getvalue())["entities"][0]["value"], "Apple Inc.")

    def test_http_error_exits_1(self):
        with mock.patch.dict(os.environ, {"EDGAR_IDENTITY": "Jane Doe jane@example.com"}), \
                mock.patch.object(edgar, "find_company", side_effect=httpx.ConnectError("down")), \
                redirect_stderr(io.StringIO()) as err:
            self.assertEqual(sec_edgar.main(["apple"]), 1)
        self.assertIn("SEC EDGAR", err.getvalue())


if __name__ == "__main__":
    unittest.main()
