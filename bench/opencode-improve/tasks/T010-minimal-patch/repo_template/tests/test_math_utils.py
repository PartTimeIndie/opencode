import unittest

from src.math_utils import clamp


class MathUtilsTest(unittest.TestCase):
    def test_below_minimum(self):
        self.assertEqual(clamp(-5, 0, 10), 0)

    def test_above_maximum(self):
        self.assertEqual(clamp(15, 0, 10), 10)

    def test_inside_range(self):
        self.assertEqual(clamp(5, 0, 10), 5)


if __name__ == "__main__":
    unittest.main()
