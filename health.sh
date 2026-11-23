#!/bin/bash
# ---------------------------------------------------------------------------
# health.sh — keeps the site service alive on shared hosts whose panel has no
# Node.js app manager (e.g. DataOnline free hosting / DirectAdmin).
#
# Install:
#   1. Save this file in your HOME directory (the panel file manager can
#      create it). Keep Unix/LF line endings — CRLF breaks bash.
#   2. Edit NODE_BIN and APP_DIR below (and PORT, only if you changed it in
#      app.js / .htaccess).
#   3. Add a cron job that runs every minute:
#        bash /home/<your-user>/health.sh
#      No execute bit needed (cron calls bash explicitly).
#
# Behaviour: if nothing is listening on the service port, the service is
# started detached using the host's built-in Node.js. Log lines append to
# <APP_DIR>/site.log, the PID is written to <APP_DIR>/site.pid. Running it
# while the service is up does nothing.
# ---------------------------------------------------------------------------

# Full path to the host's node binary. CloudLinux installs it under
# /opt/cpanel/ea-node<NN>/...  — to find it without SSH, add a temporary
# cron job "which node; node -v"; the panel emails you the output.
NODE_BIN="/opt/cpanel/ea-node20/root/usr/bin/node"

# Absolute path to the folder containing app.js (your public_html).
APP_DIR="/home/<your-user>/domains/<your-domain>/public_html"

# The port the service listens on (must match PORT in app.js and .htaccess).
PORT=28741

cd "$APP_DIR" || { echo "health.sh: APP_DIR not found: $APP_DIR" >&2; exit 1; }

# Lock against overlapping cron invocations (mkdir is atomic). A second
# instance that finds the lock gives up; the trap removes it again. A lock
# older than 2 minutes is from a run that died hard — take it over.
LOCK_DIR="$APP_DIR/.health.lock"
if [ -d "$LOCK_DIR" ] && find "$LOCK_DIR" -maxdepth 0 -mmin +2 2>/dev/null | grep -q .; then
  rmdir "$LOCK_DIR" 2>/dev/null
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# Keep site.log bounded (this host has little disk and runs for years):
# trim to the last 2000 lines if it grew beyond 5000.
if [ -f site.log ] && [ "$(wc -l < site.log 2>/dev/null)" -gt 5000 ] 2>/dev/null; then
  tail -n 2000 site.log > site.log.trim 2>/dev/null && mv site.log.trim site.log
fi

# Already running? A listening port means the service is up. A port check
# beats process/PID matching on a shared host: it cannot be fooled by
# another user's processes, by recycled PIDs, or by a duplicate start.
if (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
  exit 0
fi

# The client-ID file is shared with every client — keep it out of web browsing.
chmod 600 config.txt 2>/dev/null

# Where the start goes in the log. If site.log is not writable (full disk),
# fall back to /dev/null: the service must still start.
LOG_FILE="site.log"
if [ -e "$LOG_FILE" ] && [ ! -w "$LOG_FILE" ]; then
  LOG_FILE="/dev/null"
fi

# Log the start BEFORE starting the service: the keeper and the service both
# append to the log, and writing this line first (a single small write that
# finishes long before the service can print its first line) keeps their
# writes from racing on any filesystem.
echo "$(date '+%Y-%m-%d %H:%M:%S') health.sh: service starting" >> "$LOG_FILE"
nohup "$NODE_BIN" app.js >> "$LOG_FILE" 2>&1 &
echo $! > site.pid
