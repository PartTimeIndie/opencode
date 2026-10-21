import unittest

from src.payments.tax_calculator import calculate_total


class TaxCalculatorTest(unittest.TestCase):
    def test_california_rate(self):
        self.assertEqual(calculate_total(100, "CA"), 107.5)

    def test_new_york_rate(self):
        self.assertEqual(calculate_total(100, "NY"), 108.5)

    def test_unknown_state_default_rate(self):
        self.assertEqual(calculate_total(100, "WA"), 105.0)


if __name__ == "__main__":
    unittest.main()
