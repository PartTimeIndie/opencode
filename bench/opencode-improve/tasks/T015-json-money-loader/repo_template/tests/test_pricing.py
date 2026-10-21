import os
import unittest
from decimal import Decimal
from unittest import mock

from src.pricing import load_pricing


class PricingTest(unittest.TestCase):
    def test_prices_are_decimal(self):
        pricing = load_pricing('{"currency":"EUR","prices":{"basic":1.25}}')
        self.assertEqual(pricing["prices"]["basic"], Decimal("1.25"))

    def test_currency_override(self):
        with mock.patch.dict(os.environ, {"APP_CURRENCY": "USD"}, clear=True):
            self.assertEqual(load_pricing('{"currency":"EUR","prices":{}}')["currency"], "USD")


if __name__ == "__main__":
    unittest.main()
