import csv
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1])))

from src.csv_table import read_rows, write_rows


headers = ["id", "name", "note"]
rows = [
    {"id": "001", "name": "Ada", "note": " leading and trailing "},
    {"id": "002", "name": "Béla", "note": "comma, quote \" and\r\nnewline"},
    {"id": "003", "name": "", "note": ""},
]
text = write_rows(rows, headers)
parsed_by_stdlib = list(csv.DictReader(io.StringIO(text)))
if parsed_by_stdlib != rows:
    raise AssertionError(f"stdlib could not roundtrip output: {parsed_by_stdlib!r}")
if read_rows(text) != rows:
    raise AssertionError("read_rows did not roundtrip hidden rows")
if "\r\r\n" in text:
    raise AssertionError("CSV output has doubled CRLF newlines")

print("hidden csv checks passed")
