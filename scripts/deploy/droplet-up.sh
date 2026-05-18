#!/usr/bin/env bash
# =============================================================================
# scripts/deploy/droplet-up.sh
#
# Invoked by `.github/workflows/deploy-digitalocean.yml`'s `Deploy to
# DigitalOcean Droplet` step via appleboy/ssh-action. Runs on the droplet
# after SSH. Extracted from the inline `script: |` block because that
# block's `${{ }}` interpolation + bash content crossed GitHub Actions'
# 21,000-char per-expression limit (commit 2c055125+ triggered
# HTTP 422 "Exceeded max expression length 21000" at workflow parse).
#
# Moving the bash out of the YAML:
#   1. Keeps the YAML expression size tiny (the workflow step now only
#      passes env vars and invokes this script).
#   2. Makes the deploy logic unit-testable locally (shellcheck, etc.).
#   3. Lets the script grow without pushing the YAML back over the
#      parser limit.
#
# Required env vars (set by the workflow step's envs: block):
#   DEPLOY_SERVICES   — comma-separated service list ("all" for full)
#   FULL_DEPLOY       — "true" or "false"
#   DEPLOY_SHA        — commit SHA being deployed
#   GITHUB_ACTOR      — actor username for GHCR login
#   GHCR_TOKEN        — GITHUB_TOKEN with packages:read scope
# =============================================================================

set -e
cd /var/aqua-saas

dump_nonhealthy_container_logs() {
  local label="${1:-snapshot}"
  echo "=== Logs from non-healthy/restarting containers (${label}) ==="
  for c in $(docker ps -a --format '{{.Names}}' --filter "label=com.docker.compose.project=aqua-saas"); do
    HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$c" 2>/dev/null || echo "none")
    RESTARTS=$(docker inspect --format='{{.RestartCount}}' "$c" 2>/dev/null || echo "0")
    if [ "$HEALTH" != "healthy" ] || [ "$RESTARTS" -gt 0 ] 2>/dev/null; then
      echo "--- $c (health=$HEALTH, restarts=$RESTARTS) last 200 lines ---"
      docker logs --tail 200 "$c" 2>&1 || true
    fi
  done
}

run_db_migrate_or_exit() {
  local deploy_mode="${1:-deploy}"

  echo "=== Running aqua-db-migrate (one-shot schema runner) ==="
  # Pull the migration image separately so its failure does not cascade into
  # service-container pull logic. Compose service name is `db-migrate`; the
  # container_name is `aqua-db-migrate`.
  docker compose -f docker-compose.droplet.yml pull db-migrate 2>&1 || true

  DB_MIGRATE_TIMEOUT_SECONDS="${DB_MIGRATE_TIMEOUT_SECONDS:-1200}"
  set +e
  timeout --kill-after=30s "${DB_MIGRATE_TIMEOUT_SECONDS}s" \
    docker compose -f docker-compose.droplet.yml \
      up --no-build --abort-on-container-exit \
      --exit-code-from db-migrate db-migrate
  DB_MIGRATE_STATUS=$?
  set -e

  if [ "${DB_MIGRATE_STATUS}" -eq 124 ] || [ "${DB_MIGRATE_STATUS}" -eq 137 ]; then
    echo "::error::aqua-db-migrate exceeded ${DB_MIGRATE_TIMEOUT_SECONDS}s during ${deploy_mode} — aborting before service restart."
    echo "--- aqua-db-migrate logs (last 500 lines) ---"
    docker logs aqua-db-migrate --tail=500 2>&1 || true
    echo "--- db-migrate/postgres status ---"
    docker compose -f docker-compose.droplet.yml ps db-migrate postgres 2>&1 || true
    docker compose -f docker-compose.droplet.yml stop db-migrate 2>&1 || true
    exit 1
  elif [ "${DB_MIGRATE_STATUS}" -ne 0 ]; then
    echo "::error::aqua-db-migrate failed during ${deploy_mode} — aborting BEFORE service containers start."
    echo "--- aqua-db-migrate logs (last 500 lines) ---"
    docker logs aqua-db-migrate --tail=500 2>&1 || true
    exit 1
  fi

  echo "  aqua-db-migrate completed successfully"
}

run_image_prune_best_effort() {
  local label="$1"
  shift
  local cleanup_timeout="${IMAGE_PRUNE_TIMEOUT_SECONDS:-180}"

  echo "  Pruning ${label} (timeout=${cleanup_timeout}s)..."
  set +e
  timeout --kill-after=10s "${cleanup_timeout}s" docker image prune "$@"
  PRUNE_STATUS=$?
  set -e

  if [ "${PRUNE_STATUS}" -eq 124 ] || [ "${PRUNE_STATUS}" -eq 137 ]; then
    echo "::warning::Docker image prune for ${label} exceeded ${cleanup_timeout}s; continuing because cleanup is post-success best effort."
    docker system df 2>&1 || true
  elif [ "${PRUNE_STATUS}" -ne 0 ]; then
    echo "::warning::Docker image prune for ${label} failed with exit ${PRUNE_STATUS}; continuing because cleanup is post-success best effort."
    docker system df 2>&1 || true
  fi
}

# SEC-CI-012: Checkout to the specific SHA that triggered the workflow
# instead of git pull (prevents TOCTOU race if another commit lands mid-deploy)
echo "=== Checking out deploy SHA ==="
git fetch --force --prune origin
git checkout -f ${DEPLOY_SHA}

# IP-1: Auto-generate/renew TLS certificates for NATS/Redis/PostgreSQL.
#
# ARCHITECTURAL CHANGE 2026-04-14: ALWAYS run generate-internal-certs.sh.
#
# Previous gate "if redis cert valid > 30 days, skip generation" caused
# an outage: new per-service NATS client certs (commit 11c21fda added
# auth_service / farm_service / .../ messaging_service / hydroponics_service
# certs to the script's `for svc in ...` loop) were NEVER generated on
# droplets where redis cert was still valid — the gate skipped the
# whole script. Result: clients/<svc>-cert.pem files missing → mTLS
# handshake fails → 'Authorization Violation' across every backend.
#
# Tier-1 Make-Impossible fix: ALWAYS invoke the script. Its per-file
# skip-if-exists logic (line 45-46 of generate-internal-certs.sh)
# makes the no-op case ~100ms total. New per-service certs added in
# lockstep with services.yaml will land on next deploy automatically,
# without operator intervention. --force is reserved for proactive
# renewal of existing certs nearing expiry.
echo "=== TLS certificate generation (always-run; idempotent) ==="
CERT_RENEW=false
if [ -f "certs/redis/redis-cert.pem" ]; then
  EXPIRY=$(openssl x509 -enddate -noout -in certs/redis/redis-cert.pem 2>/dev/null | cut -d= -f2)
  if [ -n "$EXPIRY" ]; then
    EXPIRY_EPOCH=$(date -d "$EXPIRY" +%s 2>/dev/null || echo 0)
    NOW_EPOCH=$(date +%s)
    DAYS_LEFT=$(( (EXPIRY_EPOCH - NOW_EPOCH) / 86400 ))
    echo "  Server certificate expires in ${DAYS_LEFT} days"
    if [ "$DAYS_LEFT" -lt 30 ]; then
      echo "  Expiring soon — proactive full regeneration"
      CERT_RENEW=true
    fi
  fi
fi
if [ "$CERT_RENEW" = true ]; then
  bash infrastructure/docker/scripts/generate-internal-certs.sh --force
else
  # No --force: script generates ONLY missing certs; existing valid
  # certs stay untouched. Catches "new service added since last
  # deploy" → its client cert gets generated even if shared CA cert
  # is still valid for 300+ days.
  bash infrastructure/docker/scripts/generate-internal-certs.sh
fi

# ──────────────────────────────────────────────────────────────
# ADR-016 Phase A — Pre-flight validation
# ──────────────────────────────────────────────────────────────
#
# All checks below MUST pass before we touch live production
# state. A bad commit caught here means zero-impact rollback
# (we never destroyed the running containers). A bad commit
# NOT caught here costs 5 minutes of timeout + log dive +
# health-check rollback.
#
# Tier-1 Make-Impossible: the compose interpolation, NATS
# SSoT drift, and required-secret presence are all detectable
# in <1s without touching containers. Failing fast here is
# always cheaper than failing during boot.
#
# Phase A2 — docker-compose interpolation valid
echo "=== Pre-flight: compose interpolation ==="
if ! docker compose -f docker-compose.droplet.yml config --quiet; then
  echo "::error::docker-compose.droplet.yml interpolation failed."
  echo "  Likely cause: missing :? required env var in /var/aqua-saas/.env"
  echo "  Aborting BEFORE any container actions — no production state changed."
  exit 1
fi
echo "  OK: compose interpolates cleanly"

# Phase A3 — NATS SSoT not drifted from generated nats.conf
echo "=== Pre-flight: NATS SSoT drift check ==="
if [ -f scripts/nats/generate-nats-conf.py ]; then
  python3 scripts/nats/generate-nats-conf.py
  if ! git diff --quiet infrastructure/docker/nats/nats.conf; then
    echo "::error::nats.conf drifted from infrastructure/nats/services.yaml"
    echo "  Run 'python3 scripts/nats/generate-nats-conf.py' locally and commit the diff."
    git diff infrastructure/docker/nats/nats.conf | head -50
    exit 1
  fi
  echo "  OK: nats.conf matches services.yaml"
else
  echo "  SKIP: generator script not present (commit predates ADR-015)"
fi

# Phase A4 — ensure required secrets exist in .env.
# The REQUIRED set lives in scripts/deploy/lib/required-env-secrets.sh and
# is shared with droplet-bootstrap-env.sh so the preflight check and the
# bootstrap generator cannot drift (Tier-1 SSoT architectural fix).
#
# Bootstrap is invoked UNCONDITIONALLY here and is safe by design because
# droplet-bootstrap-env.sh is strictly idempotent: for each required
# secret it `grep`s for an existing `^NAME=` line and skips if present.
# A pre-existing PASSWORD_PEPPER is never overwritten — this path only
# *generates if absent*, never *rotates*. Rotation (the dangerous
# operation that invalidates every bcrypt hash) still requires explicit
# incident-response — see docs/runbooks/secret-rotation.md#password-pepper.
#
# The post-bootstrap verify loop is defense-in-depth: if the generator
# fails halfway, we catch the gap here rather than letting containers
# boot with half-populated env.
echo "=== Pre-flight: required secrets presence ==="
bash /var/aqua-saas/scripts/deploy/droplet-bootstrap-env.sh
# shellcheck disable=SC1091
source /var/aqua-saas/scripts/deploy/lib/required-env-secrets.sh
MISSING=()
while IFS= read -r SECRET; do
  if ! grep -q "^${SECRET}=" /var/aqua-saas/.env 2>/dev/null; then
    MISSING+=("$SECRET")
  fi
done < <(required_env_secret_names)
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "::error::Still missing after bootstrap: ${MISSING[*]}"
  echo "  Bootstrap reported success but preflight re-check failed — investigate"
  echo "  /var/aqua-saas/.env permissions and scripts/deploy/droplet-bootstrap-env.sh output."
  exit 1
fi
echo "  OK: ${#REQUIRED_ENV_SECRETS[@]} required secrets present"

# End of pre-flight ──────────────────────────────────────────

# SEC-CI-001: GITHUB_TOKEN (packages:read) is substituted at template time by the
# GitHub Actions runner and masked as *** in all logs. Short-lived, run-scoped only.
echo "=== Logging into GHCR ==="
echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_ACTOR}" --password-stdin

# ARCH-CI-007: Capture current image digests for rollback before pulling new images
echo "=== Capturing current image digests for rollback ==="
PREV_GATEWAY=$(docker inspect --format='{{.Image}}' aqua-saas-gateway-api-1 2>/dev/null || echo "")
echo "Previous gateway digest: ${PREV_GATEWAY:-none}"

# Scope boot-signal assertions to this deploy attempt. The asserter falls
# back to per-container StartedAt if this is absent, but an explicit since
# marker makes full and selective deploy log windows obvious in output.
export BOOT_SIGNAL_SINCE
BOOT_SIGNAL_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Boot signal log window starts at: ${BOOT_SIGNAL_SINCE}"

if [ "$FULL_DEPLOY" = "true" ]; then
  # ── Full deploy mode (workflow_dispatch "all" or first deploy) ──
  echo "=== FULL DEPLOY: Pulling images sequentially (avoids disk I/O contention) ==="
  for svc in $(docker compose -f docker-compose.droplet.yml config --services); do
    echo "  Pulling $svc..."
    docker compose -f docker-compose.droplet.yml pull "$svc" 2>&1 || echo "  WARN: $svc pull failed, continuing..."
  done

  echo "=== Stopping all services ==="
  docker compose -f docker-compose.droplet.yml down --remove-orphans --timeout 30 2>&1 || true
  # Force-remove ALL aqua containers (including ones compose couldn't remove)
  echo "Force-removing any remaining aqua containers..."
  docker ps -a --format '{{.Names}}' | grep -E 'aqua-' | while read -r name; do
    echo "  Removing $name..."
    docker rm -f "$name" 2>&1 || true
  done
  sleep 5
  # Verify clean slate
  REMAINING=$(docker ps -a --format '{{.Names}}' | grep -E 'aqua-' || true)
  if [ -n "$REMAINING" ]; then
    echo "WARNING: containers still exist after cleanup: $REMAINING"
    echo "Attempting docker stop + rm..."
    echo "$REMAINING" | xargs -r docker stop --time 5 2>&1 || true
    echo "$REMAINING" | xargs -r docker rm -f 2>&1 || true
    sleep 5
  fi
  echo "Containers after cleanup:"
  docker ps -a --format '{{.Names}}' | grep -E 'aqua-' || echo "none (clean)"

  # ARCH-031: Pre-deploy NATS JetStream storage maintenance.
  # If JetStream data exceeds server limit (nats.conf max_file_store: 2GB),
  # purge the data directory to allow clean startup. NATS will recreate
  # streams via nats-event-bus.ts setupStream() on first service connection.
  # This prevents "insufficient storage resources available" (error 10047).
  echo "=== NATS JetStream storage maintenance ==="
  NATS_DATA_DIR="/var/lib/docker/volumes/aqua-saas_nats_data/_data/jetstream"
  if [ -d "$NATS_DATA_DIR" ]; then
    JS_SIZE=$(du -sm "$NATS_DATA_DIR" 2>/dev/null | awk '{print $1}')
    echo "JetStream storage usage: ${JS_SIZE:-0}MB / 2048MB limit"
    if [ "${JS_SIZE:-0}" -gt 1800 ]; then
      echo "⚠️  JetStream storage near limit (${JS_SIZE}MB > 1800MB). Purging old data..."
      rm -rf "$NATS_DATA_DIR"
      echo "JetStream data purged. Streams will be recreated on startup."
    fi
  else
    echo "No existing JetStream data directory found (first deploy or volume not mounted)"
  fi

  # ================================================================
  # Per-service credential provisioning (CRITICAL-002 / CRITICAL-001)
  #
  # Each service needs its own NATS user/password and DB role password.
  # These are generated ONCE and persisted in .env. Subsequent deploys
  # detect existing values and skip generation (idempotent).
  # ================================================================
  echo "=== Ensuring per-service credentials exist ==="
  ENV_FILE="/var/aqua-saas/.env"

  generate_credential() {
    local VAR_NAME="$1"
    if grep -q "^${VAR_NAME}=" "$ENV_FILE" 2>/dev/null; then
      echo "  ${VAR_NAME}: already set"
    else
      local VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
      echo "${VAR_NAME}=${VALUE}" >> "$ENV_FILE"
      echo "  ${VAR_NAME}: generated"
    fi
  }

  # ADR-015 (cert-is-identity): NATS per-service identity is the
  # mTLS cert CN via `verify_and_map: true`. The previous
  # set_canonical NATS_*_USER / generate_credential NATS_*_PASS
  # provisioning block was removed — those env vars are no longer
  # consumed by nats.conf (literal user names from services.yaml)
  # or by the client factory (mtls-cert mode omits user/pass from
  # CONNECT frame). Keeping them provisioned would resurrect the
  # 3-way drift surface (.env ↔ nats.conf ↔ cert CN) that caused
  # the 2026-04-14 Authorization Violation outage.
  #
  # Canonical service name list now lives exclusively at
  # infrastructure/nats/services.yaml and is consumed by:
  #   - scripts/nats/generate-nats-conf.py (generates nats.conf)
  #   - infrastructure/docker/scripts/generate-internal-certs.sh
  #     (cert CN list — hand-written in lockstep, CI-validated)
  #   - e2e/tests/integration/nats-invariants.spec.ts (drift
  #     detection)
  #
  # If the SSoT gets out of sync with generated artifacts, the
  # nats-invariants CI test fails the build — no need for deploy
  # workflow to enforce it.
  #
  # NATS_*_SVC_USER / NATS_*_SVC_PASS are historical (internal
  # deploy bookkeeping, not client auth). Preserved to avoid
  # churning deploy-state conventions in the same PR as the
  # architectural refactor. Tracked as BACKLOG-NATS-003 to audit
  # whether they're still read by any pipeline step and remove
  # them if not.

  # NATS per-service internal bookkeeping credentials (unrelated
  # to client auth; legacy — see comment above)
  for SVC in AUTH FARM SENSOR GATEWAY NOTIFICATION BILLING ALERT HR MESSAGING HYDROPONICS; do
    generate_credential "NATS_${SVC}_SVC_USER"
    generate_credential "NATS_${SVC}_SVC_PASS"
  done

  # PostgreSQL per-service role passwords
  for SVC in AUTH FARM SENSOR BILLING HR ALERT ADMIN GATEWAY NOTIFICATION HYDROPONICS MESSAGING; do
    generate_credential "${SVC}_SERVICE_DB_PASS"
  done

  # Application secrets
  generate_credential "WEBHOOK_ENCRYPTION_KEY"

  echo "=== Per-service credentials provisioned ==="

  # RSA key pair for JWT RS256 signing (auth-service signs, all verify)
  echo "=== Ensuring JWT RSA key pair exists ==="
  JWT_KEY_DIR="/var/aqua-saas/certs/jwt"
  if [ ! -f "$JWT_KEY_DIR/private.pem" ]; then
    echo "  Generating RSA-2048 key pair for JWT..."
    mkdir -p "$JWT_KEY_DIR"
    openssl genrsa -out "$JWT_KEY_DIR/private.pem" 2048
    openssl rsa -in "$JWT_KEY_DIR/private.pem" -pubout -out "$JWT_KEY_DIR/public.pem"
    chmod 644 "$JWT_KEY_DIR/private.pem"
    chmod 644 "$JWT_KEY_DIR/public.pem"
    # Write PEM paths to .env
    grep -q "^JWT_PRIVATE_KEY_PATH=" "$ENV_FILE" || echo "JWT_PRIVATE_KEY_PATH=/etc/ssl/jwt/private.pem" >> "$ENV_FILE"
    grep -q "^JWT_PUBLIC_KEY_PATH=" "$ENV_FILE" || echo "JWT_PUBLIC_KEY_PATH=/etc/ssl/jwt/public.pem" >> "$ENV_FILE"
    echo "  JWT RSA key pair generated"
  else
    echo "  JWT RSA key pair already exists"
    # Ensure .env has the path vars even if keys were generated in a prior deploy
    grep -q "^JWT_PRIVATE_KEY_PATH=" "$ENV_FILE" || echo "JWT_PRIVATE_KEY_PATH=/etc/ssl/jwt/private.pem" >> "$ENV_FILE"
    grep -q "^JWT_PUBLIC_KEY_PATH=" "$ENV_FILE" || echo "JWT_PUBLIC_KEY_PATH=/etc/ssl/jwt/public.pem" >> "$ENV_FILE"
  fi

  echo "=== Ensuring infrastructure databases exist ==="
  # Start only postgres first to create additional databases
  docker compose -f docker-compose.droplet.yml up -d --no-build postgres 2>&1 || true
  sleep 10

  # DB-PWD-SYNC: Verify POSTGRES_PASSWORD matches what's in the data volume.
  # If the .env password was regenerated but the volume persists from a prior init,
  # db-init and all services will fail to authenticate. Fix by resetting the
  # password via local trust auth (docker exec uses Unix socket, not TCP).
  echo "=== Verifying PostgreSQL superuser password ==="
  if docker exec aqua-postgres psql -U "${POSTGRES_USER:-aquaculture}" -c "SELECT 1" >/dev/null 2>&1; then
    if docker exec aqua-postgres bash -c "PGPASSWORD='${POSTGRES_PASSWORD}' psql -h 127.0.0.1 -U '${POSTGRES_USER:-aquaculture}' -c 'SELECT 1'" >/dev/null 2>&1; then
      echo "  PostgreSQL superuser password matches .env"
    else
      echo "  WARNING: PostgreSQL superuser password mismatch — resetting via local auth"
      docker exec aqua-postgres psql -U "${POSTGRES_USER:-aquaculture}" \
        -c "ALTER USER \"${POSTGRES_USER:-aquaculture}\" WITH PASSWORD '${POSTGRES_PASSWORD}'"
      echo "  PostgreSQL superuser password reset to match .env"
    fi
  else
    echo "  ERROR: Cannot connect to PostgreSQL via local auth — manual intervention required"
  fi

  # Create observability database if it doesn't exist (postgres init scripts only run on first start)
  docker exec aqua-postgres psql -U "${POSTGRES_USER:-aquaculture}" -tc "SELECT 1 FROM pg_database WHERE datname = 'aquaculture_observability'" | grep -q 1 || \
    docker exec aqua-postgres psql -U "${POSTGRES_USER:-aquaculture}" -c "CREATE DATABASE aquaculture_observability" 2>&1 || true

  # ─────────────────────────────────────────────────────────────
  # WS10 / ADR-016 Phase E — one-shot schema migration container.
  #
  # Run aqua-db-migrate BEFORE service containers so schema state
  # is at the known-good version when gateway-api / auth-service
  # / every other backend boots.
  #
  # --exit-code-from aqua-db-migrate: compose blocks until the
  # container exits and surfaces its exit code to the script.
  # Exit 0 → proceed. Non-zero → abort deploy BEFORE service
  # containers ever start (services' depends_on
  # service_completed_successfully would enforce this at
  # compose level too, but the explicit early exit here gives
  # the operator a clear failure signal without compose's
  # more verbose error output).
  #
  # Phase 1 backward-compat: if the migration container fails
  # (exit code != 0), the deploy aborts. Services' own
  # createMigrationRunnerService is still in place as a
  # safety-net, but operators MUST fix the upstream issue
  # rather than relying on the fallback.
  # ─────────────────────────────────────────────────────────────
  run_db_migrate_or_exit "full deploy"

  echo "=== Starting all services ==="
  docker compose -f docker-compose.droplet.yml up -d --no-build 2>&1 || true

  echo "=== Waiting 90s for services to bootstrap ==="
  sleep 90

  # ARCH-NM-DNS: Graceful nginx reload after full deploy to ensure
  # all upstream hostnames are resolved to current container IPs.
  echo "=== Reloading nginx to pick up new container IPs ==="
  docker exec aqua-nginx nginx -s reload 2>&1 || true
  sleep 2

  # ARCH-GW-006: Force Apollo Gateway to recompose supergraph schema.
  # After backend services restart with new GraphQL types/fields, the
  # gateway may hold a stale supergraph from the previous composition.
  # The pollIntervalInMs (300s) would eventually refresh it, but during
  # that window frontend queries for new fields return 400.
  # Restarting the gateway forces immediate schema introspection.
  echo "=== Restarting gateway for schema recomposition ==="
  docker compose -f docker-compose.droplet.yml restart gateway-api 2>&1 || true
  sleep 15

else
  # ── Selective deploy mode (only affected services) ──
  echo "=== SELECTIVE DEPLOY: ${DEPLOY_SERVICES} ==="

  # ARCH-031: Pre-deploy NATS JetStream storage maintenance (selective path).
  echo "=== NATS JetStream storage maintenance ==="
  NATS_DATA_DIR="/var/lib/docker/volumes/aqua-saas_nats_data/_data/jetstream"
  if [ -d "$NATS_DATA_DIR" ]; then
    JS_SIZE=$(du -sm "$NATS_DATA_DIR" 2>/dev/null | awk '{print $1}')
    echo "JetStream storage usage: ${JS_SIZE:-0}MB / 2048MB limit"
    if [ "${JS_SIZE:-0}" -gt 1800 ]; then
      echo "⚠️  JetStream storage near limit (${JS_SIZE}MB > 1800MB). Purging old data..."
      docker stop aqua-nats 2>/dev/null || true
      rm -rf "$NATS_DATA_DIR"
      echo "JetStream data purged. Streams will be recreated on startup."
    fi
  else
    echo "No existing JetStream data directory found"
  fi

  # Per-service credential provisioning (same as full deploy path).
  # ADR-015: no NATS client-auth credential provisioning here —
  # mTLS cert CN IS identity. Only legacy internal bookkeeping
  # credentials + DB role passwords get generated.
  echo "=== Ensuring per-service credentials exist ==="
  ENV_FILE="/var/aqua-saas/.env"
  generate_credential() {
    local VAR_NAME="$1"
    if grep -q "^${VAR_NAME}=" "$ENV_FILE" 2>/dev/null; then
      echo "  ${VAR_NAME}: already set"
    else
      local VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
      echo "${VAR_NAME}=${VALUE}" >> "$ENV_FILE"
      echo "  ${VAR_NAME}: generated"
    fi
  }
  # NATS per-service internal bookkeeping (legacy; see full-deploy
  # block above for BACKLOG-NATS-003 to audit whether any pipeline
  # step still consumes these).
  for SVC in AUTH FARM SENSOR GATEWAY NOTIFICATION BILLING ALERT HR MESSAGING HYDROPONICS; do
    generate_credential "NATS_${SVC}_SVC_USER"
    generate_credential "NATS_${SVC}_SVC_PASS"
  done
  for SVC in AUTH FARM SENSOR BILLING HR ALERT ADMIN GATEWAY NOTIFICATION HYDROPONICS MESSAGING; do
    generate_credential "${SVC}_SERVICE_DB_PASS"
  done

  # Application secrets
  generate_credential "WEBHOOK_ENCRYPTION_KEY"

  # Ensure infrastructure services are running (no-op if already up)
  echo "=== Ensuring infrastructure is running ==="
  docker compose -f docker-compose.droplet.yml up -d --no-build postgres redis nats mosquitto minio nginx 2>&1 || true
  sleep 5

  # ─────────────────────────────────────────────────────────────
  # WS10 / ADR-016 Phase E — one-shot schema migration container.
  #
  # Even on a selective deploy, run aqua-db-migrate before the
  # affected services restart. Pending migrations only land on
  # services that were changed, but the migration SET typically
  # spans schemas a service change did not touch (e.g. a shared
  # auth-schema tenant_id column rename lands in auth-service's
  # own migration but other services' RLS policies depend on
  # the new column name). Running the full migration pass keeps
  # schema state coherent regardless of which services this
  # deploy restarts.
  # ─────────────────────────────────────────────────────────────
  run_db_migrate_or_exit "selective deploy"

  echo "=== Pulling affected images sequentially: ${DEPLOY_SERVICES} ==="
  for svc in ${DEPLOY_SERVICES}; do
    echo "  Pulling $svc..."
    docker compose -f docker-compose.droplet.yml pull "$svc" 2>&1 || echo "  WARN: $svc pull failed, continuing..."
  done

  echo "=== Restarting affected services (no-deps): ${DEPLOY_SERVICES} ==="
  docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build ${DEPLOY_SERVICES} 2>&1 || true

  echo "=== Waiting 30s for services to bootstrap ==="
  sleep 30

  # ARCH-NM-DNS: Graceful nginx reload after container recreation.
  # Belt-and-suspenders: the nginx config uses resolver + variable proxy_pass
  # for dynamic DNS, but a reload ensures immediate resolution of new IPs
  # without waiting for the resolver TTL to expire.
  echo "=== Reloading nginx to pick up new container IPs ==="
  docker exec aqua-nginx nginx -s reload 2>&1 || docker compose -f docker-compose.droplet.yml restart nginx 2>&1 || true
  sleep 2

  # ARCH-GW-006: Force gateway schema recomposition when backend services change.
  # Only restart gateway when a backend subgraph service was deployed, since
  # frontend-only deploys don't affect the supergraph schema.
  BACKEND_PATTERN="gateway-api|auth-service|farm-service|sensor-service|alert-engine|billing-service|hr-service|hydroponics-service|notification-service|config-service|messaging-service"
  if echo "${DEPLOY_SERVICES}" | grep -qE "${BACKEND_PATTERN}"; then
    echo "=== Backend subgraph changed — restarting gateway for schema recomposition ==="
    docker compose -f docker-compose.droplet.yml restart gateway-api 2>&1 || true
    sleep 15
  fi
fi

echo "=== Container health status ==="
docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true

dump_nonhealthy_container_logs "pre-health-gate"

# ADR-016 Phase C / WS6 — criticality-aware multi-service health
# gate. Replaces the old "poll only gateway-api /health/live" block
# that silently passed when other backends crash-looped (2026-04-14
# cascade failure mode). The script reads
# `infrastructure/deploy/service-criticality.yaml`. Critical failures
# rollback; required failures fail the deploy without rollback so an
# operator can inspect the optional rollout surface in place.
# Warning-level failures surface as warnings.
# Uses Node 22 built-in TypeScript type-stripping so no
# tsc/tsx/python is required on the droplet — Node is already
# a base dependency for the service containers.
echo "=== Waiting for critical/required services ==="
set +e
COMPOSE_FILE=docker-compose.droplet.yml \
  MANIFEST=infrastructure/deploy/service-criticality.yaml \
  POLL_INTERVAL=10 \
  node scripts/deploy/check-service-health.ts
HEALTH_STATUS=$?
set -e
if [ "${HEALTH_STATUS}" -eq 1 ]; then
  docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  dump_nonhealthy_container_logs "post-health-gate-failure"
  echo "::error::Critical service health check failed. Initiating rollback."
  if [ -n "$PREV_GATEWAY" ]; then
    echo "Rolling back to previous gateway image: ${PREV_GATEWAY}"
    docker tag "${PREV_GATEWAY}" $(docker compose -f docker-compose.droplet.yml config | grep 'image:.*gateway-api' | awk '{print $2}' | head -1) 2>/dev/null || true
    docker compose -f docker-compose.droplet.yml up -d --no-build --remove-orphans
    echo "Rollback complete. Please investigate the failed deploy."
  else
    echo "No previous image digest available; manual intervention required."
  fi
  exit 1
elif [ "${HEALTH_STATUS}" -eq 3 ]; then
  docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  dump_nonhealthy_container_logs "post-required-health-failure"
  echo "::error::Required service health check failed. Deploy failed without rollback."
  exit 1
elif [ "${HEALTH_STATUS}" -ne 0 ]; then
  docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  dump_nonhealthy_container_logs "post-health-invocation-failure"
  echo "::error::Service health check could not run (exit ${HEALTH_STATUS}). Deploy failed without rollback."
  exit 1
fi

# ADR-016 Phase F / WS7 — boot-signal assertion. "Healthy"
# is necessary but not sufficient for deploy success — a
# service can be healthy while silently skipping NATS mTLS,
# schema-drift scan, or migration runner. This step greps
# `docker compose logs` for canonical signal strings
# declared in required-signals.yaml. Missing signal =
# failed deploy = rollback.
echo "=== Asserting boot signals ==="
if ! COMPOSE_FILE=docker-compose.droplet.yml \
     MANIFEST=infrastructure/deploy/required-signals.yaml \
     POLL_INTERVAL=10 \
     node scripts/deploy/assert-service-signals.ts; then
  echo "::error::Boot signal assertion failed. Initiating rollback."
  if [ -n "$PREV_GATEWAY" ]; then
    echo "Rolling back to previous gateway image: ${PREV_GATEWAY}"
    docker tag "${PREV_GATEWAY}" $(docker compose -f docker-compose.droplet.yml config | grep 'image:.*gateway-api' | awk '{print $2}' | head -1) 2>/dev/null || true
    docker compose -f docker-compose.droplet.yml up -d --no-build --remove-orphans
    echo "Rollback complete. Investigate why required signals did not fire."
  else
    echo "No previous image digest available; manual intervention required."
  fi
  exit 1
fi

echo "=== Cleanup old images ==="
run_image_prune_best_effort "dangling images" -f --filter "dangling=true"
run_image_prune_best_effort "stale images" -f --filter "until=24h" --filter "label!=deployed=current"

echo "=== Container status ==="
docker compose -f docker-compose.droplet.yml ps
