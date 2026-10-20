import unittest

from username_permutations import ascii_words, permutations


class UsernamePermutationsTest(unittest.TestCase):
    def test_ascii_words(self):
        self.assertEqual(ascii_words("Zoë O'Neil-Smith"), ["zoe", "oneil", "smith"])

    def test_common_patterns(self):
        values = [v for v, _ in permutations("Ada Lovelace")]
        for want in ["adalovelace", "ada.lovelace", "ada_lovelace", "alovelace", "lovelace.ada", "adal", "ada"]:
            self.assertIn(want, values)
        self.assertEqual(len(values), len(set(values)))

    def test_extra_and_limit(self):
        values = [v for v, _ in permutations("Ada Lovelace", extra="1815")]
        self.assertIn("adalovelace1815", values)
        self.assertIn("ada.lovelace_1815", values)
        self.assertEqual(len(permutations("Ada Lovelace", limit=5)), 5)

    def test_empty_name(self):
        self.assertEqual(permutations("!!!"), [])


if __name__ == "__main__":
    unittest.main()
