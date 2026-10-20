import unittest

from exif_meta import entities

META = {
    "File:MIMEType": "image/jpeg",
    "File:ImageWidth": 4032,
    "File:ImageHeight": 3024,
    "EXIF:Make": "Apple",
    "EXIF:Model": "iPhone 12",
    "EXIF:Software": "16.1",
    "EXIF:Artist": "",
    "EXIF:DateTimeOriginal": "2023:06:01 12:00:00",
    "EXIF:GPSLatitude": 48.858370,
    "EXIF:GPSLongitude": 2.294481,
    "XMP:Creator": "Example Photographer",
}


class ExifMetaTest(unittest.TestCase):
    def test_entities(self):
        out = entities("https://example.com/a.jpg", META)
        by_type = {}
        for e in out:
            by_type.setdefault(e["type"], []).append(e)
        self.assertEqual(by_type["image"][0]["attrs"]["width"], 4032)
        self.assertEqual(by_type["location"][0]["value"], "48.858370,2.294481")
        # Empty fields are skipped.
        self.assertEqual([p["value"] for p in by_type["person"]], ["Example Photographer"])
        device = next(e for e in by_type["other"] if e["attrs"]["kind"] == "device")
        self.assertEqual(device["value"], "Apple iPhone 12")

    def test_no_gps(self):
        out = entities("https://example.com/a.pdf", {"File:MIMEType": "application/pdf", "PDF:Producer": "Word"})
        self.assertEqual(out[0]["type"], "document")
        self.assertFalse(any(e["type"] == "location" for e in out))


if __name__ == "__main__":
    unittest.main()
