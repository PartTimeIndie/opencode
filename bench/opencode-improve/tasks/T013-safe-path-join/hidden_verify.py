import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(sys.argv[1])))

from src.safe_paths import safe_join


def must_reject(root, value):
    try:
        safe_join(root, value)
    except ValueError:
        return
    raise AssertionError(f"unsafe path was accepted: {value!r}")


with tempfile.TemporaryDirectory() as tmp:
    root = Path(tmp) / "app"
    root.mkdir()
    expected = (root / "b" / "file.txt").resolve()
    actual = Path(safe_join(root, "a/../b/file.txt"))
    if actual != expected:
        raise AssertionError(f"safe normalization failed: {actual!r}")
    for value in [
        "subdir/../../escape.txt",
        "..\\escape.txt",
        "/tmp/escape.txt",
        "C:/escape.txt",
        "C:\\escape.txt",
        "//server/share/escape.txt",
        "safe/..\\..\\escape.txt",
    ]:
        must_reject(root, value)

print("hidden path checks passed")
