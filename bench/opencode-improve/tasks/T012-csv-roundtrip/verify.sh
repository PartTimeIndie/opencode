#!/usr/bin/env bash
set -euo pipefail
TASK_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "${1:-$(pwd)}"
python -B -m unittest discover -s tests -v
python "$TASK_DIR/hidden_verify.py" "$PWD"
git diff --quiet -- tests || { echo "public tests must not be modified" >&2; exit 1; }
