#!/usr/bin/env python3
"""Finds a US-listed or SEC-registered company in EDGAR by name or ticker: its CIK, tickers and exchanges, industry,
state of incorporation, fiscal year end and addresses, and its latest filings with links.

Uses the edgartools library for the SEC's free EDGAR data. Only the SEC's public data is read, so the company is not
contacted. The SEC asks every client to say who it is, so EDGAR_IDENTITY must hold your name and email address.
Prints {"entities": [...]}.
"""
import argparse
import json
import os
import sys

import edgar
import httpx

KEY = "EDGAR_IDENTITY"
SOURCE = "sec-edgar"
BROWSE = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={}"


def address_text(a):
    if a is None:
        return None
    parts = [a.street1, a.street2, a.city, a.state_or_country_desc or a.state_or_country, a.zipcode]
    return ", ".join(p for p in parts if p) or None


def match_entities(rows):
    """Search matches other than the one looked up in full: (cik, ticker, company, score) rows."""
    return [{"type": "organization", "value": r["company"], "source": SOURCE,
             "confidence": "medium" if r.get("score", 0) >= 90 else "low",
             "attrs": {"cik": int(r["cik"]), "ticker": r.get("ticker") or None, "match_score": round(r.get("score", 0)),
                       "link": BROWSE.format(int(r["cik"]))}} for r in rows]


def company_entities(company, filings):
    """The company itself, its addresses and its latest filings."""
    data = company.data
    business, mailing = address_text(company.business_address()), address_text(company.mailing_address())
    out = [{"type": "organization", "value": company.name, "source": SOURCE, "confidence": "high", "attrs": {
        "cik": company.cik, "tickers": list(company.tickers or []), "exchanges": list(company.get_exchanges() or []),
        "sic": company.sic, "industry": company.industry, "fiscal_year_end": company.fiscal_year_end,
        "state_of_incorporation": getattr(data, "state_of_incorporation", None) or None,
        "entity_type": getattr(data, "entity_type", None) or None, "business_address": business,
        "mailing_address": mailing, "link": BROWSE.format(company.cik)}}]
    for role, place in (("business address", business), ("mailing address", mailing)):
        if place and not any(e["value"] == place for e in out[1:]):
            out.append({"type": "location", "value": place, "source": SOURCE, "confidence": "high",
                        "attrs": {"role": role, "cik": company.cik}})
    for f in filings:
        out.append({"type": "document", "value": f"{f.form} {f.filing_date}", "source": SOURCE, "confidence": "high",
                    "attrs": {"form": f.form, "filed": str(f.filing_date), "accession_no": f.accession_no,
                              "link": f.homepage_url, "cik": company.cik}})
    return out


def lookup(query, limit, filings):
    """Finds the company and returns its entities, plus the other matches; [] when nothing matches."""
    results = edgar.find_company(query, top_n=limit)
    rows = results.results.to_dict("records") if not results.empty else []
    if not rows:
        return []
    company = edgar.Company(int(rows[0]["cik"]))
    latest = list(company.get_filings().head(filings)) if filings else []
    return company_entities(company, latest) + match_entities(rows[1:])


def main(argv=None):
    parser = argparse.ArgumentParser(prog="sec-edgar", description="Find a company in the SEC's EDGAR filings.")
    parser.add_argument("company", help="company name or ticker")
    parser.add_argument("--limit", type=int, default=5, help="how many matching companies to list")
    parser.add_argument("--filings", type=int, default=10, help="how many of the latest filings to list")
    args = parser.parse_args(argv)
    if not os.environ.get(KEY, "").strip():
        print(f"{KEY} is not set: add your name and email address with `ot keys set {KEY}`; the SEC asks every "
              "client for them", file=sys.stderr)
        return 3
    try:
        found = lookup(args.company.strip(), max(1, min(args.limit, 25)), max(0, min(args.filings, 100)))
    except httpx.HTTPError as exc:
        print(f"SEC EDGAR: {exc}", file=sys.stderr)
        return 1
    if not found:
        print(f"EDGAR has no company matching {args.company!r}", file=sys.stderr)
    json.dump({"entities": found}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
