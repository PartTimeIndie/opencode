import unittest

from src.url_tools import build_api_url


class UrlToolsTest(unittest.TestCase):
    def test_preserves_base_path(self):
        self.assertEqual(build_api_url("https://api.example.com/v1", "users", {"page": 2}), "https://api.example.com/v1/users?page=2")

    def test_normalizes_slashes(self):
        self.assertEqual(build_api_url("https://api.example.com/v1/", "/users", None), "https://api.example.com/v1/users")

    def test_encodes_query_spaces(self):
        self.assertEqual(build_api_url("https://api.example.com/v1", "search", {"q": "hello world"}), "https://api.example.com/v1/search?q=hello+world")


if __name__ == "__main__":
    unittest.main()
