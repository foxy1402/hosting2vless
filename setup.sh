#!/bin/bash
# ---------------------------------------------------------------------------
# setup.sh — one-time dependency setup for hosts whose panel has no Node.js
# app manager (e.g. DataOnline free hosting / DirectAdmin).
#
# Install:
#   1. Save this file in your HOME directory. Keep Unix/LF line endings.
#   2. Edit NODE_BIN and APP_DIR below (same values as health.sh).
#   3. Add a ONE-TIME cron job (per-minute is fine):
#        bash /home/<your-user>/setup.sh
#   4. Wait for the panel's email — it says "setup finished" on success.
#      Any failure is mailed too; just run the job once more.
#   5. DELETE this one-time cron job. Only health.sh's per-minute job
#      should remain on the host.
#
# Safe to run repeatedly: it exits immediately when the dependency is
# already installed, and a lock prevents two runs from installing at once.
# ---------------------------------------------------------------------------

NODE_BIN="/opt/cpanel/ea-node20/root/usr/bin/node"
APP_DIR="/home/<your-user>/domains/<your-domain>/public_html"

if [ ! -x "$NODE_BIN" ]; then
  echo "ERROR: node binary not found at: $NODE_BIN" >&2
  echo "Run a one-time cron job 'which node; node -v' and use the path it prints." >&2
  exit 1
fi

cd "$APP_DIR" || { echo "ERROR: APP_DIR not found: $APP_DIR" >&2; exit 1; }

# Lock against two overlapping installs (npm running twice in the same
# folder can corrupt it). A lock older than 15 minutes is stale — take over.
LOCK_DIR="$APP_DIR/.setup.lock"
if [ -d "$LOCK_DIR" ] && find "$LOCK_DIR" -maxdepth 0 -mmin +15 2>/dev/null | grep -q .; then
  rmdir "$LOCK_DIR" 2>/dev/null
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "setup.sh: another setup is already running - nothing to do"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# Already installed and usable? Then there is nothing to do. (Checking only
# for the folder would trust a half-finished install from an interrupted run.)
if [ -d node_modules ] && "$NODE_BIN" -e "require('ws')" 2>/dev/null; then
  echo "node_modules already present and working - nothing to do (delete this one-time cron job)."
  exit 0
fi

# A node_modules that exists but fails the check above is a broken remnant —
# clear it before retrying.
if [ -d node_modules ]; then
  echo "setup.sh: node_modules is broken - removing and reinstalling"
  rm -rf node_modules
fi

# Find the package manager. Depending on how the host's Node.js is laid out,
# the file next to the node binary is either JavaScript or a small shell
# wrapper — probe which one actually runs, and fall back to the plain npm
# entrypoint. (Feeding a shell wrapper to node fails with a syntax error.)
NPM_CANDIDATE="$(dirname "$NODE_BIN")/npm"
if [ -f "$NPM_CANDIDATE" ] && "$NODE_BIN" "$NPM_CANDIDATE" --version > /dev/null 2>&1; then
  NPM_JS="$NPM_CANDIDATE"
else
  NPM_JS="$(dirname "$NODE_BIN")/../lib/node_modules/npm/bin/npm-cli.js"
fi
if [ ! -f "$NPM_JS" ] || ! "$NODE_BIN" "$NPM_JS" --version > /dev/null 2>&1; then
  echo "ERROR: no usable npm found next to $NODE_BIN" >&2
  exit 1
fi

echo "node: $NODE_BIN ($("$NODE_BIN" -v 2>&1))"
echo "dir : $APP_DIR"

if ! "$NODE_BIN" "$NPM_JS" install --no-audit --no-fund; then
  echo "setup.sh: install failed - run this cron job again" >&2
  exit 1
fi
if ! "$NODE_BIN" -e "require('ws')" 2>/dev/null; then
  echo "setup.sh: install finished but the dependency is still missing - run it again" >&2
  exit 1
fi
echo "setup finished: $(ls node_modules 2>/dev/null | tr '\n' ' ')"
