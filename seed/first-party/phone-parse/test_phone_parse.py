import unittest

from phone_parse import parse


class PhoneParseTest(unittest.TestCase):
    def test_international(self):
        phone = parse("+44 20 7946 0958")[0]
        self.assertEqual(phone["value"], "+442079460958")
        self.assertEqual(phone["attrs"]["region"], "GB")
        self.assertEqual(phone["attrs"]["country_code"], 44)
        self.assertIn("Europe/London", phone["attrs"]["time_zones"])

    def test_region_hint(self):
        phone = parse("(201) 555-0123", region="us")[0]
        self.assertEqual(phone["value"], "+12015550123")
        self.assertEqual(phone["attrs"]["region"], "US")

    def test_not_a_number(self):
        with self.assertRaises(ValueError):
            parse("hello")


if __name__ == "__main__":
    unittest.main()
