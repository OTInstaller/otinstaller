#!/usr/bin/env python3
"""Downloads an image or document and reads its metadata with ExifTool.

Prints {"entities": [...], "metadata": {...}}: a location entity for GPS coordinates, person entities for
author fields, and other entities for the camera, software and timestamps. The file is kept in /tmp only.
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request

MAX_BYTES = 25 * 1024 * 1024
USER_AGENT = "osintverse-exif-meta/0.1 (+https://otinstaller.com)"
PEOPLE = ["Artist", "Author", "Creator", "By-line", "OwnerName", "LastModifiedBy", "XPAuthor", "Copyright"]
DEVICE = ["Make", "Model", "LensModel", "SerialNumber", "BodySerialNumber", "Software", "CreatorTool", "Producer"]
TIMES = ["DateTimeOriginal", "CreateDate", "ModifyDate", "MetadataDate"]


def download(url, dest):
    if urllib.parse.urlparse(url).scheme not in ("http", "https"):
        raise ValueError("only http and https URLs are supported")
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    size = 0
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as out:
        while chunk := resp.read(65536):
            size += len(chunk)
            if size > MAX_BYTES:
                raise ValueError("the file is larger than 25 MB")
            out.write(chunk)


def exiftool(path):
    out = subprocess.run(["exiftool", "-json", "-n", "-G0", "-a", "-u", path], capture_output=True, text=True, timeout=60)
    if out.returncode not in (0, 1) or not out.stdout.strip():
        raise RuntimeError(out.stderr.strip() or "exiftool failed")
    meta = json.loads(out.stdout)[0]
    meta.pop("SourceFile", None)
    for key in list(meta):
        if key.startswith("System:") or key.startswith("ExifTool:"):
            del meta[key]
    return meta


def field(meta, name):
    for key, value in meta.items():
        if key.split(":", 1)[-1] == name and value not in ("", None):
            return value
    return None


def entities(url, meta):
    out = []
    lat, lon = field(meta, "GPSLatitude"), field(meta, "GPSLongitude")
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)) and (lat, lon) != (0, 0):
        out.append({"type": "location", "value": f"{lat:.6f},{lon:.6f}", "source": "exif", "confidence": "high",
                    "attrs": {"latitude": lat, "longitude": lon, "altitude": field(meta, "GPSAltitude"),
                              "map": f"https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"}})
    for name in PEOPLE:
        if value := field(meta, name):
            out.append({"type": "person", "value": str(value), "source": "exif", "confidence": "medium", "attrs": {"field": name}})
    device = {name: field(meta, name) for name in DEVICE if field(meta, name)}
    if device:
        label = " ".join(str(device[k]) for k in ("Make", "Model") if k in device) or str(next(iter(device.values())))
        out.append({"type": "other", "value": label, "source": "exif", "confidence": "high", "attrs": {"kind": "device", **device}})
    times = {name: field(meta, name) for name in TIMES if field(meta, name)}
    if times:
        out.append({"type": "other", "value": str(next(iter(times.values()))), "source": "exif", "confidence": "medium",
                    "attrs": {"kind": "timestamps", **times}})
    kind = "image" if str(field(meta, "MIMEType") or "").startswith("image/") else "document"
    out.insert(0, {"type": kind, "value": url, "source": "exif", "confidence": "high",
                   "attrs": {"mime_type": field(meta, "MIMEType"), "width": field(meta, "ImageWidth"), "height": field(meta, "ImageHeight")}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="exif-meta")
    parser.add_argument("url", help="URL of the image or document")
    args = parser.parse_args(argv)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "file")
        try:
            download(args.url, path)
            meta = exiftool(path)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
            print(f"could not read {args.url}: {exc}", file=sys.stderr)
            return 1
    json.dump({"entities": entities(args.url, meta), "metadata": meta}, sys.stdout, default=str)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
