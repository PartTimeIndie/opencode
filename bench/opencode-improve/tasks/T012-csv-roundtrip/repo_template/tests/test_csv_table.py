import unittest

from src.csv_table import read_rows, write_rows


class CsvTableTest(unittest.TestCase):
    def test_simple_roundtrip(self):
        rows = [{"id": "1", "name": "Ada"}]
        self.assertEqual(read_rows(write_rows(rows, ["id", "name"])), rows)

    def test_quotes_commas(self):
        rows = [{"id": "1", "name": "Ada, the \"first\""}]
        self.assertEqual(read_rows(write_rows(rows, ["id", "name"])), rows)


if __name__ == "__main__":
    unittest.main()
