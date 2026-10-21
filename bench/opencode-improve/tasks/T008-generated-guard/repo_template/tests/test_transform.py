import unittest

from src.transform import expand_tokens


class TransformTest(unittest.TestCase):
    def test_expands_known_tokens(self):
        self.assertEqual(expand_tokens(["usr", "cfg", "svc"]), ["user", "config", "service"])

    def test_keeps_unknown_tokens(self):
        self.assertEqual(expand_tokens(["usr", "unknown"]), ["user", "unknown"])


if __name__ == "__main__":
    unittest.main()
