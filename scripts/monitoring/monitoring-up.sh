#!/usr/bin/env bash
# =============================================================================
# monitoring-up.sh — the ONE supported activation path for the droplet
# monitoring stack (B2 / OBS-HIGH-002).
# =============================================================================
# Refuses to start unless the LIVE MemAvailable clears a Tier-1 preflight, so
# the monitoring stack can never be the cause of an application OOM. There is NO
# override flag — the gate IS the activation policy. The stack runs as a
# separate compose project (aqua-monitoring) so the app deploy's
# `--remove-orphans` can never orphan-kill it.
#
# Usage (on the droplet):
#   MONITORING_PROFILE=monitoring ./scripts/monitoring/monitoring-up.sh
#   MONITORING_PROFILE=monitoring-full MONITORING_FULL_ACK=<ticket> ./scripts/monitoring/monitoring-up.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.monitoring.yml"
PROJECT="aqua-monitoring"
PROFILE="${MONITORING_PROFILE:-monitoring}"

# Tier-1 floors (KiB). Core: ~768M cap + headroom => 1.5 GiB MemAvailable.
# Full (grafana/loki/alloy): a 16GB-class droplet => 15 GiB MemTotal.
readonly CORE_FLOOR_KIB=$((1536 * 1024))
readonly FULL_FLOOR_KIB=$((15 * 1024 * 1024))

mem_available_kib() { awk '/^MemAvailable:/ {print $2}' /proc/meminfo; }
mem_total_kib() { awk '/^MemTotal:/ {print $2}' /proc/meminfo; }

case "$PROFILE" in
  monitoring | monitoring-full) ;;
  *)
    echo "ERROR: MONITORING_PROFILE must be 'monitoring' or 'monitoring-full' (got '$PROFILE')." >&2
    exit 2
    ;;
esac

avail_kib="$(mem_available_kib)"
echo "MemAvailable: $((avail_kib / 1024)) MiB | requested profile: $PROFILE"

if [ "$avail_kib" -lt "$CORE_FLOOR_KIB" ]; then
  {
    echo "REFUSED: MemAvailable $((avail_kib / 1024)) MiB is below the $((CORE_FLOOR_KIB / 1024)) MiB Tier-1 floor."
    echo "The monitoring stack must not start when it could starve application containers."
    echo "This droplet needs the resize that gates B4/B5 activation. There is no override flag."
  } >&2
  exit 1
fi

if [ "$PROFILE" = "monitoring-full" ]; then
  total_kib="$(mem_total_kib)"
  if [ "$total_kib" -lt "$FULL_FLOOR_KIB" ]; then
    echo "REFUSED: monitoring-full needs MemTotal >= 15 GiB; this host has $((total_kib / 1024 / 1024)) GiB." >&2
    exit 1
  fi
  # The full profile is the audited, ticketed activation (B5). The ack is
  # recorded by the caller's deploy log.
  : "${MONITORING_FULL_ACK:?monitoring-full requires MONITORING_FULL_ACK=<ticket> for the audit trail}"
  echo "monitoring-full activation acknowledged: $MONITORING_FULL_ACK"
fi

# Prometheus accepts an Authorization credentials_file, while the
# observability-service guard accepts the equivalent Bearer header. Persist the
# credential outside the checkout so a container restart never depends on a
# secret committed to or rendered inside the repository.
: "${OBSERVABILITY_INTERNAL_API_KEY:?set OBSERVABILITY_INTERNAL_API_KEY for the guarded scrape}"
monitoring_state_home="${XDG_STATE_HOME:-$HOME/.local/state}/aqua-monitoring"
mkdir -p "$monitoring_state_home"
chmod 700 "$monitoring_state_home"
OBSERVABILITY_PROMETHEUS_CREDENTIAL_FILE="$monitoring_state_home/observability-api-key"
umask 077
printf '%s\n' "$OBSERVABILITY_INTERNAL_API_KEY" > "$OBSERVABILITY_PROMETHEUS_CREDENTIAL_FILE"
export OBSERVABILITY_PROMETHEUS_CREDENTIAL_FILE

# Render alertmanager webhook endpoints from secrets (idempotent) before up.
if [ -x "$SCRIPT_DIR/render-configs.sh" ]; then
  "$SCRIPT_DIR/render-configs.sh"
fi

echo "Tier-1 preflight passed. Bringing up project '$PROJECT' (profile: $PROFILE)…"
exec docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --profile "$PROFILE" up -d
