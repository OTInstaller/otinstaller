#!/usr/bin/env python3
"""Turns coordinates into links for checking a place: maps, satellite and street imagery, and nearby photos.

Accepts "lat,lon" in decimal degrees or degrees-minutes-seconds (48°51'30.1"N 2°17'40.1"E). Runs offline:
prints {"entities": [...]} with the normalised location and one url entity per service.
"""
import argparse
import json
import re
import sys

SERVICES = [
    ("openstreetmap", "OpenStreetMap", "https://www.openstreetmap.org/?mlat={lat}&mlon={lon}#map=17/{lat}/{lon}"),
    ("google-maps", "Google Maps", "https://www.google.com/maps/search/?api=1&query={lat},{lon}"),
    ("google-earth", "Google Earth", "https://earth.google.com/web/@{lat},{lon},500a,1000d,35y,0h,0t,0r"),
    ("street-view", "Google Street View", "https://www.google.com/maps/@?api=1&map_action=pano&viewpoint={lat},{lon}"),
    ("bing-maps", "Bing Maps (aerial)", "https://www.bing.com/maps?cp={lat}~{lon}&lvl=18&style=a"),
    ("apple-maps", "Apple Maps", "https://maps.apple.com/?ll={lat},{lon}&q=Location&t=k"),
    ("mapillary", "Mapillary street photos", "https://www.mapillary.com/app/?lat={lat}&lng={lon}&z=17"),
    ("sentinel", "Copernicus Browser (satellite history)", "https://browser.dataspace.copernicus.eu/?zoom=15&lat={lat}&lng={lon}"),
    ("wikimapia", "Wikimapia", "https://wikimapia.org/#lat={lat}&lon={lon}&z=17"),
    ("overpass", "Overpass Turbo (nearby features)", "https://overpass-turbo.eu/?Q=nwr(around:200,{lat},{lon});out;&C={lat};{lon};17&R"),
    ("suncalc", "SunCalc (shadows by time)", "https://www.suncalc.org/#/{lat},{lon},17/null/null/null/null"),
]

DMS_RE = re.compile(r"""(\d+(?:\.\d+)?)\s*[°d\s]\s*(?:(\d+(?:\.\d+)?)\s*['′m\s]\s*)?(?:(\d+(?:\.\d+)?)\s*["″s]?\s*)?([NSEW])""", re.I)


def parse(text):
    text = text.strip()
    dms = DMS_RE.findall(text)
    if len(dms) == 2:
        values = {}
        for deg, minutes, seconds, hemi in dms:
            v = float(deg) + float(minutes or 0) / 60 + float(seconds or 0) / 3600
            if hemi.upper() in "SW":
                v = -v
            values["lat" if hemi.upper() in "NS" else "lon"] = v
        if len(values) != 2:
            raise ValueError("give one latitude (N/S) and one longitude (E/W)")
        lat, lon = values["lat"], values["lon"]
    else:
        parts = re.split(r"[,\s;]+", text)
        if len(parts) != 2:
            raise ValueError('give coordinates as "lat,lon", for example "48.8584,2.2945"')
        try:
            lat, lon = float(parts[0]), float(parts[1])
        except ValueError as exc:
            raise ValueError('give coordinates as "lat,lon", for example "48.8584,2.2945"') from exc
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError("latitude must be within ±90 and longitude within ±180")
    return round(lat, 6), round(lon, 6)


def entities(lat, lon):
    out = [{"type": "location", "value": f"{lat},{lon}", "source": "geo-links", "confidence": "high",
            "attrs": {"latitude": lat, "longitude": lon}}]
    for key, name, template in SERVICES:
        out.append({"type": "url", "value": template.format(lat=lat, lon=lon), "source": "geo-links",
                    "confidence": "high", "attrs": {"service": key, "name": name}})
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="geo-links")
    parser.add_argument("coordinates")
    args = parser.parse_args(argv)
    try:
        lat, lon = parse(args.coordinates)
    except ValueError as exc:
        print(exc, file=sys.stderr)
        return 2
    json.dump({"entities": entities(lat, lon)}, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
