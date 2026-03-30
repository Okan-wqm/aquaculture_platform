#!/usr/bin/env bash
# =============================================================================
# check-federation-compose.sh -- Apollo Federation subgraph health & version
#                                 checker for NestJS v11 migration
#
# Reads the gateway's federated subgraph configuration, checks each subgraph's
# health, attempts GraphQL introspection, and reports which subgraphs are
# running NestJS v10 vs v11.  This enables operators to verify that a phased
# migration (ADR-013) is progressing correctly without breaking federation
# composition.
#
# Usage:
#   ./scripts/v11-upgrade/check-federation-compose.sh
#   ./scripts/v11-upgrade/check-federation-compose.sh --timeout 10
#   ./scripts/v11-upgrade/check-federation-compose.sh --json
#
# Requirements: bash 4+, curl, jq, docker CLI
# Target: DigitalOcean droplet (Ubuntu + Docker)
# Ref: ADR-013, ARCH-GW-005
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Color output helpers (consistent with verify-phase.sh)
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

pass()   { echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail()   { echo -e "  ${RED}[FAIL]${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn()   { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
info()   { echo -e "  ${CYAN}[INFO]${NC} $1"; }
header() { echo -e "\n${BOLD}=== $1 ===${NC}"; }

FAILURES=0

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Resolve project root from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# Gateway container name (from docker-compose.droplet.yml)
GATEWAY_CONTAINER="aqua-gateway"

# HTTP timeout for health and introspection requests (seconds)
HTTP_TIMEOUT=5

# Whether to output JSON instead of human-readable text
JSON_OUTPUT=false

# ---------------------------------------------------------------------------
# Subgraph registry
#
# Mirrors the subgraph list in apps/gateway-api/src/app.module.ts
# (RetryableIntrospectAndCompose).
#
# Format: name|env_var|default_url|container_name
#
# IMPORTANT: Keep this in sync with app.module.ts ARCH-GW-005.
# If you add a subgraph there, add it here too.
# ---------------------------------------------------------------------------
SUBGRAPHS=(
  "auth|AUTH_SERVICE_URL|http://auth-service:3000/graphql|aqua-auth"
  "farm|FARM_SERVICE_URL|http://farm-service:3000/graphql|aqua-farm"
  "sensor|SENSOR_SERVICE_URL|http://sensor-service:3000/graphql|aqua-sensor"
  "alert|ALERT_SERVICE_URL|http://alert-engine:3000/graphql|aqua-alert"
  "hr|HR_SERVICE_URL|http://hr-service:3000/graphql|aqua-hr"
  "billing|BILLING_SERVICE_URL|http://billing-service:3000/graphql|aqua-billing"
  "hydroponics|HYDROPONICS_SERVICE_URL|http://hydroponics-service:3000/graphql|aqua-hydroponics"
  "config|CONFIG_SERVICE_URL|http://config-service:3000/graphql|aqua-config"
  "notification|NOTIFICATION_SERVICE_URL|http://notification-service:3000/graphql|aqua-notification"
  "messaging|MESSAGING_SERVICE_URL|http://messaging-service:3000/graphql|aqua-messaging"
)

# Health check ports per container (internal ports, not host-mapped)
declare -A HEALTH_PORTS=(
  [aqua-auth]=3000
  [aqua-farm]=3000
  [aqua-sensor]=3000
  [aqua-alert]=3000
  [aqua-hr]=3000
  [aqua-billing]=3000
  [aqua-hydroponics]=3000
  [aqua-config]=3000
  [aqua-notification]=3000
  [aqua-messaging]=3000
  [aqua-gateway]=3000
)

# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)
      HTTP_TIMEOUT="$2"
      shift 2
      ;;
    --json)
      JSON_OUTPUT=true
      shift
      ;;
    --help|-h)
      echo "Usage: $0 [--timeout <seconds>] [--json]"
      echo ""
      echo "Options:"
      echo "  --timeout   HTTP request timeout in seconds (default: 5)"
      echo "  --json      Output results as JSON (for CI integration)"
      exit 0
      ;;
    *)
      echo -e "${RED}Error: Unknown argument: $1${NC}" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Utility functions
# ---------------------------------------------------------------------------

##
# Resolve the internal Docker network IP of a container.
# Returns the IP address or empty string if not resolvable.
# @param {string} container - Docker container name
##
get_container_ip() {
  local container="$1"
  docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
    "${container}" 2>/dev/null || echo ""
}

##
# Check if a Docker container is running.
# @param {string} container - Docker container name
# @return 0 if running, 1 otherwise
##
is_running() {
  local state
  state=$(docker inspect --format='{{.State.Status}}' "$1" 2>/dev/null || echo "missing")
  [[ "${state}" == "running" ]]
}

##
# Extract the NestJS version from a container's node_modules.
# Reads the @nestjs/core package.json version field.
# @param {string} container - Docker container name
# @return version string (e.g., "10.4.15") or "unknown"
##
get_nestjs_version() {
  local container="$1"

  # Strategy 1: Read @nestjs/core package.json version from inside the container
  local version
  version=$(docker exec "${container}" \
    node -e "try { console.log(require('@nestjs/core/package.json').version) } catch(e) { console.log('unknown') }" \
    2>/dev/null || echo "unknown")

  echo "${version}"
}

##
# Classify a NestJS version string into "v10", "v11", or "other".
# @param {string} version - Semantic version string
# @return "v10", "v11", or "other"
##
classify_version() {
  local version="$1"
  case "${version}" in
    10.*) echo "v10" ;;
    11.*) echo "v11" ;;
    unknown) echo "unknown" ;;
    *) echo "other (${version})" ;;
  esac
}

##
# Attempt a GraphQL introspection query against a subgraph endpoint.
# Uses the container's internal Docker network IP to reach the service.
# @param {string} ip   - Container IP address
# @param {number} port - GraphQL port (typically 3000)
# @return "ok" if introspection succeeds, "fail" otherwise
##
check_introspection() {
  local ip="$1"
  local port="$2"

  local response
  response=$(curl -sf --max-time "${HTTP_TIMEOUT}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d '{"query":"{ __schema { queryType { name } mutationType { name } subscriptionType { name } } }"}' \
    "http://${ip}:${port}/graphql" 2>/dev/null || echo "")

  if [[ -z "${response}" ]]; then
    echo "fail:no_response"
    return
  fi

  # Check for valid introspection data
  local query_type
  query_type=$(echo "${response}" | jq -r '.data.__schema.queryType.name // empty' 2>/dev/null || true)

  if [[ -n "${query_type}" ]]; then
    echo "ok"
  else
    # Check for error responses (auth required, introspection disabled, etc.)
    local error_msg
    error_msg=$(echo "${response}" | jq -r '.errors[0].message // empty' 2>/dev/null || true)
    if [[ -n "${error_msg}" ]]; then
      echo "fail:${error_msg:0:60}"
    else
      echo "fail:invalid_response"
    fi
  fi
}

##
# Check the health endpoint of a subgraph container.
# @param {string} ip   - Container IP address
# @param {number} port - Health endpoint port
# @return HTTP status code or "000" if unreachable
##
check_health() {
  local ip="$1"
  local port="$2"

  curl -sf -o /dev/null -w "%{http_code}" --max-time "${HTTP_TIMEOUT}" \
    "http://${ip}:${port}/health/live" 2>/dev/null || echo "000"
}

##
# Detect the @apollo/subgraph or @apollo/federation version from a container.
# Helps distinguish Apollo Federation v1 vs v2.
# @param {string} container - Docker container name
# @return version string or "not-found"
##
get_apollo_subgraph_version() {
  local container="$1"

  # Try @apollo/subgraph (Federation v2) first
  local version
  version=$(docker exec "${container}" \
    node -e "try { console.log(require('@apollo/subgraph/package.json').version) } catch(e) { console.log('not-found') }" \
    2>/dev/null || echo "not-found")

  if [[ "${version}" == "not-found" ]]; then
    # Fallback: try @apollo/federation (Federation v1)
    version=$(docker exec "${container}" \
      node -e "try { console.log(require('@apollo/federation/package.json').version) } catch(e) { console.log('not-found') }" \
      2>/dev/null || echo "not-found")
  fi

  echo "${version}"
}

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
if [[ "${JSON_OUTPUT}" == false ]]; then
  echo -e "${BOLD}Apollo Federation Subgraph Health & Version Check (ADR-013)${NC}"
  echo -e "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  echo -e "Gateway container: ${GATEWAY_CONTAINER}"
  echo -e "HTTP timeout: ${HTTP_TIMEOUT}s"
  echo ""
fi

# ---------------------------------------------------------------------------
# Step 1: Verify gateway container is running
# ---------------------------------------------------------------------------
if [[ "${JSON_OUTPUT}" == false ]]; then
  header "Step 1: Gateway Status"
fi

GATEWAY_IP=""
GATEWAY_HEALTHY=false

if is_running "${GATEWAY_CONTAINER}"; then
  GATEWAY_IP=$(get_container_ip "${GATEWAY_CONTAINER}")
  if [[ -n "${GATEWAY_IP}" ]]; then
    local_health=$(check_health "${GATEWAY_IP}" "${HEALTH_PORTS[${GATEWAY_CONTAINER}]}")
    if [[ "${local_health}" == "200" ]]; then
      GATEWAY_HEALTHY=true
      if [[ "${JSON_OUTPUT}" == false ]]; then
        pass "${GATEWAY_CONTAINER} is running and healthy (IP: ${GATEWAY_IP})"
      fi
    else
      if [[ "${JSON_OUTPUT}" == false ]]; then
        fail "${GATEWAY_CONTAINER} is running but health check returned HTTP ${local_health}"
      fi
    fi
  else
    if [[ "${JSON_OUTPUT}" == false ]]; then
      fail "${GATEWAY_CONTAINER} is running but IP could not be resolved"
    fi
  fi
else
  if [[ "${JSON_OUTPUT}" == false ]]; then
    fail "${GATEWAY_CONTAINER} is NOT running"
    warn "Gateway must be running for federation composition to work."
    warn "Subgraph checks will still run using container-direct access."
  fi
fi

# Get the gateway's own NestJS version for reference
GATEWAY_NEST_VERSION="unknown"
if is_running "${GATEWAY_CONTAINER}"; then
  GATEWAY_NEST_VERSION=$(get_nestjs_version "${GATEWAY_CONTAINER}")
fi

if [[ "${JSON_OUTPUT}" == false ]]; then
  info "Gateway NestJS version: ${GATEWAY_NEST_VERSION} ($(classify_version "${GATEWAY_NEST_VERSION}"))"
fi

# ---------------------------------------------------------------------------
# Step 2: Read actual subgraph URLs from gateway environment
# ---------------------------------------------------------------------------
if [[ "${JSON_OUTPUT}" == false ]]; then
  header "Step 2: Resolve Subgraph URLs from Gateway Environment"
fi

# Build a map of env_var -> actual_url from the gateway container's environment
declare -A RESOLVED_URLS

if is_running "${GATEWAY_CONTAINER}"; then
  # Extract all *_SERVICE_URL environment variables from the gateway container
  while IFS='=' read -r key value; do
    if [[ -n "${key}" && -n "${value}" ]]; then
      RESOLVED_URLS["${key}"]="${value}"
    fi
  done < <(docker inspect "${GATEWAY_CONTAINER}" 2>/dev/null \
    | jq -r '.[0].Config.Env[] | select(test("_SERVICE_URL="))' 2>/dev/null \
    | sed 's/=/ /' | awk '{print $1"="substr($0, index($0,$2))}' || true)

  if [[ "${JSON_OUTPUT}" == false ]]; then
    info "Resolved ${#RESOLVED_URLS[@]} service URLs from gateway environment"
  fi
else
  if [[ "${JSON_OUTPUT}" == false ]]; then
    warn "Gateway not running; using default URLs from subgraph registry"
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Check each subgraph
# ---------------------------------------------------------------------------
if [[ "${JSON_OUTPUT}" == false ]]; then
  header "Step 3: Subgraph Health, Introspection & Version"
fi

# Counters for the summary
V10_COUNT=0
V11_COUNT=0
UNKNOWN_COUNT=0
HEALTHY_COUNT=0
UNHEALTHY_COUNT=0
INTROSPECTION_OK_COUNT=0
INTROSPECTION_FAIL_COUNT=0

# JSON array for --json output
JSON_RESULTS="[]"

for entry in "${SUBGRAPHS[@]}"; do
  IFS='|' read -r name env_var default_url container <<< "${entry}"

  # Resolve the actual URL (from gateway env or default)
  url="${RESOLVED_URLS[${env_var}]:-${default_url}}"
  port="${HEALTH_PORTS[${container}]:-3000}"

  if [[ "${JSON_OUTPUT}" == false ]]; then
    echo ""
    echo -e "  ${BOLD}${name}${NC} (${container})"
    echo -e "  ${DIM}URL: ${url}${NC}"
  fi

  # Check if the container exists and is running
  sg_running=false
  sg_ip=""
  sg_health_status="unreachable"
  sg_introspection="skipped"
  sg_nest_version="unknown"
  sg_nest_class="unknown"
  sg_apollo_version="not-found"

  if is_running "${container}"; then
    sg_running=true
    sg_ip=$(get_container_ip "${container}")

    if [[ -n "${sg_ip}" ]]; then
      # Health check
      http_code=$(check_health "${sg_ip}" "${port}")
      if [[ "${http_code}" == "200" ]]; then
        sg_health_status="healthy"
        HEALTHY_COUNT=$((HEALTHY_COUNT + 1))
        if [[ "${JSON_OUTPUT}" == false ]]; then
          pass "Health: HTTP ${http_code}"
        fi
      else
        sg_health_status="unhealthy (HTTP ${http_code})"
        UNHEALTHY_COUNT=$((UNHEALTHY_COUNT + 1))
        if [[ "${JSON_OUTPUT}" == false ]]; then
          fail "Health: HTTP ${http_code}"
        fi
      fi

      # Introspection check
      introspection_result=$(check_introspection "${sg_ip}" "${port}")
      if [[ "${introspection_result}" == "ok" ]]; then
        sg_introspection="ok"
        INTROSPECTION_OK_COUNT=$((INTROSPECTION_OK_COUNT + 1))
        if [[ "${JSON_OUTPUT}" == false ]]; then
          pass "Introspection: successful"
        fi
      else
        sg_introspection="${introspection_result}"
        INTROSPECTION_FAIL_COUNT=$((INTROSPECTION_FAIL_COUNT + 1))
        if [[ "${JSON_OUTPUT}" == false ]]; then
          warn "Introspection: ${introspection_result}"
        fi
      fi
    else
      UNHEALTHY_COUNT=$((UNHEALTHY_COUNT + 1))
      if [[ "${JSON_OUTPUT}" == false ]]; then
        fail "Cannot resolve container IP for ${container}"
      fi
    fi

    # NestJS version detection (via node_modules inside container)
    sg_nest_version=$(get_nestjs_version "${container}")
    sg_nest_class=$(classify_version "${sg_nest_version}")

    case "${sg_nest_class}" in
      v10) V10_COUNT=$((V10_COUNT + 1)) ;;
      v11) V11_COUNT=$((V11_COUNT + 1)) ;;
      *)   UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1)) ;;
    esac

    if [[ "${JSON_OUTPUT}" == false ]]; then
      case "${sg_nest_class}" in
        v10)
          warn "NestJS: ${sg_nest_version} (v10 -- not yet migrated)"
          ;;
        v11)
          pass "NestJS: ${sg_nest_version} (v11 -- migrated)"
          ;;
        *)
          info "NestJS: ${sg_nest_version} (${sg_nest_class})"
          ;;
      esac
    fi

    # Apollo subgraph library version
    sg_apollo_version=$(get_apollo_subgraph_version "${container}")
    if [[ "${JSON_OUTPUT}" == false && "${sg_apollo_version}" != "not-found" ]]; then
      info "Apollo subgraph: ${sg_apollo_version}"
    fi

  else
    UNHEALTHY_COUNT=$((UNHEALTHY_COUNT + 1))
    UNKNOWN_COUNT=$((UNKNOWN_COUNT + 1))
    if [[ "${JSON_OUTPUT}" == false ]]; then
      fail "Container ${container} is NOT running"
    fi
  fi

  # Append to JSON results array
  JSON_RESULTS=$(echo "${JSON_RESULTS}" | jq \
    --arg name "${name}" \
    --arg container "${container}" \
    --arg url "${url}" \
    --argjson running "${sg_running}" \
    --arg healthStatus "${sg_health_status}" \
    --arg introspection "${sg_introspection}" \
    --arg nestVersion "${sg_nest_version}" \
    --arg nestClass "${sg_nest_class}" \
    --arg apolloVersion "${sg_apollo_version}" \
    '. + [{
      name: $name,
      container: $container,
      url: $url,
      running: $running,
      healthStatus: $healthStatus,
      introspection: $introspection,
      nestjsVersion: $nestVersion,
      nestjsClass: $nestClass,
      apolloSubgraphVersion: $apolloVersion
    }]')
done

# ---------------------------------------------------------------------------
# Step 4: Federation composition test (via gateway)
# ---------------------------------------------------------------------------
if [[ "${JSON_OUTPUT}" == false ]]; then
  header "Step 4: Federation Composition Test"
fi

COMPOSITION_OK=false

if [[ "${GATEWAY_HEALTHY}" == true && -n "${GATEWAY_IP}" ]]; then
  # Send an introspection query to the gateway to verify supergraph composition
  gw_introspection=$(curl -sf --max-time "${HTTP_TIMEOUT}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d '{"query":"{ __schema { queryType { name } types { name } } }"}' \
    "http://${GATEWAY_IP}:${HEALTH_PORTS[${GATEWAY_CONTAINER}]}/graphql" 2>/dev/null || echo "")

  if [[ -n "${gw_introspection}" ]]; then
    query_type=$(echo "${gw_introspection}" | jq -r '.data.__schema.queryType.name // empty' 2>/dev/null || true)
    type_count=$(echo "${gw_introspection}" | jq '.data.__schema.types | length // 0' 2>/dev/null || echo "0")

    if [[ -n "${query_type}" ]]; then
      COMPOSITION_OK=true
      if [[ "${JSON_OUTPUT}" == false ]]; then
        pass "Supergraph composition is intact (${type_count} types in schema)"
        info "Query root type: ${query_type}"
      fi
    else
      error_msg=$(echo "${gw_introspection}" | jq -r '.errors[0].message // "unknown error"' 2>/dev/null || true)
      if [[ "${JSON_OUTPUT}" == false ]]; then
        fail "Supergraph introspection failed: ${error_msg}"
      fi
    fi
  else
    if [[ "${JSON_OUTPUT}" == false ]]; then
      fail "Gateway GraphQL endpoint did not respond"
    fi
  fi
else
  if [[ "${JSON_OUTPUT}" == false ]]; then
    warn "Skipping composition test (gateway not healthy)"
  fi
fi

# ---------------------------------------------------------------------------
# Step 5: Summary
# ---------------------------------------------------------------------------

TOTAL_SUBGRAPHS=${#SUBGRAPHS[@]}

if [[ "${JSON_OUTPUT}" == true ]]; then
  # Structured JSON output for CI/CD pipelines
  jq -n \
    --arg timestamp "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
    --arg gatewayNestVersion "${GATEWAY_NEST_VERSION}" \
    --argjson gatewayHealthy "${GATEWAY_HEALTHY}" \
    --argjson compositionOk "${COMPOSITION_OK}" \
    --argjson totalSubgraphs "${TOTAL_SUBGRAPHS}" \
    --argjson v10Count "${V10_COUNT}" \
    --argjson v11Count "${V11_COUNT}" \
    --argjson unknownCount "${UNKNOWN_COUNT}" \
    --argjson healthyCount "${HEALTHY_COUNT}" \
    --argjson unhealthyCount "${UNHEALTHY_COUNT}" \
    --argjson introspectionOk "${INTROSPECTION_OK_COUNT}" \
    --argjson introspectionFail "${INTROSPECTION_FAIL_COUNT}" \
    --argjson failures "${FAILURES}" \
    --argjson subgraphs "${JSON_RESULTS}" \
    '{
      timestamp: $timestamp,
      gateway: {
        nestjsVersion: $gatewayNestVersion,
        healthy: $gatewayHealthy,
        compositionOk: $compositionOk
      },
      summary: {
        totalSubgraphs: $totalSubgraphs,
        v10: $v10Count,
        v11: $v11Count,
        unknown: $unknownCount,
        healthy: $healthyCount,
        unhealthy: $unhealthyCount,
        introspectionOk: $introspectionOk,
        introspectionFail: $introspectionFail,
        failures: $failures
      },
      subgraphs: $subgraphs
    }'
  exit $((FAILURES > 0 ? 1 : 0))
fi

header "FEDERATION COMPOSITION SUMMARY"

echo ""
echo -e "  ${BOLD}Migration Progress:${NC}"
echo ""

# Build a visual progress bar
MIGRATED_PERCENT=0
if [[ "${TOTAL_SUBGRAPHS}" -gt 0 ]]; then
  MIGRATED_PERCENT=$((V11_COUNT * 100 / TOTAL_SUBGRAPHS))
fi

# Visual bar (20 chars wide)
BAR_WIDTH=20
FILLED=$((MIGRATED_PERCENT * BAR_WIDTH / 100))
EMPTY=$((BAR_WIDTH - FILLED))
BAR="${GREEN}"
for (( i=0; i<FILLED; i++ )); do BAR+="█"; done
BAR+="${DIM}"
for (( i=0; i<EMPTY; i++ )); do BAR+="░"; done
BAR+="${NC}"

echo -e "  ${BAR} ${MIGRATED_PERCENT}% migrated to v11"
echo ""
echo -e "  ${CYAN}v11 (migrated):${NC}     ${V11_COUNT}/${TOTAL_SUBGRAPHS}"
echo -e "  ${YELLOW}v10 (pending):${NC}      ${V10_COUNT}/${TOTAL_SUBGRAPHS}"
if [[ "${UNKNOWN_COUNT}" -gt 0 ]]; then
  echo -e "  ${RED}Unknown:${NC}            ${UNKNOWN_COUNT}/${TOTAL_SUBGRAPHS}"
fi
echo ""
echo -e "  ${BOLD}Health:${NC}"
echo -e "    Healthy:          ${HEALTHY_COUNT}/${TOTAL_SUBGRAPHS}"
echo -e "    Unhealthy:        ${UNHEALTHY_COUNT}/${TOTAL_SUBGRAPHS}"
echo ""
echo -e "  ${BOLD}Introspection:${NC}"
echo -e "    Successful:       ${INTROSPECTION_OK_COUNT}/${TOTAL_SUBGRAPHS}"
echo -e "    Failed:           ${INTROSPECTION_FAIL_COUNT}/${TOTAL_SUBGRAPHS}"
echo ""
echo -e "  ${BOLD}Federation:${NC}"

if [[ "${COMPOSITION_OK}" == true ]]; then
  echo -e "    Composition:      ${GREEN}INTACT${NC}"
else
  echo -e "    Composition:      ${RED}BROKEN${NC}"
fi

echo -e "    Gateway version:  ${GATEWAY_NEST_VERSION} ($(classify_version "${GATEWAY_NEST_VERSION}"))"
echo ""

# Final verdict
if [[ "${FAILURES}" -eq 0 && "${COMPOSITION_OK}" == true ]]; then
  echo -e "${GREEN}${BOLD}  ALL CHECKS PASSED${NC}\n"
  exit 0
elif [[ "${COMPOSITION_OK}" == true ]]; then
  echo -e "${YELLOW}${BOLD}  ${FAILURES} CHECK(S) FAILED -- composition still intact${NC}"
  echo -e "  ${YELLOW}Review failures above. Federation is functional but degraded.${NC}\n"
  exit 1
else
  echo -e "${RED}${BOLD}  FEDERATION COMPOSITION IS BROKEN${NC}"
  echo -e "  ${RED}Immediate action required. Consult ADR-013 section 7 for rollback.${NC}"
  echo -e "  ${RED}Rollback: ./scripts/v11-upgrade/rollback-phase.sh <phase>${NC}\n"
  exit 1
fi
