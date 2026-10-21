#!/usr/bin/env bash
set -euo pipefail
cd "${1:-$(pwd)}"
python -B -m unittest discover -s tests -v
changed_count="$({ git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | wc -l | tr -d ' ')"
if [ "$changed_count" -gt 2 ]; then
  echo "too many changed files: $changed_count" >&2
  exit 1
fi
