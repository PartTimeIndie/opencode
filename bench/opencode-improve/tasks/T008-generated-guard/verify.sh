#!/usr/bin/env bash
set -euo pipefail
cd "${1:-$(pwd)}"
python -B -m unittest discover -s tests -v
python - <<'PY'
import hashlib
from pathlib import Path

current = hashlib.sha256(Path("generated/generated_table.py").read_bytes()).hexdigest()
expected = hashlib.sha256(Path("tests/fixtures/generated_table.py.expected").read_bytes()).hexdigest()
if current != expected:
    raise SystemExit(f"generated/generated_table.py changed: {current} != {expected}")
PY
