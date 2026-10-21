import unittest

from slugify import slugify


class SlugifyTest(unittest.TestCase):
    def test_basic_lowercase(self):
        self.assertEqual(slugify("Hello World"), "hello-world")

    def test_collapse_separators(self):
        self.assertEqual(slugify("Alpha -- Beta   Gamma"), "alpha-beta-gamma")

    def test_trim_edges(self):
        self.assertEqual(slugify("  !!Hello!!  "), "hello")

    def test_preserve_underscores(self):
        self.assertEqual(slugify("Save_file Now"), "save_file-now")

    def test_unicode_transliteration(self):
        self.assertEqual(slugify("Cafe Creme"), "cafe-creme")
        self.assertEqual(slugify("Cafe\u0301 Creme"), "cafe-creme")


if __name__ == "__main__":
    unittest.main()
