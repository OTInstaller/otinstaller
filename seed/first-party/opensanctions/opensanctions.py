#!/usr/bin/env python3
"""Screens a person's or a company's name against OpenSanctions: sanctions lists, politically exposed persons
(PEPs) and their relatives, criminal and other watch lists, gathered from hundreds of official sources.

Uses the /match API, which scores how well each listed entity fits the name and, when given, a birth date and a
country. Only OpenSanctions' data is read, so nobody is contacted. Needs OPENSANCTIONS_API_KEY; each run uses one
query credit. Prints {"entities": [...]}.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

KEY = "OPENSANCTIONS_API_KEY"
SOURCE = "opensanctions"
API = "https://api.opensanctions.org/match/default"
SITE = "https://www.opensanctions.org/entities/"
USER_AGENT = "osintverse-opensanctions/0.1 (+https://otinstaller.com)"
ORGANIZATIONS = {"Organization", "Company", "LegalEntity", "PublicBody"}
COUNTRIES = ("country", "nationality", "citizenship", "jurisdiction")


class APIError(Exception):
    """An error OpenSanctions answered with, carrying its own message."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def example(name=None, company=None, birth_date=None, country=None):
    """The entity to match: a Person for a name, an Organization (companies included) for a company."""
    props = {"name": [name or company]}
    if birth_date:
        props["birthDate"] = [birth_date]
    if country:
        props["country"] = [country]
    return {"schema": "Person" if name else "Organization", "properties": props}


def match(query, limit, key):
    """The candidates for one query, best first."""
    url = API + "?" + urllib.parse.urlencode({"limit": limit})
    req = urllib.request.Request(url, data=json.dumps({"queries": {"q": query}}).encode(), headers={
        "Authorization": f"ApiKey {key}", "Content-Type": "application/json", "Accept": "application/json",
        "User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            doc = json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode() or "{}").get("detail")
        except (OSError, ValueError, AttributeError):
            detail = None
        if not isinstance(detail, str):
            detail = json.dumps(detail) if detail else f"HTTP {exc.code} {exc.reason}"
        raise APIError(exc.code, detail) from exc
    answer = (doc.get("responses") or {}).get("q") or {}
    if answer.get("status", 200) != 200:
        raise APIError(answer["status"], answer.get("detail") or f"query answered {answer['status']}")
    return answer.get("results") or []


def entities(results):
    """Maps match results to person, organization or other entities, with what each is listed for."""
    out = []
    for r in results:
        props, schema, score = r.get("properties") or {}, r.get("schema"), r.get("score") or 0
        countries = []
        for field in COUNTRIES:
            countries += [c for c in props.get(field) or [] if c not in countries]
        topics = props.get("topics") or []
        attrs = {"id": r.get("id"), "schema": schema, "score": round(score, 3), "match": r.get("match"),
                 "topics": topics, "sanctioned": "sanction" in topics, "target": r.get("target"),
                 "datasets": (r.get("datasets") or [])[:20], "countries": countries,
                 "aliases": (props.get("alias") or [])[:10], "positions": (props.get("position") or [])[:5],
                 "programs": props.get("programId") or [], "first_seen": r.get("first_seen"),
                 "last_seen": r.get("last_seen"), "last_change": r.get("last_change"), "link": f"{SITE}{r.get('id')}/"}
        if schema == "Person":
            kind = "person"
            attrs["birth_date"] = props.get("birthDate") or []
        elif schema in ORGANIZATIONS:
            kind = "organization"
            attrs["registration_numbers"] = (props.get("registrationNumber") or [])[:5]
            attrs["incorporation_date"] = props.get("incorporationDate") or []
        else:
            kind = "other"
        confidence = "high" if score >= 0.9 else "medium" if r.get("match") else "low"
        out.append({"type": kind, "value": r.get("caption") or (props.get("name") or [r.get("id")])[0],
                    "source": SOURCE, "confidence": confidence, "attrs": attrs})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="opensanctions", description="Screen a name against OpenSanctions.")
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--name", help="a person's full name")
    target.add_argument("--company", help="a company or organisation name")
    parser.add_argument("--birth-date", help="the person's date or year of birth, such as 1952 or 1952-10-07")
    parser.add_argument("--country", help="a country linked to the person or company, as a name or code")
    parser.add_argument("--limit", type=int, default=5, help="most matches to return (1-25)")
    args = parser.parse_args(argv)
    if args.company and args.birth_date:
        print("--birth-date applies to a person (--name), not a company", file=sys.stderr)
        return 2
    name = (args.name or args.company).strip()
    if not name:
        print("the name is empty", file=sys.stderr)
        return 2
    key = os.environ.get(KEY, "").strip()
    if not key:
        print(f"{KEY} is not set: add it with `ot keys set {KEY}`", file=sys.stderr)
        return 3
    country = (args.country or "").strip() or None
    if args.name:
        query = example(name=name, birth_date=(args.birth_date or "").strip() or None, country=country)
    else:
        query = example(company=name, country=country)
    try:
        results = match(query, max(1, min(args.limit, 25)), key)
    except APIError as exc:
        if exc.status in (401, 403):
            print(f"OpenSanctions refused the key in {KEY}: {exc}", file=sys.stderr)
        else:
            print(f"OpenSanctions: {exc}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as exc:
        print(f"OpenSanctions: {exc}", file=sys.stderr)
        return 1
    if not results:
        print(f"OpenSanctions has no match for {name}", file=sys.stderr)
    json.dump({"entities": entities(results)}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
