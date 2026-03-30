#!/usr/bin/env bash
# =============================================================================
# verify-phase.sh -- Post-deploy verification for NestJS v11 phased rollout
#
# Runs automated health, version, restart, and memory checks for each phase
# defined in ADR-013. Exits 0 if all checks pass, 1 if any check fails.
#
# Usage:
#   ./scripts/v11-upgrade/verify-phase.sh <phase-number>   # 1-6
#   ./scripts/v11-upgrade/verify-phase.sh 2
#   ./scripts/v11-upgrade/verify-phase.sh all               # run all phases
#
# Requirements: bash 4+, curl, jq, docker CLI
# Target: DigitalOcean droplet (Ubuntu + Docker)
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Color output helpers
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

pass()  { echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail()  { echo -e "  ${RED}[FAIL]${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn()  { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
info()  { echo -e "  ${CYAN}[INFO]${NC} $1"; }
header() { echo -e "\n${BOLD}=== $1 ===${NC}"; }

FAILURES=0

# ---------------------------------------------------------------------------
# Compose file -- use the droplet compose (production layout)
# ---------------------------------------------------------------------------
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.droplet.yml}"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# ---------------------------------------------------------------------------
# Phase-to-services mapping (ADR-013 section 6)
# ---------------------------------------------------------------------------
# Phase 1 is library-only (no containers to verify), but we still verify the
# monorepo build artifact and basic tooling.
#
# NOTE: event-store-service is listed in ADR-013 Phase 2 but is not yet
# deployed in docker-compose.droplet.yml. The script handles missing
# containers gracefully -- they are reported as WARN, not FAIL.
# ---------------------------------------------------------------------------
declare -A PHASE_SERVICES
PHASE_SERVICES[1]=""  # Phase 1 = libraries only, no containers
PHASE_SERVICES[2]="aqua-observability"
PHASE_SERVICES[3]="aqua-config aqua-notification aqua-billing aqua-alert aqua-hydroponics"
PHASE_SERVICES[4]="aqua-admin-api aqua-hr aqua-messaging"
PHASE_SERVICES[5]="aqua-auth aqua-sensor aqua-farm"
PHASE_SERVICES[6]="aqua-gateway"

# Health endpoint ports for each container (internal port the container listens on)
declare -A HEALTH_PORT
HEALTH_PORT[aqua-gateway]=3000
HEALTH_PORT[aqua-auth]=3000
HEALTH_PORT[aqua-farm]=3000
HEALTH_PORT[aqua-sensor]=3000
HEALTH_PORT[aqua-admin-api]=3000
HEALTH_PORT[aqua-alert]=3000
HEALTH_PORT[aqua-billing]=3000
HEALTH_PORT[aqua-hr]=3000
HEALTH_PORT[aqua-hydroponics]=3000
HEALTH_PORT[aqua-notification]=3000
HEALTH_PORT[aqua-observability]=3009
HEALTH_PORT[aqua-config]=3000
HEALTH_PORT[aqua-messaging]=3000
# event-store-service -- not in droplet compose yet; port assumed 3010 from ADR
HEALTH_PORT[aqua-event-store]=3010

# GHCR image base for version lookup
GHCR_BASE="ghcr.io/okan-wqm/aquaculture_platform"

# Map container name -> compose service name (needed for docker compose commands)
declare -A COMPOSE_SVC
COMPOSE_SVC[aqua-gateway]="gateway-api"
COMPOSE_SVC[aqua-auth]="auth-service"
COMPOSE_SVC[aqua-farm]="farm-service"
COMPOSE_SVC[aqua-sensor]="sensor-service"
COMPOSE_SVC[aqua-admin-api]="admin-api-service"
COMPOSE_SVC[aqua-alert]="alert-engine"
COMPOSE_SVC[aqua-billing]="billing-service"
COMPOSE_SVC[aqua-hr]="hr-service"
COMPOSE_SVC[aqua-hydroponics]="hydroponics-service"
COMPOSE_SVC[aqua-notification]="notification-service"
COMPOSE_SVC[aqua-observability]="observability-service"
COMPOSE_SVC[aqua-config]="config-service"
COMPOSE_SVC[aqua-messaging]="messaging-service"
COMPOSE_SVC[aqua-event-store]="event-store-service"

# Federation subgraph services -- composition must succeed after these are upgraded
SUBGRAPH_SERVICES="aqua-auth aqua-farm aqua-sensor aqua-alert aqua-billing aqua-hr aqua-hydroponics aqua-config aqua-notification aqua-messaging"

# Maximum acceptable restart count (0 = perfect, >0 indicates instability)
MAX_RESTARTS=0

# Maximum acceptable memory percentage of container limit
MAX_MEM_PERCENT=85

# ---------------------------------------------------------------------------
# Utility: resolve container IP on aqua-internal or aqua-network
# ---------------------------------------------------------------------------
get_container_ip() {
  local container="$1"
  # Try aqua-internal first (droplet), then aqua-network (dev)
  local ip
  ip=$(docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container" 2>/dev/null || true)
  echo "$ip"
}

# ---------------------------------------------------------------------------
# Check: container exists and is running
# ---------------------------------------------------------------------------
check_container_running() {
  local container="$1"
  local state
  state=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "missing")
  if [[ "$state" == "running" ]]; then
    pass "$container is running"
    return 0
  else
    fail "$container is NOT running (state: $state)"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# Check: Docker health status (healthy / unhealthy / starting)
# ---------------------------------------------------------------------------
check_docker_health() {
  local container="$1"
  local health
  health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container" 2>/dev/null || echo "missing")
  if [[ "$health" == "healthy" ]]; then
    pass "$container Docker health: healthy"
  elif [[ "$health" == "starting" ]]; then
    warn "$container Docker health: starting (may need more time)"
  else
    fail "$container Docker health: $health"
  fi
}

# ---------------------------------------------------------------------------
# Check: HTTP health endpoint responds 200
# ---------------------------------------------------------------------------
check_health_endpoint() {
  local container="$1"
  local port="${HEALTH_PORT[$container]:-3000}"
  local ip
  ip=$(get_container_ip "$container")

  if [[ -z "$ip" ]]; then
    fail "$container health endpoint -- cannot resolve container IP"
    return
  fi

  local url="http://${ip}:${port}/health/live"
  local http_code
  http_code=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null || echo "000")

  if [[ "$http_code" == "200" ]]; then
    pass "$container /health/live returned HTTP $http_code"
  else
    fail "$container /health/live returned HTTP $http_code (expected 200)"
  fi
}

# ---------------------------------------------------------------------------
# Check: NestJS version from health endpoint (optional -- endpoint may not
# expose version info; treat absence as WARN not FAIL)
# ---------------------------------------------------------------------------
check_nestjs_version() {
  local container="$1"
  local port="${HEALTH_PORT[$container]:-3000}"
  local ip
  ip=$(get_container_ip "$container")

  if [[ -z "$ip" ]]; then
    warn "$container NestJS version -- cannot resolve container IP"
    return
  fi

  local url="http://${ip}:${port}/health/live"
  local body
  body=$(curl -sf --max-time 5 "$url" 2>/dev/null || echo "")

  if [[ -z "$body" ]]; then
    warn "$container NestJS version -- health endpoint did not respond"
    return
  fi

  # Try to extract NestJS version from JSON response (field name varies)
  local version
  version=$(echo "$body" | jq -r '.nestjs // .version // .nestVersion // empty' 2>/dev/null || true)

  if [[ -n "$version" && "$version" != "null" ]]; then
    if [[ "$version" == 11.* ]]; then
      pass "$container reports NestJS v${version}"
    else
      fail "$container reports NestJS v${version} (expected v11.x)"
    fi
  else
    warn "$container health endpoint does not expose NestJS version field"
  fi
}

# ---------------------------------------------------------------------------
# Check: container restart count
# ---------------------------------------------------------------------------
check_restart_count() {
  local container="$1"
  local restarts
  restarts=$(docker inspect --format='{{.RestartCount}}' "$container" 2>/dev/null || echo "-1")

  if [[ "$restarts" == "-1" ]]; then
    fail "$container restart count -- container not found"
    return
  fi

  if [[ "$restarts" -le "$MAX_RESTARTS" ]]; then
    pass "$container restart count: $restarts"
  else
    fail "$container restart count: $restarts (expected <= $MAX_RESTARTS)"
  fi
}

# ---------------------------------------------------------------------------
# Check: memory usage relative to container limit
# ---------------------------------------------------------------------------
check_memory_usage() {
  local container="$1"

  # docker stats --no-stream outputs: CONTAINER ID  NAME  CPU%  MEM USAGE / LIMIT  MEM%  ...
  local stats_line
  stats_line=$(docker stats --no-stream --format "{{.MemUsage}} {{.MemPerc}}" "$container" 2>/dev/null || echo "")

  if [[ -z "$stats_line" ]]; then
    warn "$container memory usage -- could not retrieve stats"
    return
  fi

  local mem_pct
  mem_pct=$(echo "$stats_line" | awk '{print $NF}' | tr -d '%')

  # Handle cases where mem_pct may not be a valid number
  if ! [[ "$mem_pct" =~ ^[0-9]+\.?[0-9]*$ ]]; then
    warn "$container memory usage -- could not parse percentage from: $stats_line"
    return
  fi

  local mem_int
  mem_int=$(printf "%.0f" "$mem_pct")

  info "$container memory: $stats_line"
  if [[ "$mem_int" -lt "$MAX_MEM_PERCENT" ]]; then
    pass "$container memory usage ${mem_pct}% (< ${MAX_MEM_PERCENT}% threshold)"
  else
    fail "$container memory usage ${mem_pct}% (>= ${MAX_MEM_PERCENT}% threshold)"
  fi
}

# ---------------------------------------------------------------------------
# Check: container uptime (started recently = possible crash loop)
# ---------------------------------------------------------------------------
check_uptime() {
  local container="$1"
  local started_at
  started_at=$(docker inspect --format='{{.State.StartedAt}}' "$container" 2>/dev/null || echo "")

  if [[ -z "$started_at" ]]; then
    warn "$container uptime -- cannot read StartedAt"
    return
  fi

  info "$container started at: $started_at"
}

# ---------------------------------------------------------------------------
# Check: recent error logs (last 50 lines, look for ERROR/FATAL/EXCEPTION)
# ---------------------------------------------------------------------------
check_recent_logs() {
  local container="$1"
  local error_count
  error_count=$(docker logs --tail 50 "$container" 2>&1 | grep -ciE '(error|fatal|exception|unhandled|segfault)' || true)

  if [[ "$error_count" -eq 0 ]]; then
    pass "$container no errors in last 50 log lines"
  else
    warn "$container found $error_count error-like entries in last 50 log lines"
    # Show the actual error lines for debugging
    docker logs --tail 50 "$container" 2>&1 | grep -iE '(error|fatal|exception|unhandled|segfault)' | head -5 | while read -r line; do
      echo -e "    ${YELLOW}> ${line}${NC}"
    done
  fi
}

# ---------------------------------------------------------------------------
# Run all standard checks for a single container
# ---------------------------------------------------------------------------
verify_container() {
  local container="$1"

  # Check if container exists at all
  if ! docker inspect "$container" &>/dev/null; then
    warn "$container does not exist (not deployed in current compose file)"
    return
  fi

  check_container_running "$container"
  check_docker_health "$container"
  check_health_endpoint "$container"
  check_nestjs_version "$container"
  check_restart_count "$container"
  check_memory_usage "$container"
  check_uptime "$container"
  check_recent_logs "$container"
}

# ---------------------------------------------------------------------------
# Phase 1: Library / build verification (no containers)
# ---------------------------------------------------------------------------
verify_phase_1() {
  header "Phase 1 -- Foundation (Libraries & Build)"

  info "Phase 1 has no container deployments."
  info "Verifying monorepo build artifacts and tooling."

  # Check that package.json has v11 ranges
  if [[ -f "${PROJECT_ROOT}/package.json" ]]; then
    local nest_core_version
    nest_core_version=$(jq -r '.dependencies["@nestjs/core"] // .devDependencies["@nestjs/core"] // "not-found"' "${PROJECT_ROOT}/package.json" 2>/dev/null || echo "not-found")
    if [[ "$nest_core_version" == *"11"* ]]; then
      pass "package.json @nestjs/core targets v11: $nest_core_version"
    else
      fail "package.json @nestjs/core does not target v11: $nest_core_version"
    fi
  else
    fail "package.json not found at project root"
  fi

  # Check that package-lock.json exists (npm ci depends on it)
  if [[ -f "${PROJECT_ROOT}/package-lock.json" ]]; then
    pass "package-lock.json exists (required for npm ci)"
  else
    fail "package-lock.json missing -- npm ci will fail"
  fi

  # Verify Docker images were tagged as v10-baseline before upgrade
  info "Checking for v10-baseline image tags in GHCR (requires docker/gh auth)..."
  local baseline_missing=0
  for svc in gateway-api auth-service farm-service sensor-service admin-api-service alert-engine billing-service hr-service hydroponics-service notification-service observability-service config-service messaging-service; do
    local tag_exists
    tag_exists=$(docker image inspect "${GHCR_BASE}/${svc}:v10-baseline" &>/dev/null && echo "yes" || echo "no")
    if [[ "$tag_exists" == "yes" ]]; then
      pass "v10-baseline tag exists for $svc (local)"
    else
      warn "v10-baseline tag NOT found locally for $svc -- ensure it exists in GHCR"
      baseline_missing=$((baseline_missing + 1))
    fi
  done

  if [[ "$baseline_missing" -gt 0 ]]; then
    warn "$baseline_missing services missing local v10-baseline tags (may exist in registry)"
  fi
}

# ---------------------------------------------------------------------------
# Phase 2: Canary services
# ---------------------------------------------------------------------------
verify_phase_2() {
  header "Phase 2 -- Canary Services (event-store-service, observability-service)"

  for container in ${PHASE_SERVICES[2]}; do
    header "Verifying: $container"
    verify_container "$container"
  done

  # Phase 2 specific: verify NATS cross-version compatibility
  header "Phase 2 Specific: NATS Cross-Version Check"
  info "Checking NATS server is accessible..."
  local nats_ip
  nats_ip=$(get_container_ip "aqua-nats")
  if [[ -n "$nats_ip" ]]; then
    local nats_health
    nats_health=$(curl -sf --max-time 5 "http://${nats_ip}:8222/varz" 2>/dev/null || echo "")
    if [[ -n "$nats_health" ]]; then
      pass "NATS server is responding on monitoring port"
      local nats_conns
      nats_conns=$(echo "$nats_health" | jq -r '.connections // 0' 2>/dev/null || echo "0")
      info "NATS active connections: $nats_conns"
    else
      warn "NATS monitoring endpoint did not respond (port 8222 may not be exposed)"
    fi
  else
    warn "Cannot resolve aqua-nats container IP"
  fi
}

# ---------------------------------------------------------------------------
# Phase 3: GraphQL subgraph services
# ---------------------------------------------------------------------------
verify_phase_3() {
  header "Phase 3 -- GraphQL Subgraphs"

  for container in ${PHASE_SERVICES[3]}; do
    header "Verifying: $container"
    verify_container "$container"
  done

  # Phase 3 specific: verify Apollo Federation composition
  header "Phase 3 Specific: Federation Composition Check"
  info "Checking if rover CLI is available for supergraph composition..."
  if command -v rover &>/dev/null; then
    if [[ -f "${PROJECT_ROOT}/supergraph-config.yaml" ]]; then
      info "Running rover supergraph compose..."
      if rover supergraph compose --config "${PROJECT_ROOT}/supergraph-config.yaml" --output /dev/null 2>&1; then
        pass "Supergraph composition succeeded"
      else
        fail "Supergraph composition FAILED -- federation is broken"
      fi
    else
      warn "supergraph-config.yaml not found -- skipping composition check"
    fi
  else
    warn "rover CLI not installed -- skipping composition check"
    info "Install: curl -sSL https://rover.apollo.dev/nix/latest | sh"
  fi

  # Verify gateway can still reach all Phase 3 subgraphs
  header "Phase 3 Specific: Gateway Subgraph Reachability"
  local gw_ip
  gw_ip=$(get_container_ip "aqua-gateway")
  if [[ -n "$gw_ip" ]]; then
    local gw_health
    gw_health=$(curl -sf --max-time 5 "http://${gw_ip}:3000/health/live" 2>/dev/null || echo "")
    if [[ -n "$gw_health" ]]; then
      pass "Gateway is healthy (can still compose subgraph schemas)"
    else
      fail "Gateway health check failed -- subgraph composition may be broken"
    fi
  else
    warn "Cannot resolve aqua-gateway IP -- gateway may not be running"
  fi
}

# ---------------------------------------------------------------------------
# Phase 4: Heavy services
# ---------------------------------------------------------------------------
verify_phase_4() {
  header "Phase 4 -- Heavy Services"

  for container in ${PHASE_SERVICES[4]}; do
    header "Verifying: $container"
    verify_container "$container"
  done

  # Phase 4 specific: verify admin-api OpenAPI/Swagger endpoint
  header "Phase 4 Specific: Admin API Swagger Verification"
  local admin_ip
  admin_ip=$(get_container_ip "aqua-admin-api")
  if [[ -n "$admin_ip" ]]; then
    local swagger_status
    swagger_status=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "http://${admin_ip}:3000/api-json" 2>/dev/null || echo "000")
    if [[ "$swagger_status" == "200" ]]; then
      pass "Admin API Swagger JSON endpoint responds (HTTP $swagger_status)"
    else
      warn "Admin API Swagger JSON endpoint returned HTTP $swagger_status (may not be exposed)"
    fi
  else
    warn "Cannot resolve aqua-admin-api IP"
  fi

  # Phase 4 specific: verify messaging-service NATS connectivity
  header "Phase 4 Specific: Messaging Service NATS Check"
  local msg_ip
  msg_ip=$(get_container_ip "aqua-messaging")
  if [[ -n "$msg_ip" ]]; then
    local msg_health
    msg_health=$(curl -sf --max-time 5 "http://${msg_ip}:3000/health/live" 2>/dev/null || echo "")
    if [[ -n "$msg_health" ]]; then
      # Check if health response indicates NATS connectivity
      local nats_ok
      nats_ok=$(echo "$msg_health" | jq -r '.details.nats.status // .nats // "unknown"' 2>/dev/null || echo "unknown")
      if [[ "$nats_ok" == "up" || "$nats_ok" == "ok" || "$nats_ok" == "connected" ]]; then
        pass "Messaging service NATS connectivity: $nats_ok"
      else
        info "Messaging service NATS status from health: $nats_ok (verify manually if 'unknown')"
      fi
    fi
  fi
}

# ---------------------------------------------------------------------------
# Phase 5: Critical services (auth, sensor, farm)
# ---------------------------------------------------------------------------
verify_phase_5() {
  header "Phase 5 -- Critical Services"

  for container in ${PHASE_SERVICES[5]}; do
    header "Verifying: $container"
    verify_container "$container"
  done

  # Phase 5 specific: verify auth JWT flow
  header "Phase 5 Specific: Auth Service JWT Verification"
  local auth_ip
  auth_ip=$(get_container_ip "aqua-auth")
  if [[ -n "$auth_ip" ]]; then
    local auth_graphql
    auth_graphql=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "http://${auth_ip}:3000/graphql" -X POST -H "Content-Type: application/json" -d '{"query":"{ __typename }"}' 2>/dev/null || echo "000")
    if [[ "$auth_graphql" == "200" ]]; then
      pass "Auth service GraphQL endpoint responds (HTTP $auth_graphql)"
    else
      warn "Auth service GraphQL returned HTTP $auth_graphql"
    fi
  fi

  # Phase 5 specific: verify sensor MQTT/NATS pipeline reachability
  header "Phase 5 Specific: Sensor Service Pipeline Check"
  local sensor_ip
  sensor_ip=$(get_container_ip "aqua-sensor")
  if [[ -n "$sensor_ip" ]]; then
    local sensor_health
    sensor_health=$(curl -sf --max-time 5 "http://${sensor_ip}:3000/health/live" 2>/dev/null || echo "")
    if [[ -n "$sensor_health" ]]; then
      local mqtt_ok
      mqtt_ok=$(echo "$sensor_health" | jq -r '.details.mqtt.status // .mqtt // "unknown"' 2>/dev/null || echo "unknown")
      local nats_ok
      nats_ok=$(echo "$sensor_health" | jq -r '.details.nats.status // .nats // "unknown"' 2>/dev/null || echo "unknown")
      info "Sensor service MQTT: $mqtt_ok, NATS: $nats_ok"
    fi
  fi

  # Phase 5 specific: verify farm service subgraph
  header "Phase 5 Specific: Farm Service Subgraph Check"
  local farm_ip
  farm_ip=$(get_container_ip "aqua-farm")
  if [[ -n "$farm_ip" ]]; then
    local farm_graphql
    farm_graphql=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "http://${farm_ip}:3000/graphql" -X POST -H "Content-Type: application/json" -d '{"query":"{ __typename }"}' 2>/dev/null || echo "000")
    if [[ "$farm_graphql" == "200" ]]; then
      pass "Farm service GraphQL endpoint responds (HTTP $farm_graphql)"
    else
      warn "Farm service GraphQL returned HTTP $farm_graphql"
    fi
  fi

  # Phase 5 specific: run supergraph composition (all critical subgraphs now v11)
  header "Phase 5 Specific: Full Subgraph Composition"
  if command -v rover &>/dev/null && [[ -f "${PROJECT_ROOT}/supergraph-config.yaml" ]]; then
    if rover supergraph compose --config "${PROJECT_ROOT}/supergraph-config.yaml" --output /dev/null 2>&1; then
      pass "Supergraph composition with all v11 subgraphs succeeded"
    else
      fail "Supergraph composition FAILED after Phase 5"
    fi
  else
    warn "Skipping composition check (rover not installed or config missing)"
  fi
}

# ---------------------------------------------------------------------------
# Phase 6: Gateway (the big one)
# ---------------------------------------------------------------------------
verify_phase_6() {
  header "Phase 6 -- Gateway"

  for container in ${PHASE_SERVICES[6]}; do
    header "Verifying: $container"
    verify_container "$container"
  done

  local gw_ip
  gw_ip=$(get_container_ip "aqua-gateway")

  if [[ -z "$gw_ip" ]]; then
    fail "Cannot resolve aqua-gateway container IP"
    return
  fi

  # Phase 6 specific: verify Express v5 trust proxy / req.ip
  header "Phase 6 Specific: Gateway Middleware Verification"

  # Check security headers (helmet)
  local headers
  headers=$(curl -sf -D - -o /dev/null --max-time 5 "http://${gw_ip}:3000/health/live" 2>/dev/null || echo "")
  if [[ -n "$headers" ]]; then
    if echo "$headers" | grep -qi "x-frame-options"; then
      pass "Gateway returns X-Frame-Options header (helmet active)"
    else
      warn "Gateway missing X-Frame-Options header -- verify helmet config"
    fi
    if echo "$headers" | grep -qi "strict-transport-security"; then
      pass "Gateway returns Strict-Transport-Security header"
    else
      info "Gateway missing HSTS header (may be set by nginx instead)"
    fi
    if echo "$headers" | grep -qi "x-content-type-options"; then
      pass "Gateway returns X-Content-Type-Options header"
    else
      warn "Gateway missing X-Content-Type-Options header"
    fi
  else
    fail "Could not retrieve gateway response headers"
  fi

  # Phase 6 specific: verify GraphQL endpoint
  header "Phase 6 Specific: Gateway GraphQL / Federation"
  local gql_status
  gql_status=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "http://${gw_ip}:3000/graphql" -X POST -H "Content-Type: application/json" -d '{"query":"{ __typename }"}' 2>/dev/null || echo "000")
  if [[ "$gql_status" == "200" ]]; then
    pass "Gateway GraphQL endpoint responds (HTTP $gql_status)"
  elif [[ "$gql_status" == "400" || "$gql_status" == "401" ]]; then
    info "Gateway GraphQL returned HTTP $gql_status (auth required -- expected for protected endpoint)"
  else
    fail "Gateway GraphQL returned HTTP $gql_status (expected 200 or 401)"
  fi

  # Phase 6 specific: verify WebSocket upgrade capability
  header "Phase 6 Specific: WebSocket Check"
  # Simple check -- attempt to connect to the socket.io endpoint
  local ws_status
  ws_status=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 5 "http://${gw_ip}:3000/socket.io/?EIO=4&transport=polling" 2>/dev/null || echo "000")
  if [[ "$ws_status" == "200" || "$ws_status" == "400" ]]; then
    pass "Socket.IO endpoint is reachable (HTTP $ws_status)"
  else
    warn "Socket.IO endpoint returned HTTP $ws_status"
  fi

  # Phase 6 specific: verify all subgraph services are still healthy
  header "Phase 6 Specific: All Subgraph Health Sweep"
  for container in $SUBGRAPH_SERVICES; do
    if docker inspect "$container" &>/dev/null; then
      local sub_health
      sub_health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container" 2>/dev/null || echo "missing")
      if [[ "$sub_health" == "healthy" ]]; then
        pass "$container subgraph: healthy"
      else
        fail "$container subgraph: $sub_health"
      fi
    fi
  done

  # Phase 6 specific: external access through nginx
  header "Phase 6 Specific: Nginx Reverse Proxy"
  if docker inspect aqua-nginx &>/dev/null; then
    local nginx_health
    nginx_health=$(docker inspect --format='{{.State.Status}}' "aqua-nginx" 2>/dev/null || echo "missing")
    if [[ "$nginx_health" == "running" ]]; then
      pass "aqua-nginx is running"
    else
      fail "aqua-nginx is NOT running (state: $nginx_health)"
    fi
  else
    warn "aqua-nginx container not found -- may use external proxy"
  fi
}

# ---------------------------------------------------------------------------
# Summary report
# ---------------------------------------------------------------------------
print_summary() {
  header "VERIFICATION SUMMARY"
  if [[ "$FAILURES" -eq 0 ]]; then
    echo -e "\n${GREEN}${BOLD}  ALL CHECKS PASSED${NC}\n"
  else
    echo -e "\n${RED}${BOLD}  $FAILURES CHECK(S) FAILED${NC}\n"
    echo -e "  Review failures above. Consult ADR-013 section 7 for rollback criteria."
    echo -e "  Rollback command: ./scripts/v11-upgrade/rollback-phase.sh <phase>\n"
  fi
}

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 <phase-number|all>"
  echo "  phase-number: 1-6 (per ADR-013)"
  echo "  all:          run all phases sequentially"
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

PHASE="$1"

echo -e "${BOLD}NestJS v11 Phase Verification (ADR-013)${NC}"
echo -e "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo -e "Compose file: ${COMPOSE_FILE}"
echo ""

case "$PHASE" in
  1) verify_phase_1 ;;
  2) verify_phase_2 ;;
  3) verify_phase_3 ;;
  4) verify_phase_4 ;;
  5) verify_phase_5 ;;
  6) verify_phase_6 ;;
  all)
    for p in 1 2 3 4 5 6; do
      "verify_phase_${p}"
    done
    ;;
  *)
    echo -e "${RED}Error: Invalid phase '$PHASE'. Must be 1-6 or 'all'.${NC}"
    usage
    ;;
esac

print_summary
exit $((FAILURES > 0 ? 1 : 0))
