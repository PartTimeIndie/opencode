#!/usr/bin/env bash
set -euo pipefail
"$(cd "$(dirname "$0")/../.." && pwd)/scripts/setup_task.sh" "$0" "${1:-manual}"
