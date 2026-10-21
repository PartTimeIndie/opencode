import unittest

from duration_parser import parse_duration


class DurationParserTest(unittest.TestCase):
    def test_single_unit_seconds(self):
        self.assertEqual(parse_duration("45s"), 45)

    def test_composite_hours_minutes(self):
        self.assertEqual(parse_duration("1h30m"), 5400)

    def test_composite_minutes_seconds_with_space(self):
        self.assertEqual(parse_duration("2m 10s"), 130)

    def test_invalid_duration(self):
        with self.assertRaises(ValueError):
            parse_duration("soon")


if __name__ == "__main__":
    unittest.main()
