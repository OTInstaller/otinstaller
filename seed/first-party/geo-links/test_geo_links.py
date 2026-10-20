import unittest

from geo_links import SERVICES, entities, parse


class GeoLinksTest(unittest.TestCase):
    def test_decimal(self):
        self.assertEqual(parse("48.8584, 2.2945"), (48.8584, 2.2945))
        self.assertEqual(parse("-33.8568 151.2153"), (-33.8568, 151.2153))

    def test_dms(self):
        lat, lon = parse("48°51'30.1\"N 2°17'40.1\"W")
        self.assertAlmostEqual(lat, 48.858361, places=5)
        self.assertAlmostEqual(lon, -2.294472, places=5)

    def test_out_of_range(self):
        for bad in ["91,0", "0,181", "abc", "1,2,3"]:
            with self.assertRaises(ValueError):
                parse(bad)

    def test_entities(self):
        out = entities(48.8584, 2.2945)
        self.assertEqual(out[0]["type"], "location")
        self.assertEqual(len(out), 1 + len(SERVICES))
        self.assertIn("48.8584,2.2945", out[2]["value"])


if __name__ == "__main__":
    unittest.main()
