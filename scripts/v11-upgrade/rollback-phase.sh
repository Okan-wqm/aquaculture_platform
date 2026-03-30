#!/usr/bin/env bash
# =============================================================================
# rollback-phase.sh -- Roll back a NestJS v11 upgrade phase to v10-baseline
#
# Reverts all services in the given phase to their pre-upgrade Docker images.
# Does NOT build new images -- uses pre-tagged v10-baseline images from GHCR.
#
# ADR-013 section 7: "Rollback means deploying pre-existing Docker images
# (tagged with pre-upgrade SHA or v10-baseline), NOT building new images
# from a reverted branch."
#
# Usage:
#   ./scripts/v11-upgrade/rollback-phase.sh <phase-number>        # 2-6
#   ./scripts/v11-upgrade/rollback-phase.sh <phase-number> --dry   # preview only
#   ./scripts/v11-upgrade/rollback-phase.sh <phase-number> --sha <git-sha>
#
# Requirements: bash 4+, docker CLI, curl
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
NC='\033[0m'

pass()   { echo -e "  ${GREEN}[PASS]${NC} $1"; }
fail()   { echo -e "  ${RED}[FAIL]${NC} $1"; FAILURES=$((FAILURES + 1)); }
warn()   { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
info()   { echo -e "  ${CYAN}[INFO]${NC} $1"; }
header() { echo -e "\n${BOLD}=== $1 ===${NC}"; }
step()   { echo -e "\n${CYAN}>>> $1${NC}"; }

FAILURES=0

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.droplet.yml}"
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GHCR_BASE="ghcr.io/okan-wqm/aquaculture_platform"

# Default rollback tag -- pre-upgrade images tagged during Phase 1 prep
DEFAULT_TAG="v10-baseline"

# ---------------------------------------------------------------------------
# Phase-to-GHCR image name mapping (ADR-013 section 6)
#
# Keys: compose service names used by docker compose
# Values: GHCR image path suffixes
# ---------------------------------------------------------------------------
declare -A PHASE_IMAGES

# Phase 2: Canary services
# NOTE: event-store-service is in ADR-013 Phase 2 but not in droplet compose.
# It is included here for forward compatibility.
PHASE_IMAGES[2]="observability-service"

# Phase 3: GraphQL subgraph services
PHASE_IMAGES[3]="config-service notification-service billing-service alert-engine hydroponics-service"

# Phase 4: Heavy services
PHASE_IMAGES[4]="admin-api-service hr-service messaging-service"

# Phase 5: Critical services
PHASE_IMAGES[5]="auth-service sensor-service farm-service"

# Phase 6: Gateway
PHASE_IMAGES[6]="gateway-api"

# Map GHCR image name -> compose service name (may differ for some services)
declare -A IMAGE_TO_COMPOSE_SVC
IMAGE_TO_COMPOSE_SVC[gateway-api]="gateway-api"
IMAGE_TO_COMPOSE_SVC[auth-service]="auth-service"
IMAGE_TO_COMPOSE_SVC[farm-service]="farm-service"
IMAGE_TO_COMPOSE_SVC[sensor-service]="sensor-service"
IMAGE_TO_COMPOSE_SVC[admin-api-service]="admin-api-service"
IMAGE_TO_COMPOSE_SVC[alert-engine]="alert-engine"
IMAGE_TO_COMPOSE_SVC[billing-service]="billing-service"
IMAGE_TO_COMPOSE_SVC[hr-service]="hr-service"
IMAGE_TO_COMPOSE_SVC[hydroponics-service]="hydroponics-service"
IMAGE_TO_COMPOSE_SVC[notification-service]="notification-service"
IMAGE_TO_COMPOSE_SVC[observability-service]="observability-service"
IMAGE_TO_COMPOSE_SVC[config-service]="config-service"
IMAGE_TO_COMPOSE_SVC[messaging-service]="messaging-service"
IMAGE_TO_COMPOSE_SVC[event-store-service]="event-store-service"

# Map GHCR image name -> container name (for health checks)
declare -A IMAGE_TO_CONTAINER
IMAGE_TO_CONTAINER[gateway-api]="aqua-gateway"
IMAGE_TO_CONTAINER[auth-service]="aqua-auth"
IMAGE_TO_CONTAINER[farm-service]="aqua-farm"
IMAGE_TO_CONTAINER[sensor-service]="aqua-sensor"
IMAGE_TO_CONTAINER[admin-api-service]="aqua-admin-api"
IMAGE_TO_CONTAINER[alert-engine]="aqua-alert"
IMAGE_TO_CONTAINER[billing-service]="aqua-billing"
IMAGE_TO_CONTAINER[hr-service]="aqua-hr"
IMAGE_TO_CONTAINER[hydroponics-service]="aqua-hydroponics"
IMAGE_TO_CONTAINER[notification-service]="aqua-notification"
IMAGE_TO_CONTAINER[observability-service]="aqua-observability"
IMAGE_TO_CONTAINER[config-service]="aqua-config"
IMAGE_TO_CONTAINER[messaging-service]="aqua-messaging"
IMAGE_TO_CONTAINER[event-store-service]="aqua-event-store"

# Health endpoint port per container
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
HEALTH_PORT[aqua-event-store]=3010

# Maximum seconds to wait for health check after rollback
HEALTH_TIMEOUT=120

# ---------------------------------------------------------------------------
# Utility: resolve container IP
# ---------------------------------------------------------------------------
get_container_ip() {
  local container="$1"
  docker inspect --format='{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$container" 2>/dev/null || echo ""
}

# ---------------------------------------------------------------------------
# Utility: wait for container to become healthy
# ---------------------------------------------------------------------------
wait_for_healthy() {
  local container="$1"
  local port="${HEALTH_PORT[$container]:-3000}"
  local elapsed=0
  local interval=5

  info "Waiting for $container to become healthy (timeout: ${HEALTH_TIMEOUT}s)..."

  while [[ "$elapsed" -lt "$HEALTH_TIMEOUT" ]]; do
    local health
    health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container" 2>/dev/null || echo "missing")

    if [[ "$health" == "healthy" ]]; then
      pass "$container is healthy (after ${elapsed}s)"
      return 0
    fi

    # Also try HTTP check directly
    local ip
    ip=$(get_container_ip "$container")
    if [[ -n "$ip" ]]; then
      local http_code
      http_code=$(curl -sf -o /dev/null -w "%{http_code}" --max-time 3 "http://${ip}:${port}/health/live" 2>/dev/null || echo "000")
      if [[ "$http_code" == "200" ]]; then
        pass "$container /health/live returned 200 (after ${elapsed}s)"
        return 0
      fi
    fi

    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  fail "$container did not become healthy within ${HEALTH_TIMEOUT}s"
  return 1
}

# ---------------------------------------------------------------------------
# Step 1: Pull v10-baseline images for all services in the phase
# ---------------------------------------------------------------------------
pull_images() {
  local phase="$1"
  local tag="$2"
  local services="${PHASE_IMAGES[$phase]}"

  header "Step 1: Pulling v10-baseline Images"

  for svc in $services; do
    local image="${GHCR_BASE}/${svc}:${tag}"
    step "Pulling $image"

    if [[ "$DRY_RUN" == "true" ]]; then
      info "[DRY RUN] Would pull: $image"
      continue
    fi

    if docker pull "$image"; then
      pass "Pulled $image"
    else
      fail "Failed to pull $image -- image may not exist in registry"
      echo -e "  ${YELLOW}Hint: Ensure v10-baseline images were tagged before the upgrade (ADR-013 Phase 1 prerequisite).${NC}"
    fi
  done
}

# ---------------------------------------------------------------------------
# Step 2: Tag pulled images as :latest (compose file references :latest)
# ---------------------------------------------------------------------------
tag_images() {
  local phase="$1"
  local tag="$2"
  local services="${PHASE_IMAGES[$phase]}"

  header "Step 2: Tagging Images as :latest"

  for svc in $services; do
    local source="${GHCR_BASE}/${svc}:${tag}"
    local target="${GHCR_BASE}/${svc}:latest"

    if [[ "$DRY_RUN" == "true" ]]; then
      info "[DRY RUN] Would tag: $source -> $target"
      continue
    fi

    if docker tag "$source" "$target"; then
      pass "Tagged $source -> $target"
    else
      fail "Failed to tag $source -> $target"
    fi
  done
}

# ---------------------------------------------------------------------------
# Step 3: Recreate containers using the compose file (--no-build --no-deps)
# ---------------------------------------------------------------------------
recreate_containers() {
  local phase="$1"
  local services="${PHASE_IMAGES[$phase]}"

  header "Step 3: Recreating Containers"

  # Build the list of compose service names
  local compose_services=""
  for svc in $services; do
    local compose_name="${IMAGE_TO_COMPOSE_SVC[$svc]:-$svc}"
    compose_services="$compose_services $compose_name"
  done

  step "Recreating: $compose_services"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would run: docker compose -f $COMPOSE_FILE up -d --no-deps --no-build $compose_services"
    return
  fi

  # Use the droplet compose file, --no-deps prevents cascading recreation,
  # --no-build prevents attempting to build from source
  if docker compose -f "${PROJECT_ROOT}/${COMPOSE_FILE}" up -d --no-deps --no-build $compose_services; then
    pass "Containers recreated successfully"
  else
    fail "Failed to recreate containers"
    echo -e "  ${RED}Manual intervention may be required.${NC}"
  fi
}

# ---------------------------------------------------------------------------
# Step 4: Reload nginx to pick up new container IPs
# ---------------------------------------------------------------------------
reload_nginx() {
  header "Step 4: Reloading Nginx"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would run: docker exec aqua-nginx nginx -s reload"
    return
  fi

  if docker inspect aqua-nginx &>/dev/null; then
    local nginx_state
    nginx_state=$(docker inspect --format='{{.State.Status}}' aqua-nginx 2>/dev/null || echo "missing")
    if [[ "$nginx_state" == "running" ]]; then
      if docker exec aqua-nginx nginx -s reload; then
        pass "Nginx reloaded successfully"
      else
        fail "Nginx reload failed"
      fi
    else
      warn "aqua-nginx is not running (state: $nginx_state)"
    fi
  else
    warn "aqua-nginx container not found -- external proxy may be in use"
  fi
}

# ---------------------------------------------------------------------------
# Step 5: Verify health after rollback
# ---------------------------------------------------------------------------
verify_health() {
  local phase="$1"
  local services="${PHASE_IMAGES[$phase]}"

  header "Step 5: Post-Rollback Health Verification"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Would verify health for phase $phase services"
    return
  fi

  for svc in $services; do
    local container="${IMAGE_TO_CONTAINER[$svc]:-}"
    if [[ -z "$container" ]]; then
      warn "No container mapping for $svc -- skipping health check"
      continue
    fi

    # Check container exists and is running
    if ! docker inspect "$container" &>/dev/null; then
      warn "$container does not exist (may not be in compose file)"
      continue
    fi

    wait_for_healthy "$container"

    # Verify restart count is 0 after rollback
    local restarts
    restarts=$(docker inspect --format='{{.RestartCount}}' "$container" 2>/dev/null || echo "-1")
    if [[ "$restarts" -eq 0 ]]; then
      pass "$container restart count: 0"
    elif [[ "$restarts" -gt 0 ]]; then
      warn "$container restart count: $restarts (may indicate startup issue)"
    fi
  done

  # For phases with subgraph services, verify federation composition
  if [[ "$phase" -ge 3 ]]; then
    header "Post-Rollback Federation Check"
    if command -v rover &>/dev/null && [[ -f "${PROJECT_ROOT}/supergraph-config.yaml" ]]; then
      step "Running rover supergraph compose..."
      if rover supergraph compose --config "${PROJECT_ROOT}/supergraph-config.yaml" --output /dev/null 2>&1; then
        pass "Supergraph composition succeeded after rollback"
      else
        fail "Supergraph composition FAILED after rollback -- federation may be broken"
      fi
    else
      info "Skipping federation check (rover CLI not installed or config missing)"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Confirmation prompt (production safety)
# ---------------------------------------------------------------------------
confirm_rollback() {
  local phase="$1"
  local tag="$2"
  local services="${PHASE_IMAGES[$phase]}"

  echo -e "\n${YELLOW}${BOLD}WARNING: You are about to roll back Phase $phase to $tag images.${NC}\n"
  echo -e "  Services to roll back:"
  for svc in $services; do
    echo -e "    - ${GHCR_BASE}/${svc}:${tag}"
  done
  echo ""
  echo -e "  Compose file: ${COMPOSE_FILE}"
  echo -e "  This will recreate containers and reload nginx.\n"

  if [[ "$DRY_RUN" == "true" ]]; then
    info "[DRY RUN] Skipping confirmation"
    return 0
  fi

  read -rp "  Type 'rollback' to confirm: " confirmation
  if [[ "$confirmation" != "rollback" ]]; then
    echo -e "\n${RED}Rollback cancelled.${NC}"
    exit 0
  fi
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
print_summary() {
  local phase="$1"

  header "ROLLBACK SUMMARY (Phase $phase)"
  if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "\n${YELLOW}${BOLD}  DRY RUN COMPLETED -- no changes made${NC}\n"
  elif [[ "$FAILURES" -eq 0 ]]; then
    echo -e "\n${GREEN}${BOLD}  ROLLBACK COMPLETED SUCCESSFULLY${NC}\n"
    echo -e "  All Phase $phase services have been reverted to v10-baseline."
    echo -e "  Run ./scripts/v11-upgrade/verify-phase.sh $phase to perform full verification."
    echo -e "  Run ./scripts/v11-upgrade/verify-nats-compat.sh --compare to check NATS state.\n"
  else
    echo -e "\n${RED}${BOLD}  ROLLBACK COMPLETED WITH $FAILURES ISSUE(S)${NC}\n"
    echo -e "  Some checks failed -- manual investigation required."
    echo -e "  Check container logs: docker logs <container-name>"
    echo -e "  Check compose state: docker compose -f $COMPOSE_FILE ps\n"
  fi
}

# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------
usage() {
  echo "Usage: $0 <phase-number> [options]"
  echo ""
  echo "  phase-number: 2-6 (Phase 1 is library-only, no containers to roll back)"
  echo ""
  echo "Options:"
  echo "  --dry          Preview actions without making changes"
  echo "  --sha <sha>    Use a specific git SHA tag instead of v10-baseline"
  echo "  --tag <tag>    Use a specific Docker tag (default: v10-baseline)"
  echo "  --yes          Skip confirmation prompt"
  echo ""
  echo "Examples:"
  echo "  $0 2                      # Roll back Phase 2 to v10-baseline"
  echo "  $0 3 --dry                # Preview Phase 3 rollback"
  echo "  $0 5 --sha abc123def     # Roll back Phase 5 to specific SHA"
  echo "  $0 6 --tag v10-baseline  # Explicit tag specification"
  exit 1
}

if [[ $# -lt 1 ]]; then
  usage
fi

PHASE="$1"
shift

# Parse options
DRY_RUN="false"
ROLLBACK_TAG="$DEFAULT_TAG"
SKIP_CONFIRM="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry|--dry-run)
      DRY_RUN="true"
      shift
      ;;
    --sha)
      ROLLBACK_TAG="${2:?--sha requires a value}"
      shift 2
      ;;
    --tag)
      ROLLBACK_TAG="${2:?--tag requires a value}"
      shift 2
      ;;
    --yes|-y)
      SKIP_CONFIRM="true"
      shift
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      usage
      ;;
  esac
done

# Validate phase number
if [[ "$PHASE" -lt 2 || "$PHASE" -gt 6 ]]; then
  echo -e "${RED}Error: Phase must be 2-6. Phase 1 is library-only (no containers).${NC}"
  usage
fi

# Verify phase has services defined
if [[ -z "${PHASE_IMAGES[$PHASE]:-}" ]]; then
  echo -e "${RED}Error: No services defined for Phase $PHASE.${NC}"
  exit 1
fi

echo -e "${BOLD}NestJS v11 Phase Rollback (ADR-013)${NC}"
echo -e "Timestamp: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo -e "Phase: $PHASE"
echo -e "Rollback tag: $ROLLBACK_TAG"
echo -e "Compose file: $COMPOSE_FILE"
if [[ "$DRY_RUN" == "true" ]]; then
  echo -e "Mode: ${YELLOW}DRY RUN${NC}"
fi
echo ""

# Confirmation gate
if [[ "$SKIP_CONFIRM" != "true" ]]; then
  confirm_rollback "$PHASE" "$ROLLBACK_TAG"
fi

# Execute rollback steps
pull_images "$PHASE" "$ROLLBACK_TAG"
tag_images "$PHASE" "$ROLLBACK_TAG"
recreate_containers "$PHASE"
reload_nginx
verify_health "$PHASE"

print_summary "$PHASE"
exit $((FAILURES > 0 ? 1 : 0))
