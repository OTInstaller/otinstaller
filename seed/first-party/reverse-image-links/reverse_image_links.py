#!/usr/bin/env python3
"""Builds reverse image search links for an image URL: Google Lens, Bing, Yandex, TinEye and others.

Runs offline: it only builds the links, so you open them yourself. Prints {"entities": [...]} with one url
entity per search engine.
"""
import argparse
import json
import sys
import urllib.parse

ENGINES = [
    ("google-lens", "Google Lens", "https://lens.google.com/uploadbyurl?url={u}"),
    ("bing", "Bing Visual Search", "https://www.bing.com/images/search?view=detailv2&iss=sbi&form=SBIVSP&q=imgurl:{u}"),
    ("yandex", "Yandex Images", "https://yandex.com/images/search?rpt=imageview&url={u}"),
    ("tineye", "TinEye", "https://tineye.com/search?url={u}"),
    ("baidu", "Baidu Images", "https://graph.baidu.com/details?isfromtusoupc=1&tn=pc&carousel=0&image={u}"),
    ("saucenao", "SauceNAO", "https://saucenao.com/search.php?url={u}"),
    ("iqdb", "IQDB", "https://iqdb.org/?url={u}"),
]


def links(image_url, engines=None):
    parsed = urllib.parse.urlparse(image_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("give the full http(s) URL of the image")
    quoted = urllib.parse.quote(image_url, safe="")
    wanted = set(engines or [key for key, _, _ in ENGINES])
    return [
        {"type": "url", "value": template.format(u=quoted), "source": "reverse-image-links", "confidence": "high",
         "attrs": {"engine": key, "name": name, "image": image_url}}
        for key, name, template in ENGINES if key in wanted
    ]


def main(argv=None):
    parser = argparse.ArgumentParser(prog="reverse-image-links")
    parser.add_argument("--engines", help="comma-separated: " + ",".join(k for k, _, _ in ENGINES))
    parser.add_argument("url")
    args = parser.parse_args(argv)
    try:
        entities = links(args.url, [e.strip() for e in args.engines.split(",")] if args.engines else None)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    json.dump({"entities": entities}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
