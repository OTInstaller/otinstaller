#!/usr/bin/env python3
"""Computes perceptual hashes of an image, to find copies and near-duplicates across sites.

Downloads the image to memory and prints {"entities": [...]} with one image entity carrying the
average, perceptual, difference, wavelet and colour hashes plus a SHA-256 of the exact bytes.
With --compare, also reports how far a second image is from the first (0 means the same picture).
"""
import argparse
import hashlib
import io
import json
import sys
import urllib.parse
import urllib.request

import imagehash
from PIL import Image

MAX_BYTES = 25 * 1024 * 1024
USER_AGENT = "osintverse-image-hash/0.1 (+https://otinstaller.com)"
HASHES = {"ahash": imagehash.average_hash, "phash": imagehash.phash, "dhash": imagehash.dhash,
          "whash": imagehash.whash, "colorhash": imagehash.colorhash}


def download(url):
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        raise ValueError("only http and https URLs are supported")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("the image is larger than 25 MB")
    return data


def hashes(data):
    image = Image.open(io.BytesIO(data))
    image.load()
    out = {name: fn(image) for name, fn in HASHES.items()}
    return image, out


def describe(url, data):
    image, h = hashes(data)
    attrs = {name: str(v) for name, v in h.items()}
    attrs.update(sha256=hashlib.sha256(data).hexdigest(), width=image.width, height=image.height, format=image.format)
    return {"type": "image", "value": url, "source": "imagehash", "confidence": "high", "attrs": attrs}, h


def main(argv=None):
    parser = argparse.ArgumentParser(prog="image-hash")
    parser.add_argument("--compare", help="URL of a second image to compare with")
    parser.add_argument("url")
    args = parser.parse_args(argv)
    try:
        first, h1 = describe(args.url, download(args.url))
        entities = [first]
        if args.compare:
            second, h2 = describe(args.compare, download(args.compare))
            distances = {name: h1[name] - h2[name] for name in ("ahash", "phash", "dhash", "whash")}
            second["attrs"]["distance"] = distances
            second["attrs"]["likely_same_picture"] = distances["phash"] <= 8
            entities.append(second)
    except (OSError, ValueError) as exc:
        print(f"could not hash the image: {exc}", file=sys.stderr)
        return 1
    json.dump({"entities": entities}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
