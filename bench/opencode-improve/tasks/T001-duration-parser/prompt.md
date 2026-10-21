Fix the Python duration parser in this repository.

Expected behavior:
- parse_duration("1h30m") returns 5400
- parse_duration("45s") returns 45
- parse_duration("2m 10s") returns 130

Run the unit tests and keep the patch minimal.
