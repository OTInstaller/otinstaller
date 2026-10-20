#!/usr/bin/env python3
"""Generates likely usernames from a person's name, to feed into username search tools.

Prints {"entities": [...]} with one username entity per candidate. Runs offline.
"""
import argparse
import json
import re
import sys
import unicodedata

SEPARATORS = ["", ".", "_", "-"]


def ascii_words(name):
    """Lowercase ASCII words of a name: "Zoë O'Neil-Smith" -> ["zoe", "oneil", "smith"]."""
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    plain = plain.replace("'", "").replace("’", "")
    return [w for w in re.split(r"[^a-z0-9]+", plain.lower()) if w]


def permutations(name, extra=None, limit=200):
    words = ascii_words(name)
    if not words:
        return []
    first, last = words[0], words[-1]
    middle = words[1:-1]
    out = []

    def add(candidate, pattern):
        if 3 <= len(candidate) <= 30 and candidate not in seen:
            seen.add(candidate)
            out.append((candidate, pattern))

    seen = set()
    add("".join(words), "full name")
    if len(words) > 1:
        for sep in SEPARATORS:
            add(first + sep + last, "first{sep}last")
            add(last + sep + first, "last{sep}first")
            add(first[0] + sep + last, "f{sep}last")
            add(first + sep + last[0], "first{sep}l")
            add(last + sep + first[0], "last{sep}f")
            if middle:
                add(first + sep + "".join(m[0] for m in middle) + sep + last, "first{sep}m{sep}last")
        add(first[0] + "".join(m[0] for m in middle) + last[0], "initials")
    add(first, "first")
    add(last, "last")
    if extra:
        # Years, numbers or nicknames people often append.
        for token in ascii_words(extra):
            for base, pattern in list(out[:12]):
                add(base + token, pattern + "+extra")
                add(base + "_" + token, pattern + "_extra")
    return out[:limit]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="username-permutations")
    parser.add_argument("--extra", help="a year, number or nickname to append")
    parser.add_argument("--limit", type=int, default=200)
    parser.add_argument("name")
    args = parser.parse_args(argv)
    found = permutations(args.name, args.extra, args.limit)
    entities = [
        {"type": "username", "value": value, "source": "username-permutations", "confidence": "low",
         "attrs": {"pattern": pattern.replace("{sep}", "")}}
        for value, pattern in found
    ]
    json.dump({"entities": entities}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
