#!/usr/bin/env python3
"""Parses a phone number offline: validity, formats, country, original carrier, line type and time zones.

Uses Google's libphonenumber metadata (the phonenumbers package). Prints {"entities": [...]}. Nothing is
contacted, so the carrier is the one the number range was assigned to, not the current one after porting.
"""
import argparse
import json
import sys

import phonenumbers
from phonenumbers import carrier, geocoder, timezone
from phonenumbers.phonenumberutil import NumberParseException

LINE_TYPES = {v: k.lower() for k, v in vars(phonenumbers.PhoneNumberType).items() if isinstance(v, int)}


def parse(number, region=None):
    try:
        n = phonenumbers.parse(number, (region or "").upper() or None)
    except NumberParseException as exc:
        raise ValueError(f"not a phone number: {exc}") from exc
    e164 = phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.E164)
    attrs = {
        "valid": phonenumbers.is_valid_number(n),
        "possible": phonenumbers.is_possible_number(n),
        "e164": e164,
        "international": phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.INTERNATIONAL),
        "national": phonenumbers.format_number(n, phonenumbers.PhoneNumberFormat.NATIONAL),
        "country_code": n.country_code,
        "region": phonenumbers.region_code_for_number(n),
        "location": geocoder.description_for_number(n, "en") or None,
        "carrier": carrier.name_for_number(n, "en") or None,
        "line_type": LINE_TYPES.get(phonenumbers.number_type(n), "unknown"),
        "time_zones": [tz for tz in timezone.time_zones_for_number(n) if tz != "Etc/Unknown"],
    }
    entities = [{"type": "phone", "value": e164, "source": "libphonenumber",
                 "confidence": "high" if attrs["valid"] else "low", "attrs": attrs}]
    if attrs["location"] or attrs["region"]:
        entities.append({"type": "location", "value": attrs["location"] or attrs["region"], "source": "libphonenumber",
                         "confidence": "low", "attrs": {"region": attrs["region"], "basis": "number range"}})
    return entities


def main(argv=None):
    parser = argparse.ArgumentParser(prog="phone-parse")
    parser.add_argument("--region", help="two-letter country for numbers without a + prefix, such as US or GB")
    parser.add_argument("phone")
    args = parser.parse_args(argv)
    try:
        entities = parse(args.phone, args.region)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 1
    json.dump({"entities": entities}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
