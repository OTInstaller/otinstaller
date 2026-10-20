import unittest

from reverse_image_links import ENGINES, links


class ReverseImageLinksTest(unittest.TestCase):
    def test_all_engines(self):
        out = links("https://example.com/photos/a b.jpg?size=large&x=1")
        self.assertEqual(len(out), len(ENGINES))
        tineye = next(e for e in out if e["attrs"]["engine"] == "tineye")
        self.assertEqual(tineye["value"], "https://tineye.com/search?url=https%3A%2F%2Fexample.com%2Fphotos%2Fa%20b.jpg%3Fsize%3Dlarge%26x%3D1")

    def test_some_engines(self):
        self.assertEqual([e["attrs"]["engine"] for e in links("https://example.com/a.jpg", ["yandex", "bing"])], ["bing", "yandex"])

    def test_rejects_non_urls(self):
        with self.assertRaises(ValueError):
            links("/home/me/a.jpg")


if __name__ == "__main__":
    unittest.main()
