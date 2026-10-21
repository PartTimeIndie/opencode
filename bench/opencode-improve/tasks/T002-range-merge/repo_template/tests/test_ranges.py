import unittest

from ranges import merge_intervals


class MergeIntervalsTest(unittest.TestCase):
    def test_empty(self):
        self.assertEqual(merge_intervals([]), [])

    def test_single(self):
        self.assertEqual(merge_intervals([[4, 8]]), [[4, 8]])

    def test_unsorted_overlapping(self):
        self.assertEqual(merge_intervals([[5, 7], [1, 4], [3, 6]]), [[1, 7]])

    def test_touching_intervals_merge(self):
        self.assertEqual(merge_intervals([[1, 2], [2, 3], [8, 9]]), [[1, 3], [8, 9]])


if __name__ == "__main__":
    unittest.main()
