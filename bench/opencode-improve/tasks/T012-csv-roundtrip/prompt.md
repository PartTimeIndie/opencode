Fix the CSV table helpers.

Requirements:
- `write_rows(rows, headers)` returns CSV text with the requested header order.
- `read_rows(text)` returns dictionaries with string values.
- Values may contain commas, quotes, CRLFs, Unicode, empty strings, intentional spaces, and leading zeros.
- The output must be parseable by Python's stdlib `csv.DictReader`.

Keep the patch minimal and do not edit tests.
