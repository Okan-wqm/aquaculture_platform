#!/usr/bin/env bash
# =============================================================================
# JWT JWKS Key Rotation — Docker Compose Automation
#
# End-to-end zero-downtime key rotation for Docker deployments:
#   1. Generates new RSA key pair (delegates to rotate-jwt-keys.sh)
#   2. Restarts auth-service container (picks up new key files)
#   3. Waits for auth-service to become healthy
#   4. Verifies JWKS endpoint serves both current and previous keys
#
# Other services (gateway, subgraphs) do NOT need restart — they use
# JwksService which fetches keys from auth-service's JWKS endpoint
# and auto-refreshes on cache miss or at 75% of the 1-hour TTL.
#
# Usage:
#   ./scripts/rotate-jwt-keys-docker.sh                          # defaults
#   ./scripts/rotate-jwt-keys-docker.sh --compose-file docker-compose.droplet.yml
#   ./scripts/rotate-jwt-keys-docker.sh --secrets-dir /opt/aquaculture/secrets
#
# Cron example (monthly rotation at 3 AM on the 1st):
#   0 3 1 * * /opt/aquaculture/scripts/rotate-jwt-keys-docker.sh --secrets-dir /opt/aquaculture/secrets --compose-file /opt/aquaculture/docker-compose.droplet.yml >> /var/log/jwt-rotation.log 2>&1
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"

log()  { echo "[$TIMESTAMP] [INFO]  $1"; }
warn() { echo "[$TIMESTAMP] [WARN]  $1"; }
err()  { echo "[$TIMESTAMP] [ERROR] $1" >&2; }

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
SECRETS_DIR=""
COMPOSE_FILE=""
AUTH_CONTAINER="aqua-auth"
JWKS_CHECK_URL=""
AUTH_PORT="${AUTH_SERVICE_PORT:-4001}"
HEALTH_TIMEOUT=120   # seconds to wait for auth-service health
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --secrets-dir)
      SECRETS_DIR="$2"
      shift 2
      ;;
    --secrets-dir=*)
      SECRETS_DIR="${1#*=}"
      shift
      ;;
    --compose-file)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    --compose-file=*)
      COMPOSE_FILE="${1#*=}"
      shift
      ;;
    --container)
      AUTH_CONTAINER="$2"
      shift 2
      ;;
    --jwks-url)
      JWKS_CHECK_URL="$2"
      shift 2
      ;;
    --port)
      AUTH_PORT="$2"
      shift 2
      ;;
    --port=*)
      AUTH_PORT="${1#*=}"
      shift
      ;;
    --health-timeout)
      HEALTH_TIMEOUT="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --secrets-dir <path>      Secrets directory (default: ./secrets)"
      echo "  --compose-file <file>     Docker Compose file (default: auto-detect)"
      echo "  --container <name>        Auth container name (default: aqua-auth)"
      echo "  --jwks-url <url>          JWKS endpoint to verify (default: auto-detect from container)"
      echo "  --port <port>             Auth service port (default: AUTH_SERVICE_PORT env or 4001)"
      echo "  --health-timeout <sec>    Max seconds to wait for health (default: 120)"
      echo "  --dry-run                 Generate keys but skip Docker restart"
      echo "  -h, --help               Show this help"
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# Defaults
if [ -z "$SECRETS_DIR" ]; then
  SECRETS_DIR="${REPO_ROOT}/secrets"
fi

# Auto-detect compose file
if [ -z "$COMPOSE_FILE" ]; then
  if [ -f "${REPO_ROOT}/docker-compose.droplet.yml" ]; then
    # Check if droplet compose is in use (most likely production)
    if docker compose -f "${REPO_ROOT}/docker-compose.droplet.yml" ps --quiet 2>/dev/null | head -1 | grep -q .; then
      COMPOSE_FILE="${REPO_ROOT}/docker-compose.droplet.yml"
    fi
  fi
  if [ -z "$COMPOSE_FILE" ] && [ -f "${REPO_ROOT}/docker-compose.prod.yml" ]; then
    if docker compose -f "${REPO_ROOT}/docker-compose.prod.yml" ps --quiet 2>/dev/null | head -1 | grep -q .; then
      COMPOSE_FILE="${REPO_ROOT}/docker-compose.prod.yml"
    fi
  fi
  if [ -z "$COMPOSE_FILE" ]; then
    # Fallback: try whatever compose file has auth-service running
    for f in "${REPO_ROOT}"/docker-compose*.yml; do
      if docker compose -f "$f" ps --quiet auth-service 2>/dev/null | head -1 | grep -q .; then
        COMPOSE_FILE="$f"
        break
      fi
    done
  fi
  if [ -z "$COMPOSE_FILE" ]; then
    err "Could not auto-detect active Docker Compose file."
    err "Pass --compose-file explicitly, or ensure auth-service is running."
    exit 1
  fi
fi

log "Using compose file: $COMPOSE_FILE"
log "Secrets directory:  $SECRETS_DIR"
log "Auth container:     $AUTH_CONTAINER"

# ---------------------------------------------------------------------------
# Preflight: verify auth-service is running
# ---------------------------------------------------------------------------
if [ "$DRY_RUN" = false ]; then
  if ! docker ps --format '{{.Names}}' | grep -q "^${AUTH_CONTAINER}$"; then
    err "Container '$AUTH_CONTAINER' is not running. Start it first."
    exit 1
  fi
  log "Auth container '$AUTH_CONTAINER' is running"
fi

# ---------------------------------------------------------------------------
# Step 1: Generate new keys (delegate to base script)
# ---------------------------------------------------------------------------
log "============================================"
log "Step 1/4: Generating new key pair"
log "============================================"

"${SCRIPT_DIR}/rotate-jwt-keys.sh" --secrets-dir "$SECRETS_DIR"

NEW_KEY_ID="$(cat "$SECRETS_DIR/jwt_key_id")"
PREV_KEY_ID=""
if [ -f "$SECRETS_DIR/jwt_previous_key_id" ]; then
  PREV_KEY_ID="$(cat "$SECRETS_DIR/jwt_previous_key_id")"
fi

# Update .env file with new key IDs (if .env exists)
ENV_FILE="${REPO_ROOT}/.env"
if [ -f "$ENV_FILE" ]; then
  log "Updating .env file with new key IDs..."

  # Update or add JWT_KEY_ID
  if grep -q "^JWT_KEY_ID=" "$ENV_FILE"; then
    sed -i "s/^JWT_KEY_ID=.*/JWT_KEY_ID=${NEW_KEY_ID}/" "$ENV_FILE"
  else
    echo "JWT_KEY_ID=${NEW_KEY_ID}" >> "$ENV_FILE"
  fi

  # Update or add JWT_PREVIOUS_KEY_ID
  if [ -n "$PREV_KEY_ID" ]; then
    if grep -q "^JWT_PREVIOUS_KEY_ID=" "$ENV_FILE"; then
      sed -i "s/^JWT_PREVIOUS_KEY_ID=.*/JWT_PREVIOUS_KEY_ID=${PREV_KEY_ID}/" "$ENV_FILE"
    else
      echo "JWT_PREVIOUS_KEY_ID=${PREV_KEY_ID}" >> "$ENV_FILE"
    fi
  fi

  log ".env updated: JWT_KEY_ID=${NEW_KEY_ID}, JWT_PREVIOUS_KEY_ID=${PREV_KEY_ID}"
else
  warn "No .env file found at ${ENV_FILE} -- key IDs not persisted to .env"
  warn "Set JWT_KEY_ID=${NEW_KEY_ID} and JWT_PREVIOUS_KEY_ID=${PREV_KEY_ID} in your environment"
fi

if [ "$DRY_RUN" = true ]; then
  log "============================================"
  log "DRY RUN: Skipping Docker restart and verification"
  log "============================================"
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2: Restart auth-service container
# ---------------------------------------------------------------------------
log "============================================"
log "Step 2/4: Restarting auth-service"
log "============================================"

# Use docker compose restart to pick up new secret files.
# Other services do NOT need restart — they fetch keys via JWKS endpoint.
docker compose -f "$COMPOSE_FILE" restart auth-service
log "auth-service restart initiated"

# ---------------------------------------------------------------------------
# Step 3: Wait for auth-service to become healthy
# ---------------------------------------------------------------------------
log "============================================"
log "Step 3/4: Waiting for auth-service health (timeout: ${HEALTH_TIMEOUT}s)"
log "============================================"

ELAPSED=0
INTERVAL=5
while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$AUTH_CONTAINER" 2>/dev/null || echo "unknown")
  if [ "$STATUS" = "healthy" ]; then
    log "auth-service is healthy (after ${ELAPSED}s)"
    break
  fi
  log "  Status: $STATUS (${ELAPSED}s / ${HEALTH_TIMEOUT}s)..."
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

if [ "$STATUS" != "healthy" ]; then
  err "auth-service did not become healthy within ${HEALTH_TIMEOUT}s"
  err "Check logs: docker logs $AUTH_CONTAINER --tail 50"
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 4: Verify JWKS endpoint serves the new (and previous) keys
# ---------------------------------------------------------------------------
log "============================================"
log "Step 4/4: Verifying JWKS endpoint"
log "============================================"

# Determine JWKS URL: exec into the container network or use provided URL
if [ -z "$JWKS_CHECK_URL" ]; then
  # Fetch JWKS from inside the Docker network via the auth container
  JWKS_JSON=$(docker exec "$AUTH_CONTAINER" wget -qO- "http://localhost:${AUTH_PORT}/.well-known/jwks.json" 2>/dev/null || echo "")
else
  JWKS_JSON=$(curl -sf "$JWKS_CHECK_URL" 2>/dev/null || echo "")
fi

if [ -z "$JWKS_JSON" ]; then
  warn "Could not fetch JWKS endpoint. Auth-service may still be initializing."
  warn "Manual verification: docker exec $AUTH_CONTAINER wget -qO- http://localhost:${AUTH_PORT}/.well-known/jwks.json"
else
  log "JWKS response received"

  # Count keys in JWKS response
  # Use grep to count "kid" occurrences (works without jq)
  KEY_COUNT=$(echo "$JWKS_JSON" | grep -o '"kid"' | wc -l)
  log "Keys in JWKS response: $KEY_COUNT"

  # Verify new key is present
  if echo "$JWKS_JSON" | grep -q "\"$NEW_KEY_ID\""; then
    log "New key '$NEW_KEY_ID' found in JWKS: OK"
  else
    warn "New key '$NEW_KEY_ID' NOT found in JWKS response!"
    warn "The JWKS endpoint may be using cached data. It will refresh on next restart."
    warn "Response: $JWKS_JSON"
  fi

  # Verify previous key is present (if applicable)
  if [ -n "$PREV_KEY_ID" ]; then
    if echo "$JWKS_JSON" | grep -q "\"$PREV_KEY_ID\""; then
      log "Previous key '$PREV_KEY_ID' found in JWKS: OK (rotation grace period active)"
    else
      warn "Previous key '$PREV_KEY_ID' NOT found in JWKS response"
      warn "Tokens signed with the old key may fail verification!"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
log "=========================================================="
log "JWT Key Rotation Complete"
log "=========================================================="
log "New key ID:      $NEW_KEY_ID"
if [ -n "$PREV_KEY_ID" ]; then
  log "Previous key ID: $PREV_KEY_ID"
fi
log ""
log "What happened:"
log "  - New RSA key pair generated in $SECRETS_DIR"
log "  - auth-service restarted (serves both keys via JWKS)"
log "  - Other services will auto-fetch new keys within 1 hour"
log ""
log "No further action required. Tokens signed with the old key"
log "will remain valid until they expire (JWT_EXPIRES_IN, default 1h)."
log "=========================================================="
