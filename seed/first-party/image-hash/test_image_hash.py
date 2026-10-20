import io
import unittest

from PIL import Image

from image_hash import describe


def png(color, size=(64, 64), box=None):
    image = Image.new("RGB", size, color)
    if box:
        image.paste((0, 0, 0), box)
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return buf.getvalue()


class ImageHashTest(unittest.TestCase):
    def test_describe(self):
        entity, h = describe("https://example.com/a.png", png((255, 255, 255), box=(0, 0, 32, 32)))
        self.assertEqual(entity["type"], "image")
        self.assertEqual(entity["attrs"]["width"], 64)
        self.assertEqual(entity["attrs"]["format"], "PNG")
        self.assertEqual(len(entity["attrs"]["sha256"]), 64)
        for name in ("ahash", "phash", "dhash", "whash", "colorhash"):
            self.assertIn(name, entity["attrs"])

    def test_resized_copy_is_close(self):
        _, a = describe("a", png((255, 255, 255), box=(0, 0, 32, 32)))
        _, b = describe("b", png((255, 255, 255), size=(128, 128), box=(0, 0, 64, 64)))
        _, c = describe("c", png((255, 255, 255), box=(32, 32, 64, 64)))
        self.assertLessEqual(a["phash"] - b["phash"], 4)
        self.assertGreater(a["phash"] - c["phash"], 8)


if __name__ == "__main__":
    unittest.main()
