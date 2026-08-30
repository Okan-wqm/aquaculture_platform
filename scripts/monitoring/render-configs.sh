#!/usr/bin/env bash
# =============================================================================
# render-configs.sh — put the real delivery settings into the committed
# alertmanager.yml at activation time.
# =============================================================================
# The committed file ships `.invalid` placeholders (RFC 2606 reserves that TLD,
# so it can never resolve) which keep `amtool check-config` green in CI while
# guaranteeing that an unrendered config cannot quietly mail a stranger. This
# script replaces them in place on the droplet, where the checkout IS the
# deployment source: alertmanager mounts
# ./infrastructure/monitoring/droplet/alertmanager.yml directly.
#
# WHY THIS WAS REWRITTEN. The previous version demanded three external webhook
# endpoints (ALERTMANAGER_{HEARTBEAT,PAGE,DIGEST}_URL) and hard-failed if any
# was unset. Those endpoints were never procured, so the script could not run,
# so nothing called it, so alertmanager has spent months pointed at
# 127.0.0.1:9099 with nothing listening — every alert this platform raised went
# nowhere. Email delivery is what actually exists: the droplet already runs
# working SMTP credentials for notification-service.
#
# So SMTP + recipients are now REQUIRED (they are the delivery), and the
# webhook URLs are OPTIONAL (substituted when present, left alone with a loud
# notice when not).
#
# Idempotent: a second run finds no placeholders and changes nothing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AM="${ALERTMANAGER_CONFIG_PATH:-$REPO_ROOT/infrastructure/monitoring/droplet/alertmanager.yml}"

test -f "$AM" || { echo "render-configs: no alertmanager.yml at $AM" >&2; exit 1; }

# --- delivery: required ------------------------------------------------------
: "${SMTP_HOST:?set SMTP_HOST (the droplet already has one for notification-service)}"
: "${SMTP_USER:?set SMTP_USER}"
: "${SMTP_PASSWORD:?set SMTP_PASSWORD}"
: "${SMTP_FROM:?set SMTP_FROM (envelope sender)}"
: "${ALERT_PAGE_EMAIL_TO:?set ALERT_PAGE_EMAIL_TO (who gets critical alerts)}"
SMTP_PORT="${SMTP_PORT:-587}"
# Role routing later: digest defaults to the same mailbox as page today, but it
# is a separate variable so splitting them costs one export, not a redesign.
ALERT_DIGEST_EMAIL_TO="${ALERT_DIGEST_EMAIL_TO:-$ALERT_PAGE_EMAIL_TO}"

# A recipient that is still a placeholder means the caller fat-fingered the
# export; failing here beats discovering it when an alert does not arrive.
case "$ALERT_PAGE_EMAIL_TO$ALERT_DIGEST_EMAIL_TO" in
  *example.invalid*) echo "render-configs: recipients still point at example.invalid" >&2; exit 1 ;;
esac

# `|` is the delimiter; addresses and hosts cannot contain it.
sed -i \
  -e "s|smtp.invalid:587|${SMTP_HOST}:${SMTP_PORT}|g" \
  -e "s|alerts@example.invalid|${SMTP_FROM}|g" \
  -e "s|REPLACE_SMTP_USER|${SMTP_USER}|g" \
  -e "s|REPLACE_SMTP_PASSWORD|${SMTP_PASSWORD}|g" \
  -e "s|page@example.invalid|${ALERT_PAGE_EMAIL_TO}|g" \
  -e "s|digest@example.invalid|${ALERT_DIGEST_EMAIL_TO}|g" \
  "$AM"

# --- deadman: optional -------------------------------------------------------
# The heartbeat route is a deadman: an EXTERNAL watcher is supposed to alarm
# when the pings stop. Email cannot play that role — a mailbox receiving
# nothing looks exactly like a mailbox nobody sent to — so this stays a webhook
# and stays unwired until an endpoint exists. Saying so out loud beats leaving
# a loopback URL that reads like configuration.
if [ -n "${ALERTMANAGER_HEARTBEAT_URL:-}" ]; then
  sed -i -e "s|http://127.0.0.1:9099/heartbeat|${ALERTMANAGER_HEARTBEAT_URL}|g" "$AM"
  echo "render-configs: heartbeat deadman wired."
else
  echo "render-configs: NOTICE — no ALERTMANAGER_HEARTBEAT_URL; the deadman is not wired." >&2
  echo "render-configs: a monitoring stack that stops will not announce itself." >&2
fi

if grep -q 'example\.invalid\|REPLACE_SMTP' "$AM"; then
  echo "render-configs: FAILED — placeholders survived substitution in $AM" >&2
  exit 1
fi

echo "render-configs: alertmanager delivery rendered (page + digest by email)."
