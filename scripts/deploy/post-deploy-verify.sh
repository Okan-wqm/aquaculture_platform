#!/usr/bin/env bash
# Post-deploy production verification. Intended to run on the production
# droplet from GitHub Actions over SSH. Logs go to stderr; stdout is a single
# JSON evidence document suitable for upload as a workflow artifact.

set -euo pipefail

TARGET_SHA="${TARGET_SHA:?TARGET_SHA is required}"
POSTGRES_DB="${POSTGRES_DB:-aquaculture}"
POSTGRES_USER="${POSTGRES_USER:-aquaculture}"
DEPLOY_STATE_ROOT="${DEPLOY_STATE_ROOT:-/var/lib/aqua/deploy/releases}"

case "${TARGET_SHA}" in
  *[!0-9a-f]*)
    echo "::error::TARGET_SHA must be lowercase hex." >&2
    exit 2
    ;;
esac
if [ "${#TARGET_SHA}" -ne 40 ]; then
  echo "::error::TARGET_SHA must be exactly 40 characters." >&2
  exit 2
fi

# docker-compose.droplet.yml image refs interpolate ${TAG:?TAG required},
# so EVERY compose invocation below (check-service-health.ts runs
# `compose config --services`; the readiness sweep runs `compose ps -q`)
# needs TAG in the environment. droplet-up.sh owns the same contract via
# TAG="${TAG:-${DEPLOY_SHA}}"; the verifier's equivalent deploy identity
# is the ledger-verified TARGET_SHA (images are SHA-tagged). Without this
# export the whole health gate dies at interpolation before checking a
# single container (INFRA-HIGH-012, first real full-stack verify run,
# 2026-06-11).
TAG="${TAG:-${TARGET_SHA}}"
export TAG

log() {
  printf '%s\n' "$*" >&2
}

json_string() {
  python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "::error::required command missing on droplet: $1" >&2
    exit 2
  fi
}

require_command docker
require_command git
require_command node
require_command python3

cd /var/aqua-saas

log "=== Post-deploy verification for ${TARGET_SHA} ==="

deployed_head="$(git rev-parse HEAD)"
if [ "${deployed_head}" != "${TARGET_SHA}" ]; then
  echo "::error::droplet checkout mismatch: expected=${TARGET_SHA} actual=${deployed_head}" >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx 'aqua-postgres'; then
  echo "::error::aqua-postgres is not running; cannot verify release ledger." >&2
  exit 1
fi

release_json="$(
  docker exec -i aqua-postgres psql \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 \
    -v git_sha="${TARGET_SHA}" \
    -tA <<'SQL'
WITH latest AS (
  SELECT
    release_id,
    git_sha,
    status,
    failure_phase,
    schema_may_be_forward,
    deploy_metadata,
    image_digests,
    expected_heads,
    applied_heads,
    completed_at,
    updated_at
  FROM platform.release_ledger
  WHERE git_sha = :'git_sha'
  ORDER BY updated_at DESC
  LIMIT 1
)
SELECT COALESCE(jsonb_pretty(to_jsonb(latest)), '{}')
FROM latest;
SQL
)"

if [ -z "${release_json}" ] || [ "${release_json}" = "{}" ]; then
  echo "::error::release ledger row missing for git_sha=${TARGET_SHA}" >&2
  exit 1
fi

export RELEASE_JSON="${release_json}"
release_id="$(
  python3 - <<'PY'
import json, os
row = json.loads(os.environ["RELEASE_JSON"])
print(row.get("release_id", ""))
PY
)"
release_status="$(
  python3 - <<'PY'
import json, os
row = json.loads(os.environ["RELEASE_JSON"])
print(row.get("status", ""))
PY
)"
heads_match="$(
  python3 - <<'PY'
import json, os
row = json.loads(os.environ["RELEASE_JSON"])
print("true" if row.get("expected_heads") and row.get("expected_heads") == row.get("applied_heads") else "false")
PY
)"
ledger_manifest_hash="$(
  python3 - <<'PY'
import json, os
row = json.loads(os.environ["RELEASE_JSON"])
metadata = row.get("deploy_metadata") or {}
print(metadata.get("imageDigestManifestSha256", ""))
PY
)"

if [ "${release_status}" != "promoted" ]; then
  echo "::error::latest release ledger row is not promoted: ${release_status}" >&2
  exit 1
fi
if [ "${heads_match}" != "true" ]; then
  echo "::error::release ledger expected_heads/applied_heads mismatch for ${release_id}" >&2
  exit 1
fi
if [ -z "${ledger_manifest_hash}" ]; then
  echo "::error::release ledger missing deploy_metadata.imageDigestManifestSha256" >&2
  exit 1
fi

state_dir="${DEPLOY_STATE_ROOT}/${release_id}"
digest_manifest="${state_dir}/image-digests.tsv"
if [ ! -s "${digest_manifest}" ]; then
  echo "::error::deploy digest manifest missing: ${digest_manifest}" >&2
  exit 1
fi
actual_manifest_hash="$(sha256sum "${digest_manifest}" | awk '{print $1}')"
if [ "${actual_manifest_hash}" != "${ledger_manifest_hash}" ]; then
  echo "::error::image digest manifest hash mismatch: ledger=${ledger_manifest_hash} actual=${actual_manifest_hash}" >&2
  exit 1
fi

log "=== Service criticality health gate ==="
COMPOSE_FILE=docker-compose.droplet.yml \
  MANIFEST=infrastructure/deploy/service-criticality.yaml \
  POLL_INTERVAL="${POLL_INTERVAL:-10}" \
  node scripts/deploy/check-service-health.ts >&2

CATALOG_DEPLOY_ENV="${CATALOG_DEPLOY_ENV:-infrastructure/deploy/service-catalog.deploy.vars}"
if [ ! -r "${CATALOG_DEPLOY_ENV}" ]; then
  echo "::error::Missing generated service catalog deploy artifact: ${CATALOG_DEPLOY_ENV}" >&2
  exit 1
fi
# shellcheck source=infrastructure/deploy/service-catalog.deploy.vars
. "${CATALOG_DEPLOY_ENV}"
read -r -a ready_services <<< "${CATALOG_READINESS_SERVICES:?generated readiness service list missing}"

ready_ok=()
for spec in "${ready_services[@]}"; do
  svc="${spec%%:*}"
  port="${spec##*:}"
  container_id="$(docker compose -f docker-compose.droplet.yml ps -q "${svc}" 2>/dev/null || true)"
  if [ -z "${container_id}" ]; then
    echo "::error::${svc} container not found during readiness sweep." >&2
    exit 1
  fi
  docker exec "${container_id}" curl -sf "http://localhost:${port}/health/ready" >/dev/null
  ready_ok+=("${svc}")
done

gateway_container="$(docker compose -f docker-compose.droplet.yml ps -q gateway-api 2>/dev/null || true)"
if [ -z "${gateway_container}" ]; then
  echo "::error::gateway-api container not found during gateway smoke." >&2
  exit 1
fi
docker exec "${gateway_container}" curl -sf "http://localhost:3000/health/live" >/dev/null
docker exec "${gateway_container}" curl -sf "http://localhost:3000/health/ready" >/dev/null

# Real public-path smoke THROUGH nginx — NOT the internal container. This is the gate
# that the app.suderra.com outage slipped past: /health/live can pass inside the gateway
# container while nginx→gateway returns 502 (e.g. a subgraph like billing is down so the
# supergraph never composes). We curl nginx on the droplet host with the public Host
# header so the request takes the exact path real traffic does, and we assert a valid
# GraphQL JSON body — a 502 returns nginx HTML, which must FAIL the deploy.
public_host="${PUBLIC_SMOKE_HOST:-app.suderra.com}"
# Real https public path (was http://localhost → nginx 301-redirects http→https,
# which false-failed the smoke). Pin to the local nginx via --resolve so it tests
# the exact public TLS path (valid cert/SNI/Host) without external DNS;
# -L/--post301/--post302 re-POST through a redirect if overridden back to http.
nginx_origin="${PUBLIC_SMOKE_ORIGIN:-https://${public_host}}"
nginx_resolve="${PUBLIC_SMOKE_RESOLVE:-${public_host}:443:127.0.0.1}"
graphql_body='{"query":"{ __typename }"}'
graphql_out="$(curl -sS -m 15 -L --post301 --post302 --resolve "${nginx_resolve}" -w $'\n%{http_code}' \
  -H "Host: ${public_host}" -H 'Content-Type: application/json' \
  -X POST --data "${graphql_body}" "${nginx_origin}/graphql" || true)"
graphql_code="$(printf '%s' "${graphql_out}" | tail -n1)"
graphql_payload="$(printf '%s' "${graphql_out}" | sed '$d')"
if [ "${graphql_code}" != "200" ] || \
   ! printf '%s' "${graphql_payload}" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("data",{}).get("__typename") else 1)' 2>/dev/null; then
  echo "::error::public POST /graphql smoke FAILED through nginx (HTTP ${graphql_code}; body is not GraphQL JSON). The gateway is not serving public traffic — a subgraph is likely down. Refusing to mark the deploy healthy." >&2
  exit 1
fi

# Socket.IO handshake through nginx (engine.io polling open).
socketio_code="$(curl -sS -m 15 -L --resolve "${nginx_resolve}" -o /dev/null -w '%{http_code}' \
  -H "Host: ${public_host}" "${nginx_origin}/socket.io/?EIO=4&transport=polling" || true)"
if [ "${socketio_code}" != "200" ]; then
  echo "::error::public /socket.io handshake FAILED through nginx (HTTP ${socketio_code})." >&2
  exit 1
fi

ready_json="$(python3 -c "import json,sys; print(json.dumps(sys.argv[1:]))" "${ready_ok[@]}")"

cat <<JSON
{
  "schema_version": 1,
  "status": "ok",
  "target_sha": $(json_string "${TARGET_SHA}"),
  "droplet_head": $(json_string "${deployed_head}"),
  "release_id": $(json_string "${release_id}"),
  "release_status": $(json_string "${release_status}"),
  "release_ledger_heads_match": true,
  "image_digest_manifest_sha256": $(json_string "${actual_manifest_hash}"),
  "digest_manifest_path": $(json_string "${digest_manifest}"),
  "criticality_health_gate": "passed",
  "ready_services": ${ready_json},
  "gateway_smoke": {
    "health_live": "passed",
    "health_ready": "passed",
    "public_graphql": "passed",
    "public_socketio": "passed"
  },
  "verified_at": $(json_string "$(date -u +%FT%TZ)")
}
JSON
