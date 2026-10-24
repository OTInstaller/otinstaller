#!/usr/bin/env python3
"""Searches the UK's Companies House register by company name, or reads one company by its number: registered name,
number, status, type, incorporation date and office address, and for a company number its officers (directors and
secretaries) and the people with significant control over it.

Uses Registrum's companies-house client for the free Companies House public data API. Only the public register is
read, so the company is not contacted. Needs COMPANIES_HOUSE_API_KEY, free from the Companies House developer hub.
Prints {"entities": [...]}.
"""
import argparse
import json
import os
import sys

import httpx
from companies_house import APIError, CompaniesHouse, NotFound

KEY = "COMPANIES_HOUSE_API_KEY"
SOURCE = "companies-house"
SITE = "https://find-and-update.company-information.service.gov.uk/company/"


def address(a):
    parts = [(a or {}).get(k) for k in ("premises", "address_line_1", "address_line_2", "locality", "region",
                                         "postal_code", "country")]
    return ", ".join(p for p in parts if p) or None


def birth_month(dob):
    return f"{dob['year']:04d}-{dob['month']:02d}" if dob and dob.get("year") and dob.get("month") else None


def company_entity(c, confidence):
    number = c.get("company_number")
    return {"type": "organization", "value": c.get("title") or c.get("company_name"), "source": SOURCE,
            "confidence": confidence, "attrs": {
                "company_number": number, "status": c.get("company_status"),
                "company_type": c.get("company_type") or c.get("type"), "incorporated": c.get("date_of_creation"),
                "dissolved": c.get("date_of_cessation"),
                "address": c.get("address_snippet") or address(c.get("registered_office_address")),
                "sic_codes": c.get("sic_codes") or [], "link": SITE + number if number else None}}


def person_entity(p, number, relation):
    corporate = any(word in (p.get("kind") or p.get("officer_role") or "") for word in ("corporate", "legal-person"))
    return {"type": "organization" if corporate else "person", "value": p["name"], "source": SOURCE,
            "confidence": "high", "attrs": {
                "relation": relation, "role": p.get("officer_role"), "kind": p.get("kind"),
                "natures_of_control": p.get("natures_of_control") or [], "appointed": p.get("appointed_on"),
                "notified": p.get("notified_on"), "resigned": p.get("resigned_on"), "ceased": p.get("ceased_on"),
                "occupation": p.get("occupation"), "nationality": p.get("nationality"),
                "country_of_residence": p.get("country_of_residence"), "birth_month": birth_month(p.get("date_of_birth")),
                "address": address(p.get("address")), "company_number": number}}


def search_entities(result):
    return [company_entity(c, "medium") for c in result.get("items") or [] if c.get("title")]


def company_entities(number, profile, officers, pscs):
    out = [company_entity(profile, "high")]
    office = address(profile.get("registered_office_address"))
    if office:
        out.append({"type": "location", "value": office, "source": SOURCE, "confidence": "high",
                    "attrs": {"role": "registered office", "company_number": number}})
    out += [person_entity(o, number, "officer") for o in officers.get("items") or [] if o.get("name")]
    out += [person_entity(p, number, "person with significant control") for p in pscs.get("items") or [] if p.get("name")]
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="companies-house", description="Look a company up in Companies House.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--company", help="company name to search for")
    target.add_argument("--number", help="company number, such as 00445790")
    parser.add_argument("--limit", type=int, default=20, help="most companies a name search returns")
    args = parser.parse_args(argv)
    key = os.environ.get(KEY, "").strip()
    if not key:
        print(f"{KEY} is not set: add it with `ot keys set {KEY}`", file=sys.stderr)
        return 3
    client = CompaniesHouse(key, max_wait=60)
    try:
        if args.number:
            number = args.number.strip().upper()
            profile = client.company(number)
            number = profile.get("company_number") or number
            found = company_entities(number, profile, client.officers(number, items_per_page=100),
                                     client.psc(number, items_per_page=100))
        else:
            found = search_entities(client.search(args.company.strip(), items_per_page=max(1, min(args.limit, 100))))
    except NotFound:
        print(f"Companies House has no company numbered {args.number}", file=sys.stderr)
        found = []
    except APIError as exc:
        print(f"Companies House: {'HTTP ' + str(exc.status) + ': ' if exc.status else ''}{exc}", file=sys.stderr)
        return 1
    except httpx.HTTPError as exc:
        print(f"Companies House: {exc}", file=sys.stderr)
        return 1
    json.dump({"entities": found}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
