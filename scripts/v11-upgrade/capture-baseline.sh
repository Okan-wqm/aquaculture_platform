#!/usr/bin/env bash
# =============================================================================
# capture-baseline.sh -- Pre-upgrade baseline metrics capture for NestJS v11
#
# Captures container health, resource usage, NATS JetStream state, health
# endpoint latency, and Apollo Federation composition status.  Produces a
# structured JSON report that later phases reference when evaluating the
# ADR-013 Section 7.2 rollback criteria ("2x baseline" for NATS latency,
# handler-count parity, error-rate thresholds).
#
# Usage:
#   ./scripts/v11-upgrade/capture-baseline.sh [--phase <label>] [--output-dir <dir>]
#
# Requirements:
#   - Docker CLI with access to the running Compose stack
#   - jq >= 1.6
#   - curl
#   - Executed from within the Docker host (containers reachable via docker exec)
#
# Ref: ADR-013 Section 8.4, Section 7.2
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Backend containers targeted by the v11 upgrade (ADR-013 scope)
readonly BACKEND_CONTAINERS=(
  aqua-event-store
  aqua-observability
  aqua-config
  aqua-auth
  aqua-gateway
  aqua-sensor
  aqua-farm
  aqua-hr
  aqua-alert
  aqua-billing
  aqua-hydroponics
  aqua-notification
  aqua-messaging
  aqua-admin-api
)

# Infrastructure containers needed for cross-reference but not upgraded
readonly INFRA_CONTAINERS=(
  aqua-postgres
  aqua-redis
  aqua-nats
  aqua-mosquitto
  aqua-nginx
)

# Container-name to internal health port mapping (from docker-compose.droplet.yml)
declare -A HEALTH_PORTS=(
  [aqua-gateway]=3000
  [aqua-auth]=3000
  [aqua-farm]=3000
  [aqua-sensor]=3000
  [aqua-admin-api]=3000
  [aqua-alert]=3000
  [aqua-billing]=3000
  [aqua-hr]=3000
  [aqua-hydroponics]=3000
  [aqua-notification]=3000
  [aqua-observability]=3009
  [aqua-config]=3000
  [aqua-messaging]=3000
  [aqua-event-store]=3000
)

# NATS monitoring port inside the aqua-nats container
readonly NATS_MONITOR_PORT=8222

# Number of health-check samples per service (for latency averaging)
readonly HEALTH_SAMPLES=3

# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------

PHASE_LABEL="pre-phase-2"
OUTPUT_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase)
      PHASE_LABEL="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--phase <label>] [--output-dir <dir>]"
      echo ""
      echo "Options:"
      echo "  --phase       Phase label for the report (default: pre-phase-2)"
      echo "  --output-dir  Override output directory (default: scripts/v11-upgrade/baselines)"
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# Resolve output directory relative to repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${OUTPUT_DIR}" ]]; then
  OUTPUT_DIR="${REPO_ROOT}/scripts/v11-upgrade/baselines"
fi

mkdir -p "${OUTPUT_DIR}"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
OUTFILE="${OUTPUT_DIR}/baseline-${TIMESTAMP}.json"
ISO_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Temporary directory for intermediate JSON fragments
TMPDIR="$(mktemp -d)"
trap 'rm -rf "${TMPDIR}"' EXIT

# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

##
# Log a timestamped informational message to stderr.
# @param {string} message - The message to print.
##
log_info() {
  echo "[$(date -u +%H:%M:%S)] INFO  $*" >&2
}

##
# Log a timestamped warning message to stderr.
# @param {string} message - The message to print.
##
log_warn() {
  echo "[$(date -u +%H:%M:%S)] WARN  $*" >&2
}

##
# Log a timestamped error message to stderr.
# @param {string} message - The message to print.
##
log_error() {
  echo "[$(date -u +%H:%M:%S)] ERROR $*" >&2
}

##
# Check whether a required binary exists on PATH.
# @param {string} binary - The name of the binary to check.
##
require_binary() {
  local binary="$1"
  if ! command -v "${binary}" &>/dev/null; then
    log_error "Required binary '${binary}' not found on PATH."
    exit 1
  fi
}

##
# Check whether a Docker container exists and is running.
# Returns 0 if running, 1 otherwise.
# @param {string} container - The container name.
##
is_container_running() {
  local container="$1"
  local state
  state="$(docker inspect --format='{{.State.Running}}' "${container}" 2>/dev/null || echo "false")"
  [[ "${state}" == "true" ]]
}

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------

log_info "Starting baseline capture (phase=${PHASE_LABEL})"

require_binary docker
require_binary jq
require_binary curl

# Verify Docker daemon is reachable
if ! docker info &>/dev/null; then
  log_error "Cannot reach Docker daemon. Is Docker running?"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Container health baseline
# ---------------------------------------------------------------------------

log_info "Capturing container health for ${#BACKEND_CONTAINERS[@]} backend + ${#INFRA_CONTAINERS[@]} infra containers"

capture_container_health() {
  local container="$1"
  local category="$2"

  if ! docker inspect "${container}" &>/dev/null 2>&1; then
    echo "{\"name\":\"${container}\",\"category\":\"${category}\",\"exists\":false}"
    return
  fi

  # Extract health status, start time, restart count, and image digest in one call
  local inspect_json
  inspect_json="$(docker inspect "${container}" 2>/dev/null)" || {
    echo "{\"name\":\"${container}\",\"category\":\"${category}\",\"exists\":false}"
    return
  }

  local health_status started_at restart_count image_id state_status
  health_status="$(echo "${inspect_json}" | jq -r '.[0].State.Health.Status // "no-healthcheck"')"
  state_status="$(echo "${inspect_json}" | jq -r '.[0].State.Status // "unknown"')"
  started_at="$(echo "${inspect_json}" | jq -r '.[0].State.StartedAt // "unknown"')"
  restart_count="$(echo "${inspect_json}" | jq -r '.[0].RestartCount // 0')"
  image_id="$(echo "${inspect_json}" | jq -r '.[0].Image // "unknown"')"

  jq -n \
    --arg name "${container}" \
    --arg category "${category}" \
    --arg healthStatus "${health_status}" \
    --arg stateStatus "${state_status}" \
    --arg startedAt "${started_at}" \
    --argjson restartCount "${restart_count}" \
    --arg imageId "${image_id}" \
    '{
      name: $name,
      category: $category,
      exists: true,
      healthStatus: $healthStatus,
      stateStatus: $stateStatus,
      startedAt: $startedAt,
      restartCount: $restartCount,
      imageId: $imageId
    }'
}

containers_json="[]"

for c in "${BACKEND_CONTAINERS[@]}"; do
  entry="$(capture_container_health "${c}" "backend")"
  containers_json="$(echo "${containers_json}" | jq --argjson e "${entry}" '. + [$e]')"
done

for c in "${INFRA_CONTAINERS[@]}"; do
  entry="$(capture_container_health "${c}" "infrastructure")"
  containers_json="$(echo "${containers_json}" | jq --argjson e "${entry}" '. + [$e]')"
done

echo "${containers_json}" > "${TMPDIR}/containers.json"
log_info "Container health: captured $(echo "${containers_json}" | jq 'length') entries"

# ---------------------------------------------------------------------------
# 2. Memory / CPU / Network usage
# ---------------------------------------------------------------------------

log_info "Capturing resource usage via docker stats"

##
# Parse docker stats output into a structured JSON array.
# Each entry contains name, cpuPercent, memUsage, memLimit, netInput, netOutput.
##
capture_resource_usage() {
  local stats_output
  stats_output="$(docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.PIDs}}' 2>/dev/null)" || {
    echo "[]"
    return
  }

  local result="[]"

  while IFS=$'\t' read -r name cpu mem_usage mem_perc net_io pids; do
    # Filter to aqua- prefixed containers only
    if [[ "${name}" != aqua-* ]]; then
      continue
    fi

    # Parse memory: "123.4MiB / 512MiB" -> usage and limit
    local mem_used mem_limit
    mem_used="$(echo "${mem_usage}" | sed 's| / .*||')"
    mem_limit="$(echo "${mem_usage}" | sed 's|.* / ||')"

    # Parse network I/O: "1.23MB / 4.56MB" -> input and output
    local net_in net_out
    net_in="$(echo "${net_io}" | sed 's| / .*||')"
    net_out="$(echo "${net_io}" | sed 's|.* / ||')"

    local entry
    entry="$(jq -n \
      --arg name "${name}" \
      --arg cpuPercent "${cpu}" \
      --arg memUsed "${mem_used}" \
      --arg memLimit "${mem_limit}" \
      --arg memPercent "${mem_perc}" \
      --arg netInput "${net_in}" \
      --arg netOutput "${net_out}" \
      --arg pids "${pids}" \
      '{
        name: $name,
        cpuPercent: $cpuPercent,
        memUsed: $memUsed,
        memLimit: $memLimit,
        memPercent: $memPercent,
        netInput: $netInput,
        netOutput: $netOutput,
        pids: $pids
      }'
    )"

    result="$(echo "${result}" | jq --argjson e "${entry}" '. + [$e]')"
  done <<< "${stats_output}"

  echo "${result}"
}

resource_json="$(capture_resource_usage)"
echo "${resource_json}" > "${TMPDIR}/resources.json"
log_info "Resource usage: captured $(echo "${resource_json}" | jq 'length') container stats"

# ---------------------------------------------------------------------------
# 3. NATS JetStream health
# ---------------------------------------------------------------------------

log_info "Capturing NATS JetStream state"

##
# Fetch NATS monitoring data via docker exec into the aqua-nats container.
# Falls back gracefully if NATS is unreachable.
# @param {string} endpoint - The NATS monitoring endpoint path (e.g. /jsz, /connz).
##
fetch_nats_endpoint() {
  local endpoint="$1"
  if ! is_container_running "aqua-nats"; then
    log_warn "aqua-nats is not running; skipping NATS ${endpoint}"
    echo "{}"
    return
  fi

  docker exec aqua-nats wget -qO- "http://localhost:${NATS_MONITOR_PORT}${endpoint}" 2>/dev/null || {
    log_warn "Failed to reach NATS monitoring endpoint ${endpoint}"
    echo "{}"
  }
}

capture_nats_health() {
  local jsz_raw connz_raw varz_raw

  # JetStream status (streams, consumers, messages)
  jsz_raw="$(fetch_nats_endpoint '/jsz?streams=1&consumers=1')"

  # Connection status (per-service connections)
  connz_raw="$(fetch_nats_endpoint '/connz?subs=1')"

  # Server variables (version, uptime, memory)
  varz_raw="$(fetch_nats_endpoint '/varz')"

  # Extract stream summaries from JetStream data
  local streams_summary
  streams_summary="$(echo "${jsz_raw}" | jq '
    if .streams then
      [.streams[] | {
        name: .name,
        messages: .state.messages,
        bytes: .state.bytes,
        consumerCount: .state.consumer_count,
        firstSeq: .state.first_seq,
        lastSeq: .state.last_seq
      }]
    else
      []
    end
  ' 2>/dev/null || echo "[]")"

  # Extract consumer details (lag is critical for rollback criterion)
  local consumers_summary
  consumers_summary="$(echo "${jsz_raw}" | jq '
    if .streams then
      [.streams[] | .consumers // [] | .[] | {
        stream: .stream_name,
        name: .name,
        numPending: .num_pending,
        numAckPending: .num_ack_pending,
        numRedelivered: .num_redelivered
      }]
    else
      []
    end
  ' 2>/dev/null || echo "[]")"

  # Extract server info
  local server_info
  server_info="$(echo "${varz_raw}" | jq '{
    version: .version,
    uptime: .uptime,
    mem: .mem,
    connections: .connections,
    subscriptions: .subscriptions,
    slowConsumers: .slow_consumers
  }' 2>/dev/null || echo "{}")"

  # Extract connection count per service name
  local connections_by_name
  connections_by_name="$(echo "${connz_raw}" | jq '
    if .connections then
      [.connections | group_by(.name)[] | {
        name: .[0].name,
        count: length,
        totalSubscriptions: (map(.subscriptions) | add)
      }]
    else
      []
    end
  ' 2>/dev/null || echo "[]")"

  jq -n \
    --argjson streams "${streams_summary}" \
    --argjson consumers "${consumers_summary}" \
    --argjson server "${server_info}" \
    --argjson connections "${connections_by_name}" \
    '{
      server: $server,
      streams: $streams,
      consumers: $consumers,
      connections: $connections
    }'
}

nats_json="$(capture_nats_health)"
echo "${nats_json}" > "${TMPDIR}/nats.json"
log_info "NATS: captured $(echo "${nats_json}" | jq '.streams | length') streams, $(echo "${nats_json}" | jq '.consumers | length') consumers"

# ---------------------------------------------------------------------------
# 4. Health endpoint response times
# ---------------------------------------------------------------------------

log_info "Capturing health endpoint latencies (${HEALTH_SAMPLES} samples each)"

##
# Measure response time for a health endpoint inside a container.
# Uses docker exec + wget to avoid host-port mapping requirements.
# Returns latency in milliseconds, or -1 if unreachable.
# @param {string} container - The Docker container name.
# @param {number} port      - The internal port for the health endpoint.
##
measure_health_latency() {
  local container="$1"
  local port="$2"

  if ! is_container_running "${container}"; then
    echo "-1"
    return
  fi

  # Use docker exec to hit health endpoint from inside the container's network.
  # wget --server-response prints timing headers; we parse the wall-clock time.
  local start_ns end_ns elapsed_ms
  start_ns="$(date +%s%N)"

  if docker exec "${container}" wget -qO /dev/null --timeout=5 "http://localhost:${port}/health/live" 2>/dev/null; then
    end_ns="$(date +%s%N)"
    elapsed_ms="$(( (end_ns - start_ns) / 1000000 ))"
    echo "${elapsed_ms}"
  else
    echo "-1"
  fi
}

capture_health_latencies() {
  local result="[]"

  for container in "${BACKEND_CONTAINERS[@]}"; do
    local port="${HEALTH_PORTS[${container}]:-3000}"
    local samples=()
    local failures=0

    for (( i=0; i<HEALTH_SAMPLES; i++ )); do
      local latency
      latency="$(measure_health_latency "${container}" "${port}")"
      if [[ "${latency}" == "-1" ]]; then
        failures=$((failures + 1))
      else
        samples+=("${latency}")
      fi
    done

    # Calculate min/max/avg from collected samples
    local min_ms=0 max_ms=0 avg_ms=0 sample_count=${#samples[@]}

    if [[ ${sample_count} -gt 0 ]]; then
      min_ms="${samples[0]}"
      max_ms="${samples[0]}"
      local total=0
      for s in "${samples[@]}"; do
        total=$((total + s))
        if [[ ${s} -lt ${min_ms} ]]; then min_ms=${s}; fi
        if [[ ${s} -gt ${max_ms} ]]; then max_ms=${s}; fi
      done
      avg_ms=$((total / sample_count))
    fi

    local entry
    entry="$(jq -n \
      --arg container "${container}" \
      --argjson port "${port}" \
      --argjson samples "${sample_count}" \
      --argjson failures "${failures}" \
      --argjson minMs "${min_ms}" \
      --argjson maxMs "${max_ms}" \
      --argjson avgMs "${avg_ms}" \
      '{
        container: $container,
        port: $port,
        endpoint: "/health/live",
        samples: $samples,
        failures: $failures,
        minMs: $minMs,
        maxMs: $maxMs,
        avgMs: $avgMs
      }'
    )"

    result="$(echo "${result}" | jq --argjson e "${entry}" '. + [$e]')"
  done

  echo "${result}"
}

latency_json="$(capture_health_latencies)"
echo "${latency_json}" > "${TMPDIR}/latency.json"
log_info "Health latency: captured $(echo "${latency_json}" | jq 'length') endpoints"

# ---------------------------------------------------------------------------
# 5. Apollo Federation composition check
# ---------------------------------------------------------------------------

log_info "Checking Apollo Federation composition"

##
# Verify the gateway's Apollo Server health and introspection readiness.
# Hits the gateway container's internal health endpoint and the Apollo
# server-health endpoint (if available).
##
capture_federation_status() {
  if ! is_container_running "aqua-gateway"; then
    jq -n '{healthy: false, reason: "aqua-gateway container not running"}'
    return
  fi

  local gateway_health apollo_health
  local gateway_ok=false
  local apollo_ok=false

  # Gateway NestJS health
  if docker exec aqua-gateway wget -qO /dev/null --timeout=5 "http://localhost:3000/health/live" 2>/dev/null; then
    gateway_ok=true
  fi

  # Apollo server health (may not be exposed on all configurations)
  local apollo_response
  apollo_response="$(docker exec aqua-gateway wget -qO- --timeout=5 "http://localhost:3000/.well-known/apollo/server-health" 2>/dev/null || echo "")"

  if [[ -n "${apollo_response}" ]]; then
    apollo_ok=true
  fi

  # Attempt a lightweight introspection query to verify supergraph composition
  local introspection_ok=false
  local introspection_response
  introspection_response="$(docker exec aqua-gateway wget -qO- --timeout=10 \
    --header='Content-Type: application/json' \
    --post-data='{"query":"{ __schema { queryType { name } } }"}' \
    "http://localhost:3000/graphql" 2>/dev/null || echo "")"

  if echo "${introspection_response}" | jq -e '.data.__schema.queryType.name' &>/dev/null; then
    introspection_ok=true
  fi

  # List subgraph URLs from gateway environment for reference
  local subgraph_urls
  subgraph_urls="$(docker inspect aqua-gateway 2>/dev/null | jq -r '
    .[0].Config.Env[]
    | select(test("_SERVICE_URL="))
    | split("=") | {key: .[0], value: .[1]}
  ' 2>/dev/null | jq -s 'from_entries' 2>/dev/null || echo "{}")"

  jq -n \
    --argjson gatewayHealthy "${gateway_ok}" \
    --argjson apolloHealthy "${apollo_ok}" \
    --arg apolloResponse "${apollo_response}" \
    --argjson introspectionOk "${introspection_ok}" \
    --argjson subgraphUrls "${subgraph_urls}" \
    '{
      gatewayHealthy: $gatewayHealthy,
      apolloServerHealthy: $apolloHealthy,
      apolloResponse: $apolloResponse,
      introspectionSuccessful: $introspectionOk,
      subgraphUrls: $subgraphUrls
    }'
}

federation_json="$(capture_federation_status)"
echo "${federation_json}" > "${TMPDIR}/federation.json"
log_info "Federation: gateway=$(echo "${federation_json}" | jq -r '.gatewayHealthy'), introspection=$(echo "${federation_json}" | jq -r '.introspectionSuccessful')"

# ---------------------------------------------------------------------------
# 6. Database connection pool snapshot (bonus: useful for memory analysis)
# ---------------------------------------------------------------------------

log_info "Capturing PostgreSQL connection snapshot"

##
# Query the active PostgreSQL connections grouped by application_name.
# Provides a baseline for connection pool usage per service.
##
capture_postgres_connections() {
  if ! is_container_running "aqua-postgres"; then
    echo "{}"
    return
  fi

  local pg_result
  pg_result="$(docker exec aqua-postgres psql -U aquaculture -d aquaculture -t -A -F $'\t' \
    -c "SELECT application_name, state, count(*) FROM pg_stat_activity WHERE datname = 'aquaculture' GROUP BY application_name, state ORDER BY count DESC;" \
    2>/dev/null || echo "")"

  if [[ -z "${pg_result}" ]]; then
    echo "{\"error\": \"could not query pg_stat_activity\"}"
    return
  fi

  local connections="[]"
  while IFS=$'\t' read -r app_name state count; do
    [[ -z "${app_name}" ]] && continue
    local entry
    entry="$(jq -n \
      --arg appName "${app_name}" \
      --arg state "${state}" \
      --argjson count "${count}" \
      '{applicationName: $appName, state: $state, count: $count}'
    )"
    connections="$(echo "${connections}" | jq --argjson e "${entry}" '. + [$e]')"
  done <<< "${pg_result}"

  local total
  total="$(docker exec aqua-postgres psql -U aquaculture -d aquaculture -t -A \
    -c "SELECT count(*) FROM pg_stat_activity WHERE datname = 'aquaculture';" \
    2>/dev/null || echo "0")"

  local max_conn
  max_conn="$(docker exec aqua-postgres psql -U aquaculture -d aquaculture -t -A \
    -c "SHOW max_connections;" \
    2>/dev/null || echo "unknown")"

  jq -n \
    --argjson connections "${connections}" \
    --argjson totalActive "${total:-0}" \
    --arg maxConnections "${max_conn}" \
    '{
      connections: $connections,
      totalActive: $totalActive,
      maxConnections: $maxConnections
    }'
}

postgres_json="$(capture_postgres_connections)"
echo "${postgres_json}" > "${TMPDIR}/postgres.json"
log_info "PostgreSQL: $(echo "${postgres_json}" | jq '.totalActive // 0') active connections"

# ---------------------------------------------------------------------------
# 7. Redis memory snapshot
# ---------------------------------------------------------------------------

log_info "Capturing Redis memory snapshot"

##
# Capture Redis memory usage and key count for baseline comparison.
##
capture_redis_snapshot() {
  if ! is_container_running "aqua-redis"; then
    echo "{}"
    return
  fi

  local info_memory
  info_memory="$(docker exec aqua-redis redis-cli INFO memory 2>/dev/null || echo "")"

  if [[ -z "${info_memory}" ]]; then
    echo "{\"error\": \"could not query Redis INFO\"}"
    return
  fi

  local used_memory used_memory_peak connected_clients keyspace_info

  used_memory="$(echo "${info_memory}" | grep '^used_memory:' | cut -d: -f2 | tr -d '\r')"
  used_memory_peak="$(echo "${info_memory}" | grep '^used_memory_peak:' | cut -d: -f2 | tr -d '\r')"

  local info_clients
  info_clients="$(docker exec aqua-redis redis-cli INFO clients 2>/dev/null || echo "")"
  connected_clients="$(echo "${info_clients}" | grep '^connected_clients:' | cut -d: -f2 | tr -d '\r')"

  local dbsize
  dbsize="$(docker exec aqua-redis redis-cli DBSIZE 2>/dev/null | grep -oP '\d+' || echo "0")"

  jq -n \
    --arg usedMemory "${used_memory:-0}" \
    --arg usedMemoryPeak "${used_memory_peak:-0}" \
    --arg connectedClients "${connected_clients:-0}" \
    --arg dbSize "${dbsize:-0}" \
    '{
      usedMemoryBytes: ($usedMemory | tonumber),
      usedMemoryPeakBytes: ($usedMemoryPeak | tonumber),
      connectedClients: ($connectedClients | tonumber),
      totalKeys: ($dbSize | tonumber)
    }'
}

redis_json="$(capture_redis_snapshot)"
echo "${redis_json}" > "${TMPDIR}/redis.json"
log_info "Redis: $(echo "${redis_json}" | jq '.totalKeys // 0') keys, $(echo "${redis_json}" | jq '.connectedClients // 0') clients"

# ---------------------------------------------------------------------------
# 8. Assemble final JSON report
# ---------------------------------------------------------------------------

log_info "Assembling baseline report"

# Count healthy vs unhealthy backend containers for the summary
healthy_count="$(echo "${containers_json}" | jq '[.[] | select(.category == "backend" and .healthStatus == "healthy")] | length')"
total_backend="${#BACKEND_CONTAINERS[@]}"

# Compute average health latency across all reachable services
avg_latency="$(echo "${latency_json}" | jq '[.[] | select(.avgMs > 0) | .avgMs] | if length > 0 then (add / length | floor) else 0 end')"

# Build the final report
jq -n \
  --arg capturedAt "${ISO_TIMESTAMP}" \
  --arg phase "${PHASE_LABEL}" \
  --arg hostname "$(hostname)" \
  --arg dockerVersion "$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'unknown')" \
  --argjson healthyBackends "${healthy_count}" \
  --argjson totalBackends "${total_backend}" \
  --argjson avgHealthLatencyMs "${avg_latency}" \
  --slurpfile containers "${TMPDIR}/containers.json" \
  --slurpfile resources "${TMPDIR}/resources.json" \
  --slurpfile nats "${TMPDIR}/nats.json" \
  --slurpfile healthLatency "${TMPDIR}/latency.json" \
  --slurpfile federation "${TMPDIR}/federation.json" \
  --slurpfile postgres "${TMPDIR}/postgres.json" \
  --slurpfile redis "${TMPDIR}/redis.json" \
  '{
    capturedAt: $capturedAt,
    phase: $phase,
    environment: {
      hostname: $hostname,
      dockerVersion: $dockerVersion
    },
    summary: {
      healthyBackends: $healthyBackends,
      totalBackends: $totalBackends,
      avgHealthLatencyMs: $avgHealthLatencyMs,
      natsStreams: ($nats[0].streams | length),
      natsConsumers: ($nats[0].consumers | length),
      federationHealthy: $federation[0].introspectionSuccessful
    },
    containers: $containers[0],
    resources: $resources[0],
    nats: $nats[0],
    healthLatency: $healthLatency[0],
    federation: $federation[0],
    postgres: $postgres[0],
    redis: $redis[0]
  }' > "${OUTFILE}"

# ---------------------------------------------------------------------------
# 9. Validation -- ensure the report is well-formed JSON
# ---------------------------------------------------------------------------

if ! jq empty "${OUTFILE}" 2>/dev/null; then
  log_error "Generated report is not valid JSON: ${OUTFILE}"
  exit 1
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

log_info "================================================="
log_info "Baseline capture complete"
log_info "  Phase:    ${PHASE_LABEL}"
log_info "  File:     ${OUTFILE}"
log_info "  Size:     $(du -h "${OUTFILE}" | cut -f1)"
log_info "  Backends: ${healthy_count}/${total_backend} healthy"
log_info "  Avg latency: ${avg_latency}ms"
log_info "================================================="

# Print a machine-readable one-liner for CI pipelines
echo "${OUTFILE}"
