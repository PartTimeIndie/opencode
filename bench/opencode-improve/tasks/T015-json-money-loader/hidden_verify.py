import os
import sys
from decimal import Decimal
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(sys.argv[1])))

from src.pricing import load_pricing


pricing = load_pricing('{"currency":"EUR","prices":{"a":0.1,"b":0.2,"c":0.3}}')
if pricing["prices"]["a"] + pricing["prices"]["b"] != Decimal("0.3"):
    raise AssertionError("prices lost Decimal precision")

with mock.patch.dict(os.environ, {"APP_CURRENCY": "USD"}, clear=True):
    if load_pricing('{"currency":"EUR","prices":{"a":1.25}}')["currency"] != "USD":
        raise AssertionError("APP_CURRENCY did not override currency")

for text in ['{"currency":"EUR","currency":"USD","prices":{}}', '{"currency":"EUR","prices":{"a":NaN}}', '{"currency":"EUR","prices":{"a":Infinity}}']:
    try:
        load_pricing(text)
    except ValueError:
        pass
    else:
        raise AssertionError(f"invalid JSON was accepted: {text}")

print("hidden pricing checks passed")
