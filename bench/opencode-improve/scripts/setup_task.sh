#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="$1"
RUN_ID="${2:-manual}"
TASK_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
TASK_ID="$(basename "$TASK_DIR")"
ROOT="$(cd "$TASK_DIR/../.." && pwd)"
WORKSPACE="$ROOT/tmp/$TASK_ID/$RUN_ID"

case "$WORKSPACE" in
  "$ROOT"/tmp/*) ;;
  *)
    echo "refusing unsafe workspace: $WORKSPACE" >&2
    exit 2
    ;;
esac

rm -rf "$WORKSPACE"
mkdir -p "$WORKSPACE/repo"
cp -R "$TASK_DIR/repo_template/." "$WORKSPACE/repo/"
cd "$WORKSPACE/repo"
printf '%s\n' "__pycache__/" "*.pyc" > .gitignore
git init -q
git add .
git -c user.email=benchmark@example.invalid -c user.name=benchmark commit -q -m baseline
printf '%s\n' "$WORKSPACE/repo"
