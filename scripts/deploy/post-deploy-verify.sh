#!/usr/bin/env bash
# Post-deploy production verification. Intended to run on the production
# droplet from GitHub Actions over SSH. Logs go to stderr; stdout is a single
# JSON evidence document suitable for upload as a workflow artifact.

set -euo pipefail

TARGET_SHA="${TARGET_SHA:?TARGET_SHA is required}"
POSTGRES_DB="${POSTGRES_DB:-aquaculture}"
POSTGRES_USER="${POSTGRES_USER:-aquaculture}"
DEPLOY_STATE_ROOT="${DEPLOY_STATE_ROOT:-/var/lib/aqua/deploy/releases}"

# Deploy filesystem SSoT. The protected payload executes this verifier from the
# exact runner-built bundle for TARGET_SHA. It sources only its sibling helper;
# the target's interactive checkout and Git configuration are not authorities.
# shellcheck source=scripts/deploy/deploy-paths.sh
VERIFY_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "${VERIFY_SCRIPT_DIR}/deploy-paths.sh"

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
# so EVERY compose invocation below (the bundled health runtime runs
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
require_command node
require_command python3

# The shared-exec wrapper already holds this exact FD in the normal workflow.
# Reacquiring it validates inherited-lock identity and keeps direct invocation
# fail-closed. Verification observes source bytes, the release marker, Docker,
# and PostgreSQL under one shared host-state snapshot; it never publishes or
# prunes source material.
configure_deploy_paths "${TARGET_SHA}"
assert_deploy_source_bundle "${TARGET_SHA}"
aqua_control_plane_lock_acquire shared 120
aqua_control_plane_lock_assert
aqua_control_plane_guard_dr_state
cd "${DEPLOY_CHECKOUT_DIR}"

log "=== Post-deploy verification for ${TARGET_SHA} (bundle ${DEPLOY_SOURCE_DIR}) ==="
aqua_control_plane_verify_source

CATALOG_DEPLOY_ENV="${CATALOG_DEPLOY_ENV:-infrastructure/deploy/service-catalog.deploy.vars}"
if [ ! -r "${CATALOG_DEPLOY_ENV}" ]; then
  echo "::error::Missing generated service catalog deploy artifact: ${CATALOG_DEPLOY_ENV}" >&2
  exit 1
fi
# shellcheck source=infrastructure/deploy/service-catalog.deploy.vars
. "${CATALOG_DEPLOY_ENV}"
read -r -a catalog_image_services \
  <<< "${CATALOG_APPLICATION_IMAGE_SERVICES:?generated application image services missing}"
read -r -a catalog_compose_image_bindings \
  <<< "${CATALOG_APPLICATION_COMPOSE_IMAGE_MAP:?generated application compose-image map missing}"
if [ "${#catalog_image_services[@]}" -eq 0 ] || \
  [ "${#catalog_image_services[@]}" -gt 64 ] || \
  [ "${#catalog_compose_image_bindings[@]}" -eq 0 ] || \
  [ "${#catalog_compose_image_bindings[@]}" -gt 128 ]; then
  echo "::error::application image service catalog has an invalid bounded size." >&2
  exit 1
fi

declare -A catalog_services_seen=()
declare -A catalog_image_services_seen=()
for service in "${catalog_image_services[@]}"; do
  if [[ ! "${service}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
    [[ -n "${catalog_image_services_seen[${service}]+present}" ]]; then
    echo "::error::application image target catalog contains an invalid or duplicate service." >&2
    exit 1
  fi
  catalog_image_services_seen["${service}"]=1
done

catalog_application_services=()
long_running_services=()
db_migrate_catalog_count=0
for binding in "${catalog_compose_image_bindings[@]}"; do
  service=${binding%%:*}
  image_service=${binding#*:}
  if [ "${binding}" = "${service}" ] || \
    [[ ! "${service}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
    [[ ! "${image_service}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
    [[ -z "${catalog_image_services_seen[${image_service}]+present}" ]] || \
    [[ -n "${catalog_services_seen[${service}]+present}" ]]; then
    echo "::error::application compose-image map contains an invalid or duplicate binding." >&2
    exit 1
  fi
  catalog_services_seen["${service}"]=1
  catalog_application_services+=("${service}")
  if [ "${service}" = "db-migrate" ]; then
    db_migrate_catalog_count=$((db_migrate_catalog_count + 1))
  else
    long_running_services+=("${service}")
  fi
done
if [ "${db_migrate_catalog_count}" -ne 1 ] || \
  [ "${#long_running_services[@]}" -eq 0 ]; then
  echo "::error::application image service catalog must contain exactly one db-migrate and at least one long-running service." >&2
  exit 1
fi
export CATALOG_APPLICATION_IMAGE_SERVICES CATALOG_APPLICATION_COMPOSE_IMAGE_MAP

# Read the atomic marker before SQL so the verifier selects the exact release
# attempt, not merely the newest row sharing its Git SHA. A later rolled-back
# attempt for the same commit must never shadow the marker-authoritative release.
current_release_json="$(read_deploy_current_release)"
export CURRENT_RELEASE_JSON="${current_release_json}"
IFS=$'\t' read -r marker_main_sha marker_release_id marker_manifest_hash < <(
  python3 - <<'PY'
import json
import os

marker = json.loads(os.environ["CURRENT_RELEASE_JSON"])
print(
    marker.get("main_sha", ""),
    marker.get("release_id", ""),
    marker.get("image_digest_manifest_sha256", ""),
    sep="\t",
)
PY
)
if [ "${marker_main_sha}" != "${TARGET_SHA}" ] || \
  [[ ! "${marker_release_id}" =~ ^${TARGET_SHA}-[0-9]{8}T[0-9]{6}Z$ ]] || \
  [[ ! "${marker_manifest_hash}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::current-release marker does not identify the requested exact release." >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -qx 'aqua-postgres'; then
  echo "::error::aqua-postgres is not running; cannot verify release ledger." >&2
  exit 1
fi

# BEGIN release-ledger-read-only-query
release_json="$(
  docker exec -e 'PGOPTIONS=-c default_transaction_read_only=on' \
    -i aqua-postgres psql -X \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 \
    -v release_id="${marker_release_id}" \
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
    db_migrate_image,
    expected_heads,
    applied_heads,
    completed_at,
    updated_at
  FROM platform.release_ledger
  WHERE release_id = :'release_id'
    AND git_sha = :'git_sha'
)
SELECT COALESCE(jsonb_pretty(to_jsonb(latest)), '{}')
FROM latest
WHERE current_setting('transaction_read_only') = 'on';
SQL
)"
# END release-ledger-read-only-query

if [ -z "${release_json}" ] || [ "${release_json}" = "{}" ]; then
  echo "::error::release ledger row missing for release_id=${marker_release_id} git_sha=${TARGET_SHA}" >&2
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
if [ "${release_id}" != "${marker_release_id}" ]; then
  echo "::error::release ledger row does not match the marker-authoritative release id." >&2
  exit 1
fi
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

ledger_image_rows=""
if ! ledger_image_rows="$(python3 - <<'LEDGER_IMAGE_ATTESTATION_PY'
import json
import os
import re
import sys

row = json.loads(os.environ["RELEASE_JSON"])
binding_tokens = os.environ["CATALOG_APPLICATION_COMPOSE_IMAGE_MAP"].split()
long_running: list[str] = []
for token in binding_tokens:
    fields = token.split(":")
    if len(fields) != 2:
        raise SystemExit("release compose-image binding schema is invalid")
    compose_service, _image_service = fields
    if compose_service != "db-migrate":
        long_running.append(compose_service)
images = row.get("image_digests")
if not isinstance(images, dict):
    raise SystemExit("release ledger image_digests must be a JSON object")

expected = set(long_running)
actual = set(images)
if actual != expected:
    missing = ",".join(sorted(expected - actual)) or "none"
    extra = ",".join(sorted(actual - expected)) or "none"
    raise SystemExit(
        f"release ledger image_digests catalog mismatch: missing={missing} extra={extra}"
    )

image_id_pattern = re.compile(r"sha256:[0-9a-f]{64}")
for service in long_running:
    image_id = images[service]
    if not isinstance(image_id, str) or image_id_pattern.fullmatch(image_id) is None:
        raise SystemExit(f"release ledger has malformed image ID for {service}")

db_migrate_image = row.get("db_migrate_image")
if not isinstance(db_migrate_image, str) or image_id_pattern.fullmatch(db_migrate_image) is None:
    raise SystemExit("release ledger has malformed db_migrate_image")

for service in long_running:
    print(f"{service}\t{images[service]}")
print(f"db-migrate\t{db_migrate_image}")
LEDGER_IMAGE_ATTESTATION_PY
)"; then
  echo "::error::release ledger image attestation is incomplete or malformed." >&2
  exit 1
fi

declare -A ledger_image_ids=()
ledger_image_rows_seen=0
while IFS=$'\t' read -r service image_id extra || \
  [ -n "${service:-}${image_id:-}${extra:-}" ]; do
  if [ -n "${extra:-}" ] || \
    [[ ! "${service:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
    [[ ! "${image_id:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
    [[ -z "${catalog_services_seen[${service:-}]+present}" ]] || \
    [[ -n "${ledger_image_ids[${service:-}]+present}" ]]; then
    echo "::error::release ledger image attestation emitted an invalid or duplicate row." >&2
    exit 1
  fi
  ledger_image_ids["${service}"]="${image_id}"
  ledger_image_rows_seen=$((ledger_image_rows_seen + 1))
done <<< "${ledger_image_rows}"
if [ "${ledger_image_rows_seen}" -ne "${#catalog_application_services[@]}" ]; then
  echo "::error::release ledger image attestation row count does not match the service catalog." >&2
  exit 1
fi

if [ "${release_status}" != "promoted" ]; then
  echo "::error::marker-authoritative release ledger row is not promoted: ${release_status}" >&2
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
if [ "${actual_manifest_hash}" != "${marker_manifest_hash}" ]; then
  echo "::error::image digest manifest hash does not match the current-release marker." >&2
  exit 1
fi

# The release ledger is historical. Bind it to the host's atomically promoted
# current-release marker under the same control-plane lock so an older verifier
# cannot certify a newer deployment's containers.
assert_deploy_current_release "${TARGET_SHA}" "${release_id}" "${actual_manifest_hash}"
deployed_head="${TARGET_SHA}"

log "=== Full release-ledger image parity for current release ==="
for service in "${long_running_services[@]}"; do
  expected_image_id="${ledger_image_ids[${service}]:-}"
  mapfile -t service_containers < <(
    docker compose -f docker-compose.droplet.yml ps --all --quiet "${service}" 2>/dev/null
  )
  if [ "${#service_containers[@]}" -ne 1 ] || \
    [[ ! "${service_containers[0]}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "::error::${service} does not resolve to exactly one canonical compose container." >&2
    exit 1
  fi
  actual_image_id="$(docker inspect --format='{{.Image}}' \
    "${service_containers[0]}" 2>/dev/null || true)"
  running_state="$(docker inspect --format='{{.State.Running}}' \
    "${service_containers[0]}" 2>/dev/null || true)"
  if [[ ! "${actual_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
    [ "${running_state}" != "true" ] || \
    [ "${actual_image_id}" != "${expected_image_id}" ]; then
    echo "::error::release-ledger live image parity failed for ${service}." >&2
    exit 1
  fi
  log "  ${service}: running image matches the promoted release ledger"
done

mapfile -t db_migrate_containers < <(
  docker compose -f docker-compose.droplet.yml ps --all --quiet db-migrate 2>/dev/null
)
if [ "${#db_migrate_containers[@]}" -ne 1 ] || \
  [[ ! "${db_migrate_containers[0]}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "::error::db-migrate does not resolve to exactly one canonical completed compose container." >&2
  exit 1
fi
db_migrate_actual_image="$(docker inspect --format='{{.Image}}' \
  "${db_migrate_containers[0]}" 2>/dev/null || true)"
db_migrate_state="$(docker inspect --format='{{.State.Running}} {{.State.ExitCode}}' \
  "${db_migrate_containers[0]}" 2>/dev/null || true)"
if [[ ! "${db_migrate_actual_image}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
  [ "${db_migrate_actual_image}" != "${ledger_image_ids[db-migrate]:-}" ] || \
  [ "${db_migrate_state}" != "false 0" ]; then
  echo "::error::db-migrate image or successful terminal state does not match the promoted release ledger." >&2
  exit 1
fi
log "  db-migrate: completed image matches the promoted release ledger"

log "=== Selective registry-digest manifest parity for current release ==="
declare -A manifest_services_seen=()
manifest_rows=0
while IFS=$'\t' read -r service repository digest extra || \
  [ -n "${service:-}${repository:-}${digest:-}${extra:-}" ]; do
  if [ -n "${extra:-}" ] || \
    [[ ! "${service:-}" =~ ^[a-z0-9][a-z0-9-]*$ ]] || \
    [[ ! "${repository:-}" =~ ^[a-z0-9][a-z0-9._/-]*$ ]] || \
    [[ ! "${digest:-}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
    [[ -z "${catalog_services_seen[${service:-}]+present}" ]] || \
    [[ -n "${manifest_services_seen[${service:-}]+present}" ]]; then
    echo "::error::deploy digest manifest contains an invalid or duplicate row." >&2
    exit 1
  fi
  manifest_services_seen["${service}"]=1
  manifest_rows=$((manifest_rows + 1))
  if [ "${manifest_rows}" -gt 64 ]; then
    echo "::error::deploy digest manifest exceeds the bounded service count." >&2
    exit 1
  fi

  expected_image_id="$(docker image inspect --format='{{.Id}}' \
    "${repository}@${digest}" 2>/dev/null || true)"
  if [[ ! "${expected_image_id}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::expected image digest is unavailable locally for ${service}." >&2
    exit 1
  fi
  mapfile -t service_containers < <(
    docker compose -f docker-compose.droplet.yml ps --all --quiet "${service}" 2>/dev/null
  )
  if [ "${#service_containers[@]}" -ne 1 ] || \
    [[ ! "${service_containers[0]}" =~ ^[0-9a-f]{64}$ ]]; then
    echo "::error::${service} does not resolve to exactly one release container." >&2
    exit 1
  fi
  actual_image_id="$(docker inspect --format='{{.Image}}' \
    "${service_containers[0]}" 2>/dev/null || true)"
  if [ "${actual_image_id}" != "${expected_image_id}" ]; then
    echo "::error::live image parity failed for ${service}." >&2
    exit 1
  fi
  log "  ${service}: live image matches attested digest"
done < "${digest_manifest}"
if [ "${manifest_rows}" -eq 0 ]; then
  echo "::error::deploy digest manifest contains no services." >&2
  exit 1
fi

log "=== Service criticality health gate ==="
COMPOSE_FILE=docker-compose.droplet.yml \
  MANIFEST=infrastructure/deploy/service-criticality.yaml \
  POLL_INTERVAL="${POLL_INTERVAL:-10}" \
  node "${DEPLOY_SOURCE_DIR}/runtime/check-service-health.mjs" >&2

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

# ---------------------------------------------------------------------------
# SEMANTIC farm-contract canary THROUGH the public nginx /graphql edge.
#
# WHY this exists on top of the `{ __typename }` smoke above:
#   `{ __typename }` is resolved by the gateway's root query type and answers
#   even when EVERY domain subgraph is down — it proves "nginx → gateway is
#   reachable and speaks GraphQL JSON", nothing about whether real farm data is
#   actually wired. This canary issues a NAMED farm read (`farms`) so the probe
#   only succeeds if the farm subgraph composed into the live supergraph AND the
#   tenant/auth boundary on that read is enforced. It is a Tier-3 "make the
#   wrong behaviour detectable" gate: a deploy where farm data is misrouted
#   (subgraph never composed, or the read boundary returns data with no caller
#   identity) is caught here instead of by the first customer.
#
# This is an UNAUTHENTICATED probe by design. post-deploy-verify.sh runs from
# the droplet over SSH and has NO tenant JWT — it must never invent credentials
# (CLAUDE.md security rules). So the canary asserts the deterministic NEGATIVE
# contract of a guarded farm read: a real farm query with no Authorization
# header MUST be rejected by the auth boundary with a GraphQL error, NOT served
# data, NOT a schema-validation error, NOT a 5xx.
#
# What a PASS proves (all must hold):
#   1. HTTP 200 with a parseable GraphQL JSON envelope (same public TLS path as
#      real traffic — nginx 502 HTML fails the JSON parse and the deploy).
#   2. The supergraph KNOWS the `farms` field. A `GRAPHQL_VALIDATION_FAILED` /
#      "Cannot query field \"farms\"" reply means the farm subgraph did NOT
#      compose into the live supergraph (the exact misroute this canary hunts)
#      → FAIL.
#   3. `data.farms` is NOT populated for an anonymous caller AND an auth/authz
#      error is present (gateway maps a 401 to extensions.code UNAUTHENTICATED,
#      a 403 to FORBIDDEN; subgraph-origin auth rejections surface the same
#      shape). Anonymous data return = a broken tenant read boundary → FAIL.
#
# How to interpret a FAILURE (triage order):
#   - HTTP != 200 / body is nginx HTML  → gateway not serving public traffic
#     (subgraph down so the supergraph never composed); same class as the
#     __typename smoke above but now confirmed for the farm path.
#   - extensions.code == GRAPHQL_VALIDATION_FAILED / "Cannot query field"
#       → farm subgraph missing from the composed supergraph: check
#         gateway composition + farm-service /health/ready.
#   - data.farms returned WITHOUT auth, or no error at all
#       → CRITICAL: the farm read boundary served tenant data to an
#         unauthenticated caller. Treat as a tenant-isolation breach, not a
#         flaky deploy.
#
# Dependency-light (curl + python3) and reuses the SAME public-edge env vars as
# the smoke above: PUBLIC_SMOKE_HOST, PUBLIC_SMOKE_ORIGIN, PUBLIC_SMOKE_RESOLVE.
# No secrets, tokens, or hostnames are hardcoded.
# ---------------------------------------------------------------------------
farm_canary_body='{"query":"query DeployFarmCanary { farms { id } }"}'
farm_canary_out="$(curl -sS -m 15 -L --post301 --post302 --resolve "${nginx_resolve}" -w $'\n%{http_code}' \
  -H "Host: ${public_host}" -H 'Content-Type: application/json' \
  -X POST --data "${farm_canary_body}" "${nginx_origin}/graphql" || true)"
farm_canary_code="$(printf '%s' "${farm_canary_out}" | tail -n1)"
farm_canary_payload="$(printf '%s' "${farm_canary_out}" | sed '$d')"
if [ "${farm_canary_code}" != "200" ] || \
   ! printf '%s' "${farm_canary_payload}" | python3 -c '
import json, sys

try:
    body = json.load(sys.stdin)
except Exception:
    # Non-JSON body (e.g. nginx 502 HTML) — public farm path is not live.
    sys.exit(1)

data = body.get("data") or {}
errors = body.get("errors") or []
codes = {
    (err.get("extensions") or {}).get("code")
    for err in errors
    if isinstance(err, dict)
}
messages = " ".join(
    str(err.get("message", "")) for err in errors if isinstance(err, dict)
).lower()

# A populated farms list for an anonymous caller means the tenant read boundary
# is misrouting (serving data with no caller identity) — hard fail.
if data.get("farms"):
    sys.exit(1)

# Supergraph does not know the farm field => farm subgraph never composed.
if "GRAPHQL_VALIDATION_FAILED" in codes or "cannot query field" in messages:
    sys.exit(1)

# Expected deterministic negative: the guarded farm read REJECTED the anonymous
# probe. The two security-meaningful properties are already proven above —
# data.farms is empty (no tenant-isolation breach) AND the field is composed
# (no GRAPHQL_VALIDATION_FAILED). The remaining requirement is simply that the
# read was rejected, i.e. at least one error is present.
#
# We deliberately do NOT require a specific auth code. Production runs with
# disableErrorMessages, and the gateway maps a subgraph verified-user-assertion
# rejection to a generic INTERNAL_SERVER_ERROR / "Bad Request" — a legitimate
# MASKED rejection. Demanding an unmasked UNAUTHENTICATED/FORBIDDEN contradicts
# the by-design error masking and made this canary flaky on every
# farm-affecting deploy (the anonymous probe reaches the subgraph and is denied
# there by the verified-user-assertion guard, not at the gateway auth filter). A
# clean auth code is still preferred — logged, not required.
if errors:
    if not (codes & {"UNAUTHENTICATED", "FORBIDDEN"}) and not (
        "unauth" in messages or "forbidden" in messages or "token" in messages
    ):
        sys.stderr.write(
            "note: guarded farm read rejected the anonymous probe with a masked "
            "error (no unmasked UNAUTHENTICATED/FORBIDDEN code); accepted because "
            "data.farms is empty and the farm field is composed.\n"
        )
    sys.exit(0)

# data.farms empty AND no error at all -> the read neither returned data nor
# rejected the anonymous caller. That is not the guarded contract — fail closed.
sys.exit(1)
' 2>/dev/null; then
  echo "::error::SEMANTIC farm-contract canary FAILED through nginx /graphql (HTTP ${farm_canary_code}). The named 'farms' read did not return the expected guarded-read contract: either the farm subgraph is not composed into the supergraph, the public path is 502, or — worst case — farm data was served to an unauthenticated caller (tenant-isolation breach). Refusing to mark the deploy healthy." >&2
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
  "current_release_marker_match": true,
  "release_ledger_full_image_parity": true,
  "db_migrate_image_parity": true,
  "live_image_digest_parity": true,
  "image_digest_manifest_sha256": $(json_string "${actual_manifest_hash}"),
  "digest_manifest_path": $(json_string "${digest_manifest}"),
  "criticality_health_gate": "passed",
  "ready_services": ${ready_json},
  "gateway_smoke": {
    "health_live": "passed",
    "health_ready": "passed",
    "public_graphql": "passed",
    "public_graphql_farm_contract": "passed",
    "public_socketio": "passed"
  },
  "verified_at": $(json_string "$(date -u +%FT%TZ)")
}
JSON
