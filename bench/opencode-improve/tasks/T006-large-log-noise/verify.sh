#!/usr/bin/env bash
set -euo pipefail
cd "${1:-$(pwd)}"
python -B -m unittest discover -s tests -v
