#!/usr/bin/env bash
# Build a double-click launcher .app for cmux-mobile.
#
#   bash scripts/build-app.sh [output-dir]
#
# Bakes this machine's absolute `node` path and the repo's bin path into an
# AppleScript app so it runs with NO Terminal window. Default output:
# ~/Applications/cmux-mobile.app. Re-run after changing Node versions or moving
# the repo.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
TEMPLATE="$PROJECT/scripts/cmux-mobile-launcher.applescript"
OUT_DIR="${1:-$HOME/Applications}"
APP="$OUT_DIR/cmux-mobile.app"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi
BIN_PATH="$PROJECT/bin/cmux-mobile.js"

if [ ! -f "$PROJECT/dist/server/index.js" ]; then
  echo "dist missing — building first..."
  (cd "$PROJECT" && npm run build)
fi

mkdir -p "$OUT_DIR"
TMP="$(mktemp -t cmux-mobile-launcher.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
sed -e "s|__NODE__|$NODE_BIN|g" -e "s|__BIN__|$BIN_PATH|g" "$TEMPLATE" > "$TMP"

rm -rf "$APP"
/usr/bin/osacompile -o "$APP" "$TMP"

echo ""
echo "Built: $APP"
echo "  node:    $NODE_BIN"
echo "  project: $PROJECT"
echo ""
echo "Double-click it in Finder or Launchpad to start cmux-mobile (no terminal)."
echo "Double-click again to Stop / Copy URL. First launch asks for permission."
