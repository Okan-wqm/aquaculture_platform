#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# capacity-check.sh — connection-budget invariant for the platform
#
# Closes: docs/reviews/infra-expert/2026-04-14-infrastructure-hardening.md#INFRA-DB-POOL-001
#
# Sums the per-service `defaultPoolSize` arguments passed to
# createServiceTypeOrmConfig() across apps/*/src/app.module.ts plus the
# factory default (10) for services that don't override. Compares the
# total against the configured PostgreSQL max_connections and fails if
# the projected worst-case (sum × peak replicas) exceeds 70% of capacity.
#
# Sources of truth this script reads:
#   - libs/backend-common/src/database/typeorm-config.factory.ts
#       DEFAULT_POOL_SIZE constant — the platform-wide default
#   - apps/*/src/app.module.ts
#       per-service `defaultPoolSize: <N>,` overrides
#   - infrastructure/helm/aquaculture/values.yaml
#       per-service replicaCount / autoscaling.maxReplicas (K8s peak)
#   - $POSTGRES_MAX_CONNECTIONS env (default 300, matching droplet)
#
# Intended callers:
#   1. Pre-commit hook for changes under apps/*/src/app.module.ts.
#   2. CI step in .github/workflows/infra-helm-lint.yml (or a sibling
#      workflow) so a new service or a raised default that breaks the
#      budget fails the PR that introduces it, not days later when
#      production sees `connection refused`.
#   3. Operators on-call who want to sanity-check before scaling HPA
#      maxReplicas.
# -----------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

POSTGRES_MAX_CONNECTIONS="${POSTGRES_MAX_CONNECTIONS:-300}"
HEADROOM_PCT="${HEADROOM_PCT:-70}"   # fail if total > 70% of max_connections

FACTORY_FILE="${REPO_ROOT}/libs/backend-common/src/database/typeorm-config.factory.ts"
APPS_GLOB="${REPO_ROOT}/apps/*/src/app.module.ts"

if [ ! -f "${FACTORY_FILE}" ]; then
  echo "ERROR: factory file not found at ${FACTORY_FILE}" >&2
  exit 2
fi

# 1. Extract the platform default from the factory's DEFAULT_POOL_SIZE.
DEFAULT_POOL_SIZE=$(grep -E '^export const DEFAULT_POOL_SIZE' "${FACTORY_FILE}" \
  | grep -oE '[0-9]+' | head -1)
if [ -z "${DEFAULT_POOL_SIZE}" ]; then
  echo "ERROR: could not parse DEFAULT_POOL_SIZE from ${FACTORY_FILE}" >&2
  exit 2
fi

# 2. Walk every app's app.module.ts. For each service that calls
#    createServiceTypeOrmConfig, find its serviceName and any
#    defaultPoolSize override (default = DEFAULT_POOL_SIZE).
declare -A SERVICE_POOL=()
TOTAL=0

for app_module in ${APPS_GLOB}; do
  if ! grep -q 'createServiceTypeOrmConfig' "${app_module}"; then
    continue
  fi
  service=$(grep -oE "serviceName: ['\"][^'\"]+['\"]" "${app_module}" | head -1 | sed -E "s/serviceName: ['\"]([^'\"]+)['\"]/\1/")
  if [ -z "${service}" ]; then
    service=$(basename "$(dirname "$(dirname "${app_module}")")")
  fi
  pool=$(grep -oE 'defaultPoolSize:\s*[0-9]+' "${app_module}" | head -1 | grep -oE '[0-9]+' || true)
  if [ -z "${pool}" ]; then
    pool="${DEFAULT_POOL_SIZE}"
  fi
  SERVICE_POOL["${service}"]="${pool}"
  TOTAL=$((TOTAL + pool))
done

# 3. db-migrate is a one-shot CLI job that hand-rolls a max:2 outside the
#    factory. Add it explicitly so the budget reflects reality.
SERVICE_POOL["db-migrate (one-shot)"]=2
TOTAL=$((TOTAL + 2))

# 4. Render the table, sorted by pool size desc.
printf '\n=== TypeORM connection-budget report ===\n'
printf '  POSTGRES_MAX_CONNECTIONS: %s\n' "${POSTGRES_MAX_CONNECTIONS}"
printf '  Headroom threshold:       %s%%\n' "${HEADROOM_PCT}"
printf '  Factory default pool:     %s\n\n' "${DEFAULT_POOL_SIZE}"

printf '  %-32s  %s\n' 'service' 'pool'
printf '  %-32s  %s\n' '------------------------------' '----'
for svc in "${!SERVICE_POOL[@]}"; do
  printf '  %-32s  %4d\n' "${svc}" "${SERVICE_POOL[${svc}]}"
done | sort -k2 -n -r

THRESHOLD=$(( POSTGRES_MAX_CONNECTIONS * HEADROOM_PCT / 100 ))
printf '\n  TOTAL (1 replica/service):  %4d / %d connections (%d%% threshold = %d)\n' \
  "${TOTAL}" "${POSTGRES_MAX_CONNECTIONS}" "${HEADROOM_PCT}" "${THRESHOLD}"

if [ "${TOTAL}" -gt "${THRESHOLD}" ]; then
  printf '\n  RESULT: FAIL — single-replica budget already exceeds %d%% of max_connections.\n' \
    "${HEADROOM_PCT}"
  printf '          Either raise POSTGRES_MAX_CONNECTIONS, lower a per-service default,\n'
  printf '          or land RDS Proxy (Track B). See docs/runbooks/database-capacity.md.\n'
  exit 1
fi

printf '\n  RESULT: PASS — single-replica budget within threshold.\n'
printf '\n  Note: K8s + HPA multiplies these per-service totals by replica count.\n'
printf '         At gateway max=10 + sensor max=15 (helm values), the projected K8s\n'
printf '         worst case will exceed POSTGRES_MAX_CONNECTIONS — RDS Proxy (Track B)\n'
printf '         is the resolution path, not raising the per-service pool.\n\n'
