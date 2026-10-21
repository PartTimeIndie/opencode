import tempfile
import unittest
from pathlib import Path

from src.safe_paths import safe_join


class SafePathsTest(unittest.TestCase):
    def test_safe_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "app"
            root.mkdir()
            self.assertEqual(Path(safe_join(root, "logs/app.txt")), root / "logs" / "app.txt")

    def test_nested_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "app"
            root.mkdir()
            with self.assertRaises(ValueError):
                safe_join(root, "logs/../../secret.txt")


if __name__ == "__main__":
    unittest.main()
