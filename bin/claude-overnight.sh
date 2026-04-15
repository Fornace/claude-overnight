#!/bin/bash
# Self-bootstrapping wrapper: ensures dist/ is fresh before running.
# This is the entry point for the global `claude-overnight` command.

# Resolve the actual script path (follow symlinks)
SCRIPT="$0"
while [ -L "$SCRIPT" ]; do
  DIR="$(cd "$(dirname "$SCRIPT")" && pwd)"
  SCRIPT="$(readlink "$SCRIPT")"
  case "$SCRIPT" in /*) ;; *) SCRIPT="$DIR/$SCRIPT" ;; esac
done

# The wrapper lives in bin/ at the repo root
REPO_DIR="$(cd "$(dirname "$SCRIPT")/.." && pwd)"

# Rebuild if any .ts file is newer than dist/bin.js
if [ ! -f "$REPO_DIR/dist/bin.js" ] || \
   find "$REPO_DIR/src" -name '*.ts' -newer "$REPO_DIR/dist/bin.js" -print -quit 2>/dev/null | grep -q .; then
  echo "  ⚡ rebuilding..." >&2
  (cd "$REPO_DIR" && npm run build >/dev/null 2>&1)
fi

exec node "$REPO_DIR/dist/bin.js" "$@"
