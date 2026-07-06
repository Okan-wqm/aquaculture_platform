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
#   IMAGE_PREFIX      — GHCR image prefix (defaults to this repository)
# =============================================================================

set -euo pipefail

# Deploy filesystem SSoT + the SHA-pinned checkout materializer. This script
# runs from the dedicated, deploy-owned DEPLOY_CHECKOUT_DIR worktree — NOT the
# interactive /var/aqua-saas working tree — so a parallel engineering/agent
# session checking out a feature branch can never fight or false-fail the
# deploy. deploy-paths.sh is loaded from the persistent source repo because
# THIS file may itself be executing from the freshly-materialized checkout, and
# that checkout is what the materialize routine (provided by the snippet)
# pins to DEPLOY_SHA before we cd into it below.
# shellcheck source=scripts/deploy/deploy-paths.sh
source "${DEPLOY_SOURCE_REPO:-/var/aqua-saas}/scripts/deploy/deploy-paths.sh"

IMAGE_PREFIX="${IMAGE_PREFIX:-ghcr.io/okan-wqm/aquaculture_platform}"
TAG="${TAG:-${DEPLOY_SHA:-}}"
export TAG
GATEWAY_IMAGE_REF="${IMAGE_PREFIX}/gateway-api:latest"
DEPLOY_RELEASE_ID="${DEPLOY_RELEASE_ID:-${DEPLOY_SHA:-unknown}-$(date -u +%Y%m%dT%H%M%SZ)}"
export DEPLOY_RELEASE_ID
DEPLOY_STATE_ROOT="${DEPLOY_STATE_ROOT:-/var/lib/aqua/deploy/releases}"
DEPLOY_STATE_DIR="${DEPLOY_STATE_DIR:-${DEPLOY_STATE_ROOT}/${DEPLOY_RELEASE_ID}}"
export DEPLOY_STATE_DIR
mkdir -p "${DEPLOY_STATE_DIR}"
ROLLBACK_MANIFEST="${ROLLBACK_MANIFEST:-${DEPLOY_STATE_DIR}/rollback-images.tsv}"
export ROLLBACK_MANIFEST
DEPLOY_IMAGE_DIGESTS_FILE="${DEPLOY_IMAGE_DIGESTS_FILE:-${DEPLOY_STATE_DIR}/image-digests.tsv}"
export DEPLOY_IMAGE_DIGESTS_FILE

CATALOG_DEPLOY_ENV="${CATALOG_DEPLOY_ENV:-infrastructure/deploy/service-catalog.deploy.vars}"
if [ ! -r "${CATALOG_DEPLOY_ENV}" ]; then
  echo "::error::Missing generated service catalog deploy artifact: ${CATALOG_DEPLOY_ENV}"
  echo "  Run npm run service-catalog:generate and commit the generated artifact."
  exit 1
fi
# shellcheck source=infrastructure/deploy/service-catalog.deploy.vars
. "${CATALOG_DEPLOY_ENV}"
APPLICATION_IMAGE_SERVICES="${CATALOG_APPLICATION_IMAGE_SERVICES:?generated application image services missing}"
SERVICE_DB_ROLES="${CATALOG_SERVICE_DB_ROLE_PREFIXES:?generated service DB role prefixes missing}"

if [ -n "${DEPLOY_IMAGE_DIGESTS_B64:-}" ]; then
  printf '%s' "${DEPLOY_IMAGE_DIGESTS_B64}" | base64 -d > "${DEPLOY_IMAGE_DIGESTS_FILE}"
fi

OWN_DOCKER_CONFIG=false
if [ -z "${DOCKER_CONFIG:-}" ]; then
  DOCKER_CONFIG="$(mktemp -d /tmp/aqua-docker-config.XXXXXX)"
  export DOCKER_CONFIG
  OWN_DOCKER_CONFIG=true
fi

cleanup_docker_auth() {
  if [ "${OWN_DOCKER_CONFIG}" = "true" ] && [ -n "${DOCKER_CONFIG:-}" ]; then
    docker logout ghcr.io >/dev/null 2>&1 || true
    rm -rf "${DOCKER_CONFIG}"
  fi
}
trap cleanup_docker_auth EXIT

ACTIVE_COMPOSE_PROFILES="${COMPOSE_PROFILES:-}"
if [ -z "${ACTIVE_COMPOSE_PROFILES}" ] && [ -f "${DEPLOY_ENV_FILE}" ]; then
  ACTIVE_COMPOSE_PROFILES="$(grep -E '^COMPOSE_PROFILES=' "${DEPLOY_ENV_FILE}" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
fi
case ",${ACTIVE_COMPOSE_PROFILES// /,}," in
  *",rust-sidecar,"*)
    echo "::error::COMPOSE_PROFILES includes rust-sidecar, but sensor-ingestion is not in the production immutable image matrix."
    echo "  Refusing production deploy. Add sensor-ingestion to APPLICATION_IMAGE_SERVICES and the deploy image matrix before enabling this profile."
    exit 1
    ;;
esac

# ──────────────────────────────────────────────────────────────────────────
# ADR-031 — Service DB-role password SSoT
#
# The platform-bootstrap atom
# (apps/db-migrate/src/platform-bootstrap.service.ts) fails loud at Phase 0
# if any *_SERVICE_DB_PASS env var is missing or empty. THIS script's
# generate_credential loop provisions those passwords from the generated
# platform service catalog deploy artifact.
#
# Adding a new service-role requires a catalog runtime dbRole; this script
# must not carry a hand-written duplicate list.
#
# 2026-05-19: AI, OBSERVABILITY, EVENT_STORE, CONFIG appended after the
# 2026-05-18 cutover deploy 26082203809 aborted at:
#   [platform-bootstrap] Phase 0 abort: 4/15 service-role password env
#   vars are missing or empty: AI_SERVICE_DB_PASS, OBSERVABILITY_SERVICE_DB_PASS,
#   EVENT_STORE_SERVICE_DB_PASS, CONFIG_SERVICE_DB_PASS.
#
# The full-deploy and selective-deploy paths both consume SERVICE_DB_ROLES,
# which is derived from CATALOG_SERVICE_DB_ROLE_PREFIXES above.
# ──────────────────────────────────────────────────────────────────────────
read_env_file_value() {
  local name="$1"
  local file="${2:-${DEPLOY_ENV_FILE}}"

  if [ ! -r "$file" ]; then
    return 0
  fi

  grep -E "^${name}=" "$file" 2>/dev/null | tail -1 | cut -d= -f2- || true
}

generate_credential() {
  local VAR_NAME="$1"
  local ENV_FILE="${2:-${DEPLOY_ENV_FILE}}"
  touch "${ENV_FILE}"
  if grep -q "^${VAR_NAME}=" "${ENV_FILE}" 2>/dev/null; then
    echo "  ${VAR_NAME}: already set"
  else
    local VALUE
    VALUE=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
    echo "${VAR_NAME}=${VALUE}" >> "${ENV_FILE}"
    echo "  ${VAR_NAME}: generated"
  fi
}

redact_sensitive() {
  sed -E \
    -e 's/([A-Za-z0-9_]*(PASSWORD|TOKEN|SECRET|PRIVATE_KEY|API_KEY|ACCESS_KEY|PEPPER)[A-Za-z0-9_]*=)[^[:space:]]+/\1[REDACTED]/gI' \
    -e 's#(postgres(ql)?|redis|rediss|mongodb|mysql)://[^[:space:]]+#\1://[REDACTED]#gI' \
    -e 's/(Authorization:[[:space:]]*(Bearer|Basic)[[:space:]]+)[A-Za-z0-9._~+\/=-]+/\1[REDACTED]/gI' \
    -e 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/[JWT_REDACTED]/g' \
    -e 's/-----BEGIN [^-]+ PRIVATE KEY-----[^[:space:]]*/-----BEGIN PRIVATE KEY-----[REDACTED]/g'
}

run_redacted() {
  "$@" 2>&1 | redact_sensitive
}

dump_nonhealthy_container_logs() {
  local label="${1:-snapshot}"
  echo "=== Logs from non-healthy/restarting containers (${label}) ==="
  for c in $(docker ps -a --format '{{.Names}}' --filter "label=com.docker.compose.project=aqua-saas"); do
    HEALTH=$(docker inspect --format='{{.State.Health.Status}}' "$c" 2>/dev/null || echo "none")
    RESTARTS=$(docker inspect --format='{{.RestartCount}}' "$c" 2>/dev/null || echo "0")
    if [ "$HEALTH" != "healthy" ] || [ "$RESTARTS" -gt 0 ] 2>/dev/null; then
      echo "--- $c (health=$HEALTH, restarts=$RESTARTS) last 200 lines ---"
      docker logs --tail 200 "$c" 2>&1 | redact_sensitive || true
    fi
  done
}

run_db_migrate_or_exit() {
  local deploy_mode="${1:-deploy}"

  echo "=== Running aqua-db-migrate (one-shot schema runner) ==="
  # db-migrate is the only schema writer. It must always be the immutable
  # image built for DEPLOY_SHA; pulling compose `latest` can reuse a failed
  # prior migration bundle and advance schema from the wrong release.
  pull_deploy_image_required "db-migrate"

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
    docker logs aqua-db-migrate --tail=500 2>&1 | redact_sensitive || true
    echo "--- db-migrate/postgres status ---"
    docker compose -f docker-compose.droplet.yml ps db-migrate postgres 2>&1 || true
    docker compose -f docker-compose.droplet.yml stop db-migrate 2>&1 || true
    record_release_ledger "failed" "db_migrate_timeout"
    exit 1
  elif [ "${DB_MIGRATE_STATUS}" -ne 0 ]; then
    echo "::error::aqua-db-migrate failed during ${deploy_mode} — aborting BEFORE service containers start."
    echo "--- aqua-db-migrate logs (last 500 lines) ---"
    docker logs aqua-db-migrate --tail=500 2>&1 | redact_sensitive || true
    record_release_ledger "failed" "db_migrate"
    exit 1
  fi

  echo "  aqua-db-migrate completed successfully"
}

is_application_image_service() {
  local svc="$1"

  case " ${APPLICATION_IMAGE_SERVICES} " in
    *" ${svc} "*) return 0 ;;
    *) return 1 ;;
  esac
}

image_ref_for_service() {
  local svc="$1"
  echo "${IMAGE_PREFIX}/${svc}:latest"
}

deploy_tag_ref_for_service() {
  local svc="$1"
  echo "${IMAGE_PREFIX}/${svc}:${DEPLOY_SHA}"
}

digest_ref_for_service() {
  local svc="$1"
  if [ -s "${DEPLOY_IMAGE_DIGESTS_FILE}" ]; then
    awk -F '\t' -v svc="${svc}" '$1 == svc {print $2 "@" $3; exit}' "${DEPLOY_IMAGE_DIGESTS_FILE}" 2>/dev/null || true
  fi
}

deploy_includes_service() {
  local svc="$1"

  case " ${DEPLOY_SERVICES:-} " in
    *" ${svc} "*) return 0 ;;
    *) return 1 ;;
  esac
}

classify_pull_failure() {
  local log_file="$1"
  if grep -qi 'no space left on device' "${log_file}" 2>/dev/null; then
    echo "image_pull_no_space"
  elif grep -Eqi 'manifest unknown|not found|name unknown|unknown tag' "${log_file}" 2>/dev/null; then
    echo "image_pull_manifest_missing"
  elif grep -Eqi 'unauthorized|denied|forbidden|authentication required' "${log_file}" 2>/dev/null; then
    echo "image_pull_unauthorized"
  else
    echo "image_pull_network_timeout"
  fi
}

record_no_state_changed_failure() {
  local phase="$1"
  export ROLLBACK_SKIPPED_REASON="no_state_changed"
  export SCHEMA_MAY_BE_FORWARD="false"
  record_release_ledger "failed" "${phase}" || true
}

pull_deploy_image_required() {
  local svc="$1"
  local attempts="${DEPLOY_PULL_ATTEMPTS:-4}"
  local delay="${DEPLOY_PULL_RETRY_SECONDS:-15}"
  local image="${IMAGE_PREFIX}/${svc}"
  local immutable_ref
  local compose_ref="${image}:latest"
  local deploy_tag_ref="${image}:${DEPLOY_SHA}"
  local attempt
  local pull_log
  local phase="image_pull_network_timeout"

  if [ -z "${DEPLOY_SHA:-}" ]; then
    echo "::error::DEPLOY_SHA is required for immutable deploy image pulls."
    return 1
  fi

  immutable_ref="$(digest_ref_for_service "${svc}")"
  if [ -z "${immutable_ref}" ]; then
    immutable_ref="${deploy_tag_ref}"
  fi
  pull_log="$(mktemp)"

  for attempt in $(seq 1 "${attempts}"); do
    echo "  Pulling ${svc} (${immutable_ref}) [attempt ${attempt}/${attempts}]..."
    if docker pull "${immutable_ref}" >"${pull_log}" 2>&1; then
      redact_sensitive < "${pull_log}"
      docker tag "${immutable_ref}" "${compose_ref}"
      docker tag "${immutable_ref}" "${deploy_tag_ref}" 2>/dev/null || true
      echo "  ${svc}: pinned ${compose_ref} to ${immutable_ref}"
      rm -f "${pull_log}"
      return 0
    fi
    redact_sensitive < "${pull_log}"
    phase="$(classify_pull_failure "${pull_log}")"

    if [ "${attempt}" -lt "${attempts}" ]; then
      echo "  WARN: ${svc} pull failed; retrying in ${delay}s..."
      sleep "${delay}"
    fi
  done

  echo "::error::Required image pull failed for ${svc} (${immutable_ref}) after ${attempts} attempt(s)."
  echo "  Aborting BEFORE service restart so the deploy cannot keep running stale images."
  record_no_state_changed_failure "${phase}"
  rm -f "${pull_log}"
  return 1
}

capture_rollback_manifest() {
  echo "=== Capturing current application image digests for rollback ==="
  : > "${ROLLBACK_MANIFEST}"

  local svc
  local container_id
  local image_id
  for svc in ${APPLICATION_IMAGE_SERVICES}; do
    [ "$svc" = "db-migrate" ] && continue
    container_id=$(docker compose -f docker-compose.droplet.yml ps -q "$svc" 2>/dev/null || true)
    if [ -z "${container_id}" ]; then
      continue
    fi
    image_id=$(docker inspect --format='{{.Image}}' "${container_id}" 2>/dev/null || true)
    if [ -n "${image_id}" ]; then
      printf '%s\t%s\n' "$svc" "$image_id" >> "${ROLLBACK_MANIFEST}"
    fi
  done

  local captured
  captured=$(wc -l < "${ROLLBACK_MANIFEST}" 2>/dev/null || echo 0)
  echo "  Captured ${captured} service image(s) in ${ROLLBACK_MANIFEST}"

  if [ -s "${ROLLBACK_MANIFEST}" ]; then
    while IFS="$(printf '\t')" read -r svc image_id; do
      [ -n "${svc}" ] || continue
      [ -n "${image_id}" ] || continue
      docker tag "${image_id}" "${IMAGE_PREFIX}/${svc}:rollback-${DEPLOY_RELEASE_ID}" 2>/dev/null || true
    done < "${ROLLBACK_MANIFEST}"
    sha256sum "${ROLLBACK_MANIFEST}" | awk '{print $1}' > "${DEPLOY_STATE_DIR}/rollback-images.sha256"
    echo "  Rollback manifest sha256: $(cat "${DEPLOY_STATE_DIR}/rollback-images.sha256")"
  fi
}

rollback_deployed_services() {
  local reason="${1:-deploy failure}"

  echo "=== Rolling back application images (${reason}) ==="
  if [ ! -s "${ROLLBACK_MANIFEST}" ]; then
    echo "::error::No rollback manifest available; manual intervention required."
    return 1
  fi

  local scope_services=()
  local svc
  if [ "${FULL_DEPLOY:-false}" = "true" ]; then
    for svc in ${APPLICATION_IMAGE_SERVICES}; do
      [ "$svc" = "db-migrate" ] && continue
      scope_services+=("$svc")
    done
  else
    while IFS= read -r svc; do
      [ -n "$svc" ] || continue
      scope_services+=("$svc")
    done < <(restartable_deploy_services)
  fi

  if [ "${#scope_services[@]}" -eq 0 ]; then
    echo "  No long-running service images were changed; rollback has no restart scope."
    return 0
  fi

  local image_id
  local restored=0
  for svc in "${scope_services[@]}"; do
    image_id="$(awk -F "$(printf '\t')" -v svc="${svc}" '$1 == svc {print $2; exit}' "${ROLLBACK_MANIFEST}")"
    if [ -z "${image_id}" ]; then
      echo "::warning::Rollback manifest has no prior image for ${svc}; leaving its current image tag unchanged."
      continue
    fi
    echo "  ${svc}: restoring $(image_ref_for_service "$svc") -> ${image_id}"
    docker tag "${image_id}" "$(image_ref_for_service "$svc")" 2>/dev/null || true
    docker tag "${image_id}" "$(deploy_tag_ref_for_service "$svc")" 2>/dev/null || true
    restored=$((restored + 1))
  done

  if [ "${restored}" -eq 0 ]; then
    echo "::error::Rollback scope had no restorable images."
    return 1
  fi

  docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build --force-recreate "${scope_services[@]}"
}

restartable_deploy_services() {
  local svc
  for svc in ${DEPLOY_SERVICES}; do
    [ "$svc" = "db-migrate" ] && continue
    echo "$svc"
  done
}

migration_manifest_hash() {
  local files
  files=$(git ls-files 'apps/*/src/**/migrations/[0-9]*.ts' \
    'apps/*/src/migrations/[0-9]*.ts' \
    'apps/*/src/database/migrations/[0-9]*.ts' \
    'apps/db-migrate/src/schema-registry.ts' 2>/dev/null | sort || true)

  if [ -z "${files}" ]; then
    echo ""
    return 0
  fi

  printf '%s\n' "${files}" | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
}

current_image_digest_json() {
  local json="{"
  local sep=""
  local svc
  local image_id

  for svc in ${APPLICATION_IMAGE_SERVICES}; do
    image_id=$(docker image inspect --format='{{.Id}}' "$(image_ref_for_service "$svc")" 2>/dev/null || true)
    if [ -z "${image_id}" ]; then
      continue
    fi
    json="${json}${sep}\"${svc}\":\"${image_id}\""
    sep=","
  done

  json="${json}}"
  echo "${json}"
}

deploy_metadata_json() {
  local capacity="{}"
  local image_manifest_hash=""

  if [ -s "${DEPLOY_STATE_DIR}/capacity-snapshot.json" ]; then
    capacity="$(cat "${DEPLOY_STATE_DIR}/capacity-snapshot.json")"
  fi
  if [ -s "${DEPLOY_IMAGE_DIGESTS_FILE}" ]; then
    image_manifest_hash="$(sha256sum "${DEPLOY_IMAGE_DIGESTS_FILE}" | awk '{print $1}')"
  fi

  printf '{"capacity":%s,"imageDigestManifestSha256":"%s","deployMode":"%s","fullDeploy":%s}' \
    "${capacity}" \
    "${image_manifest_hash}" \
    "${DEPLOY_MODE:-unknown}" \
    "$([ "${FULL_DEPLOY:-false}" = "true" ] && echo true || echo false)"
}

rollback_manifest_sha256() {
  if [ -s "${ROLLBACK_MANIFEST}" ]; then
    sha256sum "${ROLLBACK_MANIFEST}" | awk '{print $1}'
  else
    echo ""
  fi
}

schema_may_be_forward_for() {
  local status="$1"
  local phase="$2"
  if [ "${SCHEMA_MAY_BE_FORWARD:-false}" = "true" ]; then
    echo "true"
    return 0
  fi
  case "${phase}" in
    critical_health|required_health|readiness|boot_signal|release_sql)
      echo "true"
      ;;
    *)
      case "${status}" in
        rollback_attempted|rollback_verified|rollback_failed|rolled_back)
          echo "true"
          ;;
        *)
          echo "false"
          ;;
      esac
      ;;
  esac
}

record_release_ledger() {
  local status="$1"
  local failure_phase="${2:-}"
  local db_name="${POSTGRES_DB:-aquaculture}"
  local operator="${GHCR_ACTOR:-${GITHUB_ACTOR:-unknown}}"
  local image_digests
  local db_migrate_image
  local manifest_hash
  local deploy_metadata
  local rollback_hash
  local schema_may_be_forward
  local rollback_skipped_reason="${ROLLBACK_SKIPPED_REASON:-}"

  if ! docker ps --format '{{.Names}}' | grep -qx 'aqua-postgres'; then
    echo "::warning::Cannot record release ledger status=${status}: aqua-postgres is not running."
    case "${status}" in
      db_complete|apps_restarting|promoted|rollback_attempted|rollback_verified|rollback_failed|rolled_back)
        return 1
        ;;
      *)
        return 0
        ;;
    esac
  fi

  image_digests="$(current_image_digest_json)"
  db_migrate_image=$(docker image inspect --format='{{.Id}}' "$(image_ref_for_service db-migrate)" 2>/dev/null || true)
  manifest_hash="$(migration_manifest_hash || true)"
  deploy_metadata="$(deploy_metadata_json || echo '{}')"
  rollback_hash="$(rollback_manifest_sha256 || true)"
  schema_may_be_forward="$(schema_may_be_forward_for "${status}" "${failure_phase}")"

  set +e
  docker exec -i aqua-postgres psql \
    -U "${POSTGRES_USER:-aquaculture}" \
    -d "${db_name}" \
    -v ON_ERROR_STOP=1 \
    -v release_id="${DEPLOY_RELEASE_ID:-${DEPLOY_SHA:-unknown}}" \
    -v git_sha="${DEPLOY_SHA:-unknown}" \
    -v db_migrate_image="${db_migrate_image}" \
    -v migration_manifest_hash="${manifest_hash}" \
    -v image_digests="${image_digests}" \
    -v deploy_metadata="${deploy_metadata}" \
    -v rollback_manifest_sha256="${rollback_hash}" \
    -v schema_may_be_forward="${schema_may_be_forward}" \
    -v rollback_skipped_reason="${rollback_skipped_reason}" \
    -v status="${status}" \
    -v failure_phase="${failure_phase}" \
    -v operator="${operator}" <<'SQL'
INSERT INTO platform.release_ledger (
  release_id,
  git_sha,
  db_migrate_image,
  migration_manifest_hash,
  expected_heads,
  applied_heads,
  tenant_schema_set,
  tenant_fanout,
  image_digests,
  deploy_metadata,
  rollback_manifest_sha256,
  schema_may_be_forward,
  rollback_skipped_reason,
  status,
  failure_phase,
  rollback_attempted,
  rollback_verified,
  rollback_failed,
  operator,
  completed_at
) VALUES (
  :'release_id',
  :'git_sha',
  NULLIF(:'db_migrate_image', ''),
  NULLIF(:'migration_manifest_hash', ''),
  '{}'::jsonb,
  '{}'::jsonb,
  '[]'::jsonb,
  '{}'::jsonb,
  COALESCE(NULLIF(:'image_digests', '')::jsonb, '{}'::jsonb),
  COALESCE(NULLIF(:'deploy_metadata', '')::jsonb, '{}'::jsonb),
  NULLIF(:'rollback_manifest_sha256', ''),
  :'schema_may_be_forward'::boolean,
  NULLIF(:'rollback_skipped_reason', ''),
  :'status',
  NULLIF(:'failure_phase', ''),
  :'status' IN ('rollback_attempted', 'rollback_verified', 'rollback_failed', 'rolled_back'),
  :'status' IN ('rollback_verified', 'rolled_back'),
  :'status' = 'rollback_failed',
  NULLIF(:'operator', ''),
  CASE WHEN :'status' IN ('promoted', 'failed', 'rollback_verified', 'rollback_failed', 'rolled_back') THEN NOW() ELSE NULL END
)
ON CONFLICT (release_id) DO UPDATE SET
  git_sha = EXCLUDED.git_sha,
  db_migrate_image = EXCLUDED.db_migrate_image,
  migration_manifest_hash = EXCLUDED.migration_manifest_hash,
  expected_heads = CASE
    WHEN EXCLUDED.expected_heads = '{}'::jsonb THEN platform.release_ledger.expected_heads
    ELSE EXCLUDED.expected_heads
  END,
  applied_heads = CASE
    WHEN EXCLUDED.applied_heads = '{}'::jsonb THEN platform.release_ledger.applied_heads
    ELSE EXCLUDED.applied_heads
  END,
  tenant_schema_set = CASE
    WHEN EXCLUDED.tenant_schema_set = '[]'::jsonb THEN platform.release_ledger.tenant_schema_set
    ELSE EXCLUDED.tenant_schema_set
  END,
  tenant_fanout = CASE
    WHEN EXCLUDED.tenant_fanout = '{}'::jsonb THEN platform.release_ledger.tenant_fanout
    ELSE EXCLUDED.tenant_fanout
  END,
  image_digests = EXCLUDED.image_digests,
  deploy_metadata = EXCLUDED.deploy_metadata,
  rollback_manifest_sha256 = COALESCE(EXCLUDED.rollback_manifest_sha256, platform.release_ledger.rollback_manifest_sha256),
  schema_may_be_forward = platform.release_ledger.schema_may_be_forward OR EXCLUDED.schema_may_be_forward,
  rollback_skipped_reason = COALESCE(EXCLUDED.rollback_skipped_reason, platform.release_ledger.rollback_skipped_reason),
  status = EXCLUDED.status,
  failure_phase = EXCLUDED.failure_phase,
  rollback_attempted = platform.release_ledger.rollback_attempted OR EXCLUDED.rollback_attempted,
  rollback_verified = platform.release_ledger.rollback_verified OR EXCLUDED.rollback_verified,
  rollback_failed = platform.release_ledger.rollback_failed OR EXCLUDED.rollback_failed,
  operator = EXCLUDED.operator,
  completed_at = EXCLUDED.completed_at,
  updated_at = NOW();
SQL
  local rc=$?
  set -e

  if [ "${rc}" -ne 0 ]; then
    echo "::warning::Failed to record platform.release_ledger status=${status}."
    case "${status}" in
      db_complete|apps_restarting|promoted|rollback_attempted|rollback_verified|rollback_failed|rolled_back)
        echo "::error::Release ledger write is mandatory after platform bootstrap; aborting."
        return 1
        ;;
      *)
        echo "::warning::Continuing because this is a pre-bootstrap/failure audit write."
        return 0
        ;;
    esac
  else
    echo "  Release ledger recorded: ${DEPLOY_RELEASE_ID:-${DEPLOY_SHA:-unknown}} status=${status}${failure_phase:+ phase=${failure_phase}}"
  fi
}

verify_rollback_images() {
  if [ ! -s "${ROLLBACK_MANIFEST}" ]; then
    echo "::error::Rollback manifest missing; cannot verify rollback image IDs."
    return 1
  fi

  local svc
  local expected_image
  local container_id
  local actual_image
  local mismatches=0

  while IFS="$(printf '\t')" read -r svc expected_image; do
    [ -n "${svc}" ] || continue
    container_id=$(docker compose -f docker-compose.droplet.yml ps -q "$svc" 2>/dev/null || true)
    if [ -z "${container_id}" ]; then
      echo "::error::Rollback verification: ${svc} container not found."
      mismatches=$((mismatches + 1))
      continue
    fi
    actual_image=$(docker inspect --format='{{.Image}}' "${container_id}" 2>/dev/null || true)
    if [ "${actual_image}" != "${expected_image}" ]; then
      echo "::error::Rollback verification: ${svc} image mismatch expected=${expected_image} actual=${actual_image}"
      mismatches=$((mismatches + 1))
    fi
  done < "${ROLLBACK_MANIFEST}"

  [ "${mismatches}" -eq 0 ]
}

rollback_and_record() {
  local reason="$1"

  record_release_ledger "rollback_attempted" "${reason}" || true
  if ! rollback_deployed_services "${reason}"; then
    record_release_ledger "rollback_failed" "${reason}" || true
    return 1
  fi

  sleep "${ROLLBACK_HEALTH_SETTLE_SECONDS:-30}"
  if verify_rollback_images && \
     COMPOSE_FILE=docker-compose.droplet.yml \
     MANIFEST=infrastructure/deploy/service-criticality.yaml \
     POLL_INTERVAL=10 \
     node scripts/deploy/check-service-health.ts; then
    record_release_ledger "rolled_back" "${reason}" || true
    return 0
  fi

  record_release_ledger "rollback_failed" "${reason}" || true
  return 1
}

check_ready_endpoint() {
  local svc="$1"
  local port="$2"
  local container_id

  container_id=$(docker compose -f docker-compose.droplet.yml ps -q "$svc" 2>/dev/null || true)
  if [ -z "${container_id}" ]; then
    echo "::error::Readiness sweep: ${svc} container not found."
    return 1
  fi

  docker exec "${container_id}" curl -sf "http://localhost:${port}/health/ready" >/dev/null
}

run_readiness_sweep() {
  echo "=== /health/ready sweep for critical services ==="
  local failures=0

  for spec in \
    "gateway-api:3000" \
    "auth-service:3000" \
    "farm-service:3000" \
    "sensor-service:3000" \
    "messaging-service:3000"; do
    local svc="${spec%%:*}"
    local port="${spec##*:}"
    if check_ready_endpoint "${svc}" "${port}"; then
      echo "  ${svc}: ready"
    else
      echo "::error::${svc}: /health/ready failed"
      failures=$((failures + 1))
    fi
  done

  [ "${failures}" -eq 0 ]
}

verify_release_ledger_sql() {
  local db_name="${POSTGRES_DB:-aquaculture}"
  local release_id="${DEPLOY_RELEASE_ID:-${DEPLOY_SHA:-unknown}}"

  echo "=== SQL release verification ==="
  docker exec -i aqua-postgres psql \
    -U "${POSTGRES_USER:-aquaculture}" \
    -d "${db_name}" \
    -v ON_ERROR_STOP=1 \
    -v release_id="${release_id}" \
    -v git_sha="${DEPLOY_SHA:-unknown}" <<'SQL'
SELECT set_config('aqua.deploy_release_id', :'release_id', false);
SELECT set_config('aqua.deploy_git_sha', :'git_sha', false);

DO $$
DECLARE
  rel platform.release_ledger%ROWTYPE;
  expected_release_id text := current_setting('aqua.deploy_release_id');
  expected_git_sha text := current_setting('aqua.deploy_git_sha');
BEGIN
  SELECT *
    INTO rel
    FROM platform.release_ledger
   WHERE release_id = expected_release_id
     AND git_sha = expected_git_sha
   ORDER BY updated_at DESC
   LIMIT 1;

  IF rel.release_id IS NULL THEN
    RAISE EXCEPTION 'release ledger row missing for release_id=%', expected_release_id;
  END IF;

  IF rel.expected_heads = '{}'::jsonb
     OR rel.applied_heads = '{}'::jsonb
     OR rel.expected_heads <> rel.applied_heads THEN
    RAISE EXCEPTION 'release ledger expected/applied heads missing or mismatched for release_id=%', expected_release_id;
  END IF;

  IF rel.status NOT IN ('db_complete', 'apps_restarting', 'promoted') THEN
    RAISE EXCEPTION 'release ledger status is not deploy-progress/promotable for release_id=% status=%',
      expected_release_id,
      rel.status;
  END IF;
END
$$;
SELECT 'ok' AS release_verification;
SQL
}

# SEC-CI-012: Pin the deploy source to the exact SHA that triggered the
# workflow (prevents TOCTOU race if another commit lands mid-deploy).
#
# The pin lands in the DEDICATED, deploy-owned DEPLOY_CHECKOUT_DIR worktree
# (detached HEAD), NOT the interactive /var/aqua-saas tree — the deploy and
# live engineering/agent sessions no longer share a working tree, so neither
# can drift the other's HEAD. `cd` into the pinned checkout so every relative
# path below (docker compose -f docker-compose.droplet.yml, infrastructure/...
# mounts, scripts/deploy/*) resolves to the SHA-pinned source.
echo "=== Pinning deploy source checkout ==="
materialize_deploy_checkout "${DEPLOY_SHA}"
cd "${DEPLOY_CHECKOUT_DIR}"

echo "Deploy release id: ${DEPLOY_RELEASE_ID}"
echo "Deploy state dir: ${DEPLOY_STATE_DIR}"

echo "=== Capacity preflight (before certs, secrets, pulls, migrations, restarts) ==="
if ! CAPACITY_GC_MODE="${CAPACITY_GC_MODE:-auto}" bash scripts/deploy/droplet-capacity.sh gate; then
  echo "::error::Capacity preflight failed before production state changed."
  record_no_state_changed_failure "disk_preflight_low_bytes"
  exit 1
fi

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
# Read TLS material from the persistent certs dir (DEPLOY_CERTS_DIR), which is
# symlinked into the checkout as ./certs — generate-internal-certs.sh writes
# there via that symlink, and docker-compose.droplet.yml bind-mounts ./certs.
CERT_RENEW=false
if [ -f "${DEPLOY_CERTS_DIR}/redis/redis-cert.pem" ]; then
  EXPIRY=$(openssl x509 -enddate -noout -in "${DEPLOY_CERTS_DIR}/redis/redis-cert.pem" 2>/dev/null | cut -d= -f2)
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
echo "=== Pre-flight: generated service DB credentials ==="
ENV_FILE="${DEPLOY_ENV_FILE}"
for SVC in ${SERVICE_DB_ROLES}; do
  generate_credential "${SVC}_SERVICE_DB_PASS" "${ENV_FILE}"
done

# Phase A2a — ensure required secrets exist in .env BEFORE interpolation.
# ORDERING IS LOAD-BEARING (INFRA-HIGH-007, 2026-06-11): this bootstrap
# used to run as Phase A4, AFTER the compose interpolation check — so a
# missing :?-required secret aborted the deploy before its generator
# ever ran, and #388's SERVICE_IDENTITY_KEYRING generator was dead code
# on the deploy path. Worse, compose's env-map iteration reports an
# ARBITRARY first-missing variable per run (Go map ordering), so serial
# deploys surfaced a different name each time and masked the full
# missing set. Generate-if-absent MUST precede the check that consumes
# the values.
#
# The REQUIRED set lives in scripts/deploy/lib/required-env-secrets.sh
# and is shared with droplet-bootstrap-env.sh so the preflight list and
# the bootstrap generator cannot drift (Tier-1 SSoT architectural fix).
# Bootstrap is strictly idempotent: generates only absent secrets,
# never rotates (rotation stays an incident-response ceremony — see
# docs/runbooks/secret-rotation.md).
echo "=== Pre-flight: required secrets presence ==="
# Bootstrap writes to the PERSISTENT secrets file (DEPLOY_ENV_FILE), never the
# ephemeral checkout. The bootstrap + lib scripts themselves come from the
# SHA-pinned checkout (relative paths; we cd'd there) so they match the
# deployed source exactly.
ENV_FILE="${DEPLOY_ENV_FILE}" bash scripts/deploy/droplet-bootstrap-env.sh
# shellcheck disable=SC1091
source scripts/deploy/lib/required-env-secrets.sh
MISSING=()
while IFS= read -r SECRET; do
  if ! grep -q "^${SECRET}=" "${DEPLOY_ENV_FILE}" 2>/dev/null; then
    MISSING+=("$SECRET")
  fi
done < <(required_env_secret_names)
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "::error::Still missing after bootstrap: ${MISSING[*]}"
  echo "  Bootstrap reported success but preflight re-check failed — investigate"
  echo "  ${DEPLOY_ENV_FILE} permissions and scripts/deploy/droplet-bootstrap-env.sh output."
  exit 1
fi
echo "  OK: ${#REQUIRED_ENV_SECRETS[@]} required secrets present"

echo "=== Pre-flight: compose interpolation ==="
if ! docker compose -f docker-compose.droplet.yml config --quiet; then
  echo "::error::docker-compose.droplet.yml interpolation failed."
  echo "  Likely cause: missing :? required env var in ${DEPLOY_ENV_FILE}"
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

# Phase A4 — (moved to Phase A2a above: generate-if-absent must precede
# the interpolation check that consumes the values — INFRA-HIGH-007.)

# End of pre-flight ──────────────────────────────────────────

# SEC-CI-001: GITHUB_TOKEN (packages:read) is substituted at template time by the
# GitHub Actions runner and masked as *** in all logs. Short-lived, run-scoped only.
echo "=== Logging into GHCR ==="
GHCR_LOGIN_ATTEMPTS="${GHCR_LOGIN_ATTEMPTS:-3}"
for attempt in $(seq 1 "${GHCR_LOGIN_ATTEMPTS}"); do
  echo "  GHCR login attempt ${attempt}/${GHCR_LOGIN_ATTEMPTS}"
  if echo "${GHCR_TOKEN}" | docker login ghcr.io -u "${GHCR_ACTOR}" --password-stdin; then
    echo "  GHCR login succeeded"
    break
  fi
  if [ "${attempt}" -eq "${GHCR_LOGIN_ATTEMPTS}" ]; then
    echo "::error::GHCR login failed after ${GHCR_LOGIN_ATTEMPTS} attempt(s)."
    exit 1
  fi
  sleep $((attempt * 5))
done

# ARCH-CI-007: Capture current image digests for rollback before pulling new images.
# This is stack-wide, not gateway-only: a failed auth/farm/sensor rollout must
# restore the exact service image that changed.
capture_rollback_manifest

# Scope boot-signal assertions to this deploy attempt. The asserter falls
# back to per-container StartedAt if this is absent, but an explicit since
# marker makes full and selective deploy log windows obvious in output.
export BOOT_SIGNAL_SINCE
BOOT_SIGNAL_SINCE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Boot signal log window starts at: ${BOOT_SIGNAL_SINCE}"

if [ "$FULL_DEPLOY" = "true" ]; then
  # ── Full deploy mode (workflow_dispatch "all" or first deploy) ──
  echo "=== FULL DEPLOY: Pulling infrastructure images sequentially ==="
  for svc in $(docker compose -f docker-compose.droplet.yml config --services); do
    if is_application_image_service "$svc"; then
      continue
    fi
    echo "  Pulling $svc..."
    docker compose -f docker-compose.droplet.yml pull "$svc" 2>&1 || echo "  WARN: infrastructure image pull for $svc failed, continuing with local image if present..."
  done

  echo "=== FULL DEPLOY: Pulling application images by immutable deploy SHA ==="
  for svc in ${APPLICATION_IMAGE_SERVICES}; do
    pull_deploy_image_required "$svc"
  done

  echo "=== Stopping all services ==="
  docker compose -f docker-compose.droplet.yml down --remove-orphans --timeout 30 2>&1 || true
  # Force-remove ALL aqua containers (including ones compose couldn't remove)
  echo "Force-removing any remaining aqua containers..."
  REMAINING_BEFORE_CLEANUP=$(docker ps -a --format '{{.Names}}' | grep -E 'aqua-' || true)
  if [ -n "$REMAINING_BEFORE_CLEANUP" ]; then
    while IFS= read -r name; do
      [ -z "$name" ] && continue
      echo "  Removing $name..."
      docker rm -f "$name" 2>&1 || true
    done <<< "$REMAINING_BEFORE_CLEANUP"
  fi
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
      echo "::error::JetStream storage near limit (${JS_SIZE}MB > 1800MB)."
      echo "  Refusing deploy-time data purge. Export/backup and run the JetStream recovery runbook during a maintenance window."
      exit 1
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
  ENV_FILE="${DEPLOY_ENV_FILE}"

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
  # SSoT: SERVICE_DB_ROLES is generated from the platform service catalog.
  for SVC in ${SERVICE_DB_ROLES}; do
    generate_credential "${SVC}_SERVICE_DB_PASS"
  done

  # Application secrets
  generate_credential "WEBHOOK_ENCRYPTION_KEY"
  # AES-256-GCM key for per-tenant BYOK AI credentials at rest (ai-service).
  # generate_credential emits exactly 32 chars, which the encrypted-column
  # transformer accepts as a 32-byte utf8 key. Persisted in .env → STABLE across
  # deploys (rotating it would make every stored tenant AI key undecryptable).
  generate_credential "AI_TENANT_SECRET_ENCRYPTION_KEY"

  echo "=== Per-service credentials provisioned ==="

  # RSA key pair for JWT RS256 signing (auth-service signs, all verify).
  # Persisted in the stable certs dir (mounted into containers via the
  # compose ./certs/jwt bind, which resolves through the checkout's certs
  # symlink to DEPLOY_CERTS_DIR) — never regenerated on a recreated checkout.
  echo "=== Ensuring JWT RSA key pair exists ==="
  JWT_KEY_DIR="${DEPLOY_CERTS_DIR}/jwt"
  if [ ! -f "$JWT_KEY_DIR/private.pem" ]; then
    echo "  Generating RSA-2048 key pair for JWT..."
    mkdir -p "$JWT_KEY_DIR"
    openssl genrsa -out "$JWT_KEY_DIR/private.pem" 2048
    openssl rsa -in "$JWT_KEY_DIR/private.pem" -pubout -out "$JWT_KEY_DIR/public.pem"
    chmod 600 "$JWT_KEY_DIR/private.pem"
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
  docker compose -f docker-compose.droplet.yml up -d --no-build postgres 2>&1
  sleep 10

  # DB-PWD-SYNC: Verify POSTGRES_PASSWORD matches what's in the data volume.
  # Deploy must not mutate database roles. A mismatch means bootstrap state
  # and secret state diverged and must be corrected through the db-migrate /
  # infrastructure bootstrap authority, not by this runtime deploy script.
  echo "=== Verifying PostgreSQL superuser password ==="
  POSTGRES_EFFECTIVE_USER="${POSTGRES_USER:-$(read_env_file_value POSTGRES_USER "$ENV_FILE")}"
  POSTGRES_EFFECTIVE_USER="${POSTGRES_EFFECTIVE_USER:-aquaculture}"
  POSTGRES_EFFECTIVE_PASSWORD="${POSTGRES_PASSWORD:-$(read_env_file_value POSTGRES_PASSWORD "$ENV_FILE")}"
  if [ -z "$POSTGRES_EFFECTIVE_PASSWORD" ]; then
    echo "::error::POSTGRES_PASSWORD is missing from shell env and ${ENV_FILE}; aborting before migrations."
    exit 1
  fi

  if docker exec aqua-postgres psql -U "${POSTGRES_EFFECTIVE_USER}" -c "SELECT 1" >/dev/null 2>&1; then
    if docker exec -e PGPASSWORD="${POSTGRES_EFFECTIVE_PASSWORD}" aqua-postgres \
      psql -h 127.0.0.1 -U "${POSTGRES_EFFECTIVE_USER}" -c "SELECT 1" >/dev/null 2>&1; then
      echo "  PostgreSQL superuser password matches .env"
    else
      echo "::error::PostgreSQL superuser password mismatch — refusing deploy-time role mutation."
      echo "  Rotate or repair the credential through the platform bootstrap authority, then rerun deploy."
      exit 1
    fi
  else
    echo "::error::Cannot connect to PostgreSQL via local auth — aborting before migrations."
    exit 1
  fi

  # ─────────────────────────────────────────────────────────────
  # ADR-033 — one-shot authoritative schema migration container.
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
  # If the migration container fails (exit code != 0), the deploy aborts.
  # Production services use schema-version gates; they do not act as a
  # fallback schema writer.
  # ─────────────────────────────────────────────────────────────
  run_db_migrate_or_exit "full deploy"
  record_release_ledger "db_complete" ""

  echo "=== Starting all services ==="
  record_release_ledger "apps_restarting" ""
  docker compose -f docker-compose.droplet.yml up -d --no-build 2>&1

  echo "=== Waiting 90s for services to bootstrap ==="
  sleep 90

  # ARCH-NM-DNS: Graceful nginx reload after full deploy to ensure
  # all upstream hostnames are resolved to current container IPs.
  echo "=== Reloading nginx to pick up new container IPs ==="
  docker exec aqua-nginx nginx -s reload 2>&1
  sleep 2

  # ARCH-GW-006: Force Apollo Gateway to recompose supergraph schema.
  # After backend services restart with new GraphQL types/fields, the
  # gateway may hold a stale supergraph from the previous composition.
  # The pollIntervalInMs (300s) would eventually refresh it, but during
  # that window frontend queries for new fields return 400.
  # Restarting the gateway forces immediate schema introspection.
  echo "=== Restarting gateway for schema recomposition ==="
  docker compose -f docker-compose.droplet.yml restart gateway-api 2>&1
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
      echo "::error::JetStream storage near limit (${JS_SIZE}MB > 1800MB)."
      echo "  Refusing deploy-time data purge. Export/backup and run the JetStream recovery runbook during a maintenance window."
      exit 1
    fi
  else
    echo "No existing JetStream data directory found"
  fi

  # Per-service credential provisioning (same as full deploy path).
  # ADR-015: no NATS client-auth credential provisioning here —
  # mTLS cert CN IS identity. Only legacy internal bookkeeping
  # credentials + DB role passwords get generated.
  echo "=== Ensuring per-service credentials exist ==="
  ENV_FILE="${DEPLOY_ENV_FILE}"
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
  # SSoT: SERVICE_DB_ROLES is generated from the platform service catalog.
  for SVC in ${SERVICE_DB_ROLES}; do
    generate_credential "${SVC}_SERVICE_DB_PASS"
  done

  # Application secrets
  generate_credential "WEBHOOK_ENCRYPTION_KEY"
  # AES-256-GCM key for per-tenant BYOK AI credentials at rest (ai-service).
  # generate_credential emits exactly 32 chars, which the encrypted-column
  # transformer accepts as a 32-byte utf8 key. Persisted in .env → STABLE across
  # deploys (rotating it would make every stored tenant AI key undecryptable).
  generate_credential "AI_TENANT_SECRET_ENCRYPTION_KEY"

  # Ensure infrastructure services required for migrations are running.
  # nginx starts/reloads only after db-migrate and app restarts succeed.
  echo "=== Ensuring migration infrastructure is running ==="
  docker compose -f docker-compose.droplet.yml up -d --no-build postgres redis nats minio 2>&1
  sleep 5

  echo "=== Pulling affected images sequentially: ${DEPLOY_SERVICES} ==="
  for svc in ${DEPLOY_SERVICES}; do
    pull_deploy_image_required "$svc"
  done

  # ─────────────────────────────────────────────────────────────
  # ADR-033 — one-shot authoritative schema migration container.
  #
  # Selective deploys must prove every requested image is pullable BEFORE
  # db-migrate advances schema. Otherwise a later image-pull failure leaves
  # production running old app code against new DB state.
  # ─────────────────────────────────────────────────────────────
  run_db_migrate_or_exit "selective deploy"
  record_release_ledger "db_complete" ""

  RESTART_SERVICES=$(restartable_deploy_services | xargs)
  if [ -n "${RESTART_SERVICES}" ]; then
    echo "=== Restarting affected services (no-deps): ${RESTART_SERVICES} ==="
    record_release_ledger "apps_restarting" ""
    docker compose -f docker-compose.droplet.yml up -d --no-deps --no-build --force-recreate ${RESTART_SERVICES} 2>&1
  else
    echo "=== No long-running services requested; db-migrate-only deploy complete ==="
  fi

  echo "=== Waiting 30s for services to bootstrap ==="
  sleep 30

  # ARCH-NM-DNS: Graceful nginx reload after container recreation.
  # Belt-and-suspenders: the nginx config uses resolver + variable proxy_pass
  # for dynamic DNS, but a reload ensures immediate resolution of new IPs
  # without waiting for the resolver TTL to expire.
  echo "=== Reloading nginx to pick up new container IPs ==="
  docker exec aqua-nginx nginx -s reload 2>&1 || docker compose -f docker-compose.droplet.yml restart nginx 2>&1
  sleep 2

  # ARCH-GW-006: Force gateway schema recomposition when backend services change.
  # Only restart gateway when a backend subgraph service was deployed, since
  # frontend-only deploys don't affect the supergraph schema.
  BACKEND_PATTERN="gateway-api|auth-service|farm-service|sensor-service|alert-engine|billing-service|hr-service|hydroponics-service|notification-service|config-service|messaging-service"
  if echo "${DEPLOY_SERVICES}" | grep -qE "${BACKEND_PATTERN}"; then
    echo "=== Backend subgraph changed — restarting gateway for schema recomposition ==="
    docker compose -f docker-compose.droplet.yml restart gateway-api 2>&1
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
# operator can inspect the rollout surface in place.
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
  record_release_ledger "failed" "critical_health"
  rollback_and_record "critical_health" || true
  echo "Rollback attempted. If db-migrate already applied DDL, follow the database recovery runbook before retrying."
  exit 1
elif [ "${HEALTH_STATUS}" -eq 3 ]; then
  docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  dump_nonhealthy_container_logs "post-required-health-failure"
  echo "::error::Required service health check failed. Promotion blocked without automatic rollback."
  echo "  The required tier is operator-inspected by contract; follow the deploy health runbook."
  export SCHEMA_MAY_BE_FORWARD="true"
  record_release_ledger "failed" "required_health"
  exit 1
elif [ "${HEALTH_STATUS}" -ne 0 ]; then
  docker compose -f docker-compose.droplet.yml ps --format 'table {{.Name}}\t{{.Status}}' 2>/dev/null || true
  dump_nonhealthy_container_logs "post-health-invocation-failure"
  echo "::error::Service health check could not run (exit ${HEALTH_STATUS}). Deploy failed without rollback."
  record_release_ledger "failed" "health_gate_invocation"
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
  record_release_ledger "failed" "boot_signal"
  rollback_and_record "boot_signal" || true
  echo "Rollback attempted. If db-migrate already applied DDL, follow the database recovery runbook before retrying."
  exit 1
fi

if ! run_readiness_sweep; then
  echo "::error::Readiness sweep failed. Initiating rollback."
  record_release_ledger "failed" "readiness"
  rollback_and_record "readiness" || true
  exit 1
fi

if ! verify_release_ledger_sql; then
  echo "::error::Release SQL verification failed. Initiating rollback."
  record_release_ledger "failed" "release_sql"
  rollback_and_record "release_sql" || true
  exit 1
fi

# Pre-promotion public-path smoke THROUGH nginx — the gate the app.suderra.com outage
# slipped past. Every container can be "healthy" (and boot-signals/readiness can pass)
# while nginx→gateway still returns 502: a subgraph being down means the supergraph never
# composes and the gateway never serves /graphql. Assert the REAL public path returns
# valid GraphQL JSON before promoting; a 502/HTML body rolls the deploy back.
echo "=== Public /graphql smoke through nginx ==="
SMOKE_HOST="${PUBLIC_SMOKE_HOST:-app.suderra.com}"
# Exercise the REAL https public path. Was http://localhost, which nginx
# 301-redirects http→https, so the smoke saw a 301 (not GraphQL JSON) and
# false-failed every deploy. Default to https on the public host, pinned to the
# local nginx via --resolve so it tests the exact public TLS path (valid cert,
# SNI, Host) without depending on external DNS. -L/--post301/--post302 also
# re-POST through a redirect if PUBLIC_SMOKE_ORIGIN is overridden back to http.
SMOKE_ORIGIN="${PUBLIC_SMOKE_ORIGIN:-https://${SMOKE_HOST}}"
SMOKE_RESOLVE="${PUBLIC_SMOKE_RESOLVE:-${SMOKE_HOST}:443:127.0.0.1}"
smoke_out="$(curl -sS -m 15 -L --post301 --post302 --resolve "${SMOKE_RESOLVE}" -w $'\n%{http_code}' \
  -H "Host: ${SMOKE_HOST}" -H 'Content-Type: application/json' \
  -X POST --data '{"query":"{ __typename }"}' "${SMOKE_ORIGIN}/graphql" || true)"
smoke_code="$(printf '%s' "${smoke_out}" | tail -n1)"
smoke_body="$(printf '%s' "${smoke_out}" | sed '$d')"
if [ "${smoke_code}" != "200" ] || \
   ! printf '%s' "${smoke_body}" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("data",{}).get("__typename") else 1)' 2>/dev/null; then
  echo "::error::Public POST /graphql smoke failed through nginx (HTTP ${smoke_code}; body is not GraphQL JSON). The gateway is not serving public traffic — a subgraph is likely down. Initiating rollback."
  record_release_ledger "failed" "public_graphql_smoke"
  rollback_and_record "public_graphql_smoke" || true
  exit 1
fi
echo "  Public /graphql smoke passed (HTTP 200, valid GraphQL JSON)."

record_release_ledger "promoted" ""

echo "=== Cleanup old images ==="
bash scripts/deploy/droplet-capacity.sh gc
bash scripts/deploy/droplet-capacity.sh report

echo "=== Container status ==="
docker compose -f docker-compose.droplet.yml ps
