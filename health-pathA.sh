#!/bin/bash
# ---------------------------------------------------------------------------
# health-pathA.sh — keep-alive / reviver for a PATH A deploy of hosting2vless.
#
# Path A = the panel runs the program for you (Node.js application manager:
# Webhostmost, Alwaysdata, cPanel / Control-WebPanel Node.js apps, Plesk,
# Phusion Passenger hosts, ...). There is NO universal way to restart a
# panel-managed app, because every panel restarts it differently — a button,
# an API call, an SSH command, or "restart on crash" built into the panel.
# A script that pretends otherwise is lying.
#
# So this script is deliberately split into a GENERIC part and a
# HOST-SPECIFIC part, and the generic part is the one that does most of the
# work on every host:
#
#   GENERIC (works everywhere, no config beyond the URL):
#     * Probe the PUBLIC URL (GET /). On most Path A hosts a request also
#       WAKES an app that the host stopped after 15-30 minutes idle — so
#       the probe alone revives the common "it worked, then stopped after
#       being left alone" case. It also keeps the app warm, so it never
#       goes idle in the first place.
#     * If the site still does not answer after 3 probes, log it.
#     * If the app crashed at startup (bad code, missing dependency), no
#       probe can fix it — the log tells you that instead of silently
#       looping a restart.
#
#   HOST-SPECIFIC (one line, only if your host offers a restart route):
#     * Set RESTART_CMD to the command that restarts YOUR app, or
#       RESTART_URL to a webhook / API endpoint that restarts it.
#       The script runs it at most once per 5 minutes, then probes again.
#       Leave both empty and the script is probe-only (still useful).
#
#   Examples (fill in your own values; do NOT copy a line for another host):
#     Alwaysdata:  RESTART_CMD='curl -sS -X POST --basic --user "$ALWAYSDATA_API_KEY account=metrics:" https://api.alwaysdata.com/v1/site/<SITE_ID>/restart/'
#                  (API token: panel > Profile > API tokens; SITE_ID: GET /v1/site/)
#     A host with an SSH restart command:
#                  RESTART_CMD='alwaysdata-web-restart'   # Alwaysdata SSH, if present
#     A host with only a panel button and no API/SSH route:
#                  (leave empty — probe-only, restart by hand in the panel)
#
# Install (any Path A host):
#   1. Save this file next to app.js (LF line endings, like health.sh).
#   2. Edit SITE_URL below (or set it as an env var in the scheduled job).
#      Optionally set RESTART_CMD / RESTART_URL for your host.
#   3. Schedule it in the panel — every 5 minutes is a good default:
#        * panel cron jobs:      bash /home/<user>/health-pathA.sh
#        * Alwaysdata Scheduled tasks: same command, frequency */5 * * * *
#        * no cron in the panel? Run it from ANYWHERE that can reach the
#          public URL — a free external cron (cron-job.org, UptimeRobot,
#          a GitHub Actions schedule) hitting the URL every 5 minutes
#          does the wake/keep-warm part by itself.
#      No execute bit needed (the job calls bash explicitly).
#
# Behaviour: probe up to 3 times; on success do nothing (no log spam).
# On repeated failure, run the restart hook once per 5 minutes (if set),
# wait, probe once more, and log the outcome. Log lines append to
# health-pathA.log next to this file (bounded).
# ---------------------------------------------------------------------------

# --- configuration: edit these, or set them as env vars in the job ---------
SITE_URL="${SITE_URL:-https://your-domain/}"
# RESTART_CMD="${RESTART_CMD:-}"   # uncomment and fill in for your host
# RESTART_URL="${RESTART_URL:-}"   # alternative to RESTART_CMD: POST this URL
PROBE_ATTEMPTS="${PROBE_ATTEMPTS:-3}"
PROBE_TIMEOUT="${PROBE_TIMEOUT:-20}"   # seconds; a cold start can take a while
RESTART_COOLDOWN_MIN="${RESTART_COOLDOWN_MIN:-5}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="${LOG_FILE:-$SCRIPT_DIR/health-pathA.log}"
RESTART_MARKER="$SCRIPT_DIR/.health-pathA-last-restart"

# Lock against overlapping runs (mkdir is atomic). A second instance that
# finds the lock gives up; the trap removes it again. A lock older than
# 2 minutes is from a run that died hard — take it over.
LOCK_DIR="$SCRIPT_DIR/.health-pathA.lock"
if [ -d "$LOCK_DIR" ] && find "$LOCK_DIR" -maxdepth 0 -mmin +2 2>/dev/null | grep -q .; then
  rmdir "$LOCK_DIR" 2>/dev/null
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') health-pathA: $*" >> "$LOG_FILE"
}

# Keep the log bounded: trim to the last 2000 lines past 5000.
if [ -f "$LOG_FILE" ] && [ "$(wc -l < "$LOG_FILE" 2>/dev/null)" -gt 5000 ] 2>/dev/null; then
  tail -n 2000 "$LOG_FILE" > "$LOG_FILE.trim" 2>/dev/null && mv "$LOG_FILE.trim" "$LOG_FILE"
fi

probe() {
  curl -fsS -o /dev/null -m "$PROBE_TIMEOUT" "$SITE_URL" 2>/dev/null
}

# Probe up to N times (a single failure can be a cold start, not a crash).
attempt=0
while [ "$attempt" -lt "$PROBE_ATTEMPTS" ]; do
  if probe; then
    exit 0
  fi
  attempt=$((attempt + 1))
  [ "$attempt" -lt "$PROBE_ATTEMPTS" ] && sleep 5
done

# Site is down. No restart hook? Then the probe was the revival attempt
# (it wakes hosts that start on demand) — say so plainly and stop.
if [ -z "${RESTART_CMD:-}" ] && [ -z "${RESTART_URL:-}" ]; then
  log "site down after $PROBE_ATTEMPTS probes ($SITE_URL); no RESTART_CMD/RESTART_URL configured — restart the app in the panel"
  exit 1
fi

# Do not restart more than once per cooldown (avoid a restart loop if the
# app itself is broken and crashes on start).
if [ -f "$RESTART_MARKER" ] && find "$RESTART_MARKER" -maxdepth 0 -mmin "-$RESTART_COOLDOWN_MIN" 2>/dev/null | grep -q .; then
  log "site down after $PROBE_ATTEMPTS probes; restart already attempted within the last $RESTART_COOLDOWN_MIN min, skipping"
  exit 1
fi

log "site down after $PROBE_ATTEMPTS probes; running restart hook"
if [ -n "${RESTART_CMD:-}" ]; then
  if bash -c "$RESTART_CMD" >> "$LOG_FILE" 2>&1; then
    log "restart command exited 0"
  else
    log "restart command exited non-zero (see log above)"
  fi
elif [ -n "${RESTART_URL:-}" ]; then
  HTTP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -m 30 "$RESTART_URL" 2>/dev/null)"
  log "restart webhook returned HTTP $HTTP_CODE"
fi
touch "$RESTART_MARKER"

# Give the restart time to come up, then check once more.
sleep 20
if probe; then
  log "site back up after restart"
  exit 0
fi
log "site STILL down after restart — check the app log in the panel (likely a startup error, not a liveness problem)"
exit 1
