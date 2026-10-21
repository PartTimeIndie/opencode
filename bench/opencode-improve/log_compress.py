from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

KEYWORDS = re.compile(r"\b(error|fail|failed|exception|traceback|assertion|warning|fatal)\b", re.IGNORECASE)
PATH_WITH_LINE = re.compile(r"(?:[A-Za-z]:)?[^\s:]+\.(?:py|ts|tsx|js|jsx|go|rs|java|cs|cpp|c|h):\d+")


def compress_log(text: str) -> dict[str, object]:
    lines = text.splitlines()
    keep = set(range(min(40, len(lines))))
    keep.update(range(max(0, len(lines) - 80), len(lines)))

    traceback = False
    for index, line in enumerate(lines):
        relevant = bool(KEYWORDS.search(line) or PATH_WITH_LINE.search(line))
        if line.startswith("Traceback (most recent call last):"):
            traceback = True
            relevant = True
        if traceback and (line.startswith("  File ") or line.strip().startswith(("File ", "raise "))):
            relevant = True
        if traceback and re.match(r"^[A-Za-z_][\w.]*Error:", line.strip()):
            relevant = True
            traceback = False
        if relevant:
            keep.update(range(max(0, index - 3), min(len(lines), index + 4)))

    collapsed = []
    previous_blank = False
    last_index = -1
    for index in sorted(keep):
        if index != last_index + 1 and collapsed and collapsed[-1] != "...":
            collapsed.append("...")
        line = lines[index]
        blank = line.strip() == ""
        if blank and previous_blank:
            last_index = index
            continue
        collapsed.append(line)
        previous_blank = blank
        last_index = index

    compressed = "\n".join(collapsed)
    return {
        "text": compressed,
        "original_lines": len(lines),
        "compressed_lines": len(collapsed),
        "original_bytes": len(text.encode()),
        "compressed_bytes": len(compressed.encode()),
        "compression_ratio": round(len(compressed.encode()) / max(1, len(text.encode())), 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Compress noisy benchmark logs while preserving diagnostic lines.")
    parser.add_argument("path", type=Path)
    parser.add_argument("--json", action="store_true", help="Print metadata and compressed text as JSON")
    args = parser.parse_args()

    result = compress_log(args.path.read_text(encoding="utf-8", errors="replace"))
    if args.json:
        print(json.dumps(result, indent=2))
        return 0
    print(result["text"])
    print(
        f"\n[compressed {result['original_lines']} lines to {result['compressed_lines']} lines, "
        f"ratio {result['compression_ratio']}]"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
