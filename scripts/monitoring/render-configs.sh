#!/usr/bin/env bash
# =============================================================================
# render-configs.sh — substitute the committed alertmanager.yml loopback
# placeholders with the real droplet webhook endpoints from secrets (B2).
# =============================================================================
# The committed alertmanager.yml ships amtool-valid loopback placeholders
# (http://127.0.0.1:9099/{heartbeat,page,digest}) so the monitoring-stack
# validation CI can `amtool check-config` it. At activation, monitoring-up.sh
# calls this to overwrite them IN PLACE (the droplet checkout is ephemeral —
# re-pulled each deploy) with values that are never committed. Idempotent: a
# second run no-ops because the placeholders are already gone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
AM="$REPO_ROOT/infrastructure/monitoring/droplet/alertmanager.yml"

: "${ALERTMANAGER_HEARTBEAT_URL:?set ALERTMANAGER_HEARTBEAT_URL (external deadman heartbeat endpoint)}"
: "${ALERTMANAGER_PAGE_URL:?set ALERTMANAGER_PAGE_URL (critical-paging webhook)}"
: "${ALERTMANAGER_DIGEST_URL:?set ALERTMANAGER_DIGEST_URL (warning-digest webhook)}"

# Use a sed delimiter unlikely to collide with URL characters.
sed -i \
  -e "s|http://127.0.0.1:9099/heartbeat|${ALERTMANAGER_HEARTBEAT_URL}|g" \
  -e "s|http://127.0.0.1:9099/page|${ALERTMANAGER_PAGE_URL}|g" \
  -e "s|http://127.0.0.1:9099/digest|${ALERTMANAGER_DIGEST_URL}|g" \
  "$AM"

echo "Rendered alertmanager.yml webhook endpoints (heartbeat/page/digest)."
