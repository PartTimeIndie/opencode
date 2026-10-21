Fix the pricing loader.

Requirements:
- Load price rules from JSON text.
- Monetary values must be `Decimal`, not `float`.
- Environment variable `APP_CURRENCY` overrides the JSON currency.
- Reject duplicate object keys.
- Reject `NaN`, `Infinity`, and `-Infinity`.

Keep the patch minimal and use stdlib JSON hooks where appropriate.
