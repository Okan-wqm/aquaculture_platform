#!/bin/bash
# =============================================================================
# Internal TLS Certificate Generator — Aquaculture Platform
# Usage: ./generate-internal-certs.sh [--force]
# Output: ./certs/{ca,nats,redis,postgres}/
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CERTS_DIR="${REPO_ROOT}/certs"
FORCE=false
[ "${1:-}" = "--force" ] && FORCE=true
GENERATED_KEY_STAGE=''

cleanup_generated_key_stage() {
  if [ -n "${GENERATED_KEY_STAGE}" ] && [ -e "${GENERATED_KEY_STAGE}" ]; then
    rm -f -- "${GENERATED_KEY_STAGE}"
  fi
}
trap cleanup_generated_key_stage EXIT

ensure_file_mode() {
  local path="$1" expected_mode="$2" actual_mode
  actual_mode=$(stat -c '%a' "${path}")
  if [ "${actual_mode}" != "${expected_mode#0}" ]; then
    chmod "${expected_mode}" "${path}"
  fi
}

generate_server_cert() {
  local name="$1" cn="$2" san="$3" key_mode="${4:-0644}" dir="${CERTS_DIR}/${1}"
  case "${key_mode}" in
    0600|0644) ;;
    *) echo "error: invalid private-key mode for ${name}: ${key_mode}" >&2; exit 1 ;;
  esac
  if [ -f "${dir}/${name}-cert.pem" ] && [ "$FORCE" = false ]; then
    for required_file in \
      "${dir}/${name}-key.pem" "${dir}/${name}-cert.pem" "${dir}/ca-cert.pem"; do
      if [ ! -f "${required_file}" ] || [ -L "${required_file}" ]; then
        echo "error: incomplete or unsafe existing ${name} certificate set: ${required_file}" >&2
        exit 1
      fi
    done
    # The PostgreSQL root entrypoint owns its persistent key as root:root.
    # Avoid even a no-op chmod when the mode is already correct so a non-root
    # idempotent generator run can safely validate and skip that inode.
    ensure_file_mode "${dir}/${name}-key.pem" "${key_mode}"
    ensure_file_mode "${dir}/${name}-cert.pem" 0644
    ensure_file_mode "${dir}/ca-cert.pem" 0644
    echo "  [skip] ${name}"; return; fi
  mkdir -p "$dir"
  # Generate beside the destination and publish by atomic rename. A prior
  # production start may have made the canonical inode root-owned; truncating
  # that inode would fail for the deploy user even though it owns the parent
  # directory, whereas same-directory rename remains atomic and safe.
  GENERATED_KEY_STAGE=$(mktemp "${dir}/.${name}-key.pem.XXXXXX")
  openssl genrsa -out "${GENERATED_KEY_STAGE}" 2048 2>/dev/null
  openssl req -new -key "${GENERATED_KEY_STAGE}" -out "${dir}/${name}.csr" \
    -subj "/CN=${cn}/O=Aquaculture Platform" -addext "subjectAltName=${san}" 2>/dev/null
  openssl x509 -req -days 365 -in "${dir}/${name}.csr" \
    -CA "${CERTS_DIR}/ca/ca-cert.pem" -CAkey "${CERTS_DIR}/ca/ca-key.pem" \
    -CAcreateserial -out "${dir}/${name}-cert.pem" -copy_extensions copyall 2>/dev/null
  cp "${CERTS_DIR}/ca/ca-cert.pem" "${dir}/ca-cert.pem"
  rm -f "${dir}/${name}.csr"
  # Redis and NATS consume their source keys directly as non-root users. The
  # PostgreSQL key is different: a root entrypoint copies it into a postgres-
  # owned tmpfs, so its persistent source must remain root-only.
  chmod "${key_mode}" "${GENERATED_KEY_STAGE}"
  mv -fT -- "${GENERATED_KEY_STAGE}" "${dir}/${name}-key.pem"
  GENERATED_KEY_STAGE=''
  chmod 0644 "${dir}/${name}-cert.pem" "${dir}/ca-cert.pem"
  echo "  [done] ${name} (CN=${cn})"
}

# SECURITY (HIGH-002 / V4): per-service mTLS client certs.
# nats-tls-enabled.conf runs with `verify_and_map: true` — NATS maps the
# client cert's CN to the matching `users[*].user` entry in nats.conf.
# CN values MUST therefore match the per-service NATS user names exactly:
# auth_service, farm_service, sensor_service, gateway_service, etc.
# A per-service cert + per-service NATS user means a compromised service's
# cert grants ONLY that service's pub/sub permissions — cert rotation is
# also identity rotation, atomically.
generate_per_service_client_cert() {
  local svc_user="$1"  # must match nats.conf users[*].user value exactly
  local out_dir="${CERTS_DIR}/nats/clients"
  if [ -f "${out_dir}/${svc_user}-cert.pem" ] && [ "$FORCE" = false ]; then
    echo "  [skip] ${svc_user} client"; return; fi
  mkdir -p "$out_dir"
  openssl genrsa -out "${out_dir}/${svc_user}-key.pem" 2048 2>/dev/null
  # NATS 2.10 verify_and_map uses DistinguishedNameMatch which compares the
  # FULL Subject DN against the user name. Adding /O=... makes the DN
  # "CN=farm_service,O=Aquaculture Platform" which doesn't match the nats.conf
  # user entry "farm_service". CN-only ensures DN == CN == nats.conf user.
  openssl req -new -key "${out_dir}/${svc_user}-key.pem" \
    -out "${out_dir}/${svc_user}.csr" \
    -subj "/CN=${svc_user}" 2>/dev/null
  openssl x509 -req -days 365 -in "${out_dir}/${svc_user}.csr" \
    -CA "${CERTS_DIR}/ca/ca-cert.pem" -CAkey "${CERTS_DIR}/ca/ca-key.pem" \
    -CAcreateserial -out "${out_dir}/${svc_user}-cert.pem" 2>/dev/null
  rm -f "${out_dir}/${svc_user}.csr"
  chmod 644 "${out_dir}/${svc_user}-key.pem" "${out_dir}/${svc_user}-cert.pem"
  echo "  [done] ${svc_user} client (CN=${svc_user})"
}

# Legacy shared client cert — kept for backward-compat with deployments that
# have not yet rolled per-service certs. Production posture is per-service;
# this is removed in a future cleanup once ALL deployments have rotated.
generate_client_cert() {
  local name="$1" cn="$2" dir="${CERTS_DIR}/${1}"
  if [ -f "${dir}/client-cert.pem" ] && [ "$FORCE" = false ]; then
    echo "  [skip] ${name} client (legacy shared)"; return; fi
  mkdir -p "$dir"
  openssl genrsa -out "${dir}/client-key.pem" 2048 2>/dev/null
  openssl req -new -key "${dir}/client-key.pem" -out "${dir}/client.csr" \
    -subj "/CN=${cn}/O=Aquaculture Platform" 2>/dev/null
  openssl x509 -req -days 365 -in "${dir}/client.csr" \
    -CA "${CERTS_DIR}/ca/ca-cert.pem" -CAkey "${CERTS_DIR}/ca/ca-key.pem" \
    -CAcreateserial -out "${dir}/client-cert.pem" 2>/dev/null
  rm -f "${dir}/client.csr"
  chmod 644 "${dir}/client-key.pem" "${dir}/client-cert.pem"
  echo "  [done] ${name} client (CN=${cn})  [legacy shared]"
}

echo "=== Generating Internal TLS Certificates ==="
CA_DIR="${CERTS_DIR}/ca"
if [ -f "${CA_DIR}/ca-cert.pem" ] && [ "$FORCE" = false ]; then
  echo "  [skip] CA"
else
  mkdir -p "$CA_DIR"
  openssl genrsa -out "${CA_DIR}/ca-key.pem" 4096 2>/dev/null
  openssl req -new -x509 -days 3650 -key "${CA_DIR}/ca-key.pem" \
    -out "${CA_DIR}/ca-cert.pem" -subj "/CN=Aquaculture Internal CA" 2>/dev/null
  chmod 600 "${CA_DIR}/ca-key.pem"
  echo "  [done] CA (10-year)"
fi
generate_server_cert "nats" "nats" "DNS:nats,DNS:aqua-nats,DNS:localhost"
generate_server_cert "redis" "redis" "DNS:redis,DNS:aqua-redis,DNS:localhost"
generate_server_cert "postgres" "postgres" "DNS:postgres,DNS:aqua-postgres,DNS:localhost" 0600

# Per-service mTLS client certs (V4 / verify_and_map identity model).
# CN must match the user name in nats.conf authorization{} block.
#
# SSoT: the service list is DERIVED at runtime from
# infrastructure/nats/services.yaml. DO NOT hand-edit a list here — editing
# services.yaml is the single correct way to add/remove a service cert.
# ADR-015 + BACKLOG-NATS-002: mirrors the pattern used by
# scripts/nats/generate-nats-conf.py so cert CNs and nats.conf users[]
# cannot drift apart.
#
# We use `python3 -c` + PyYAML (same toolchain the sibling generator uses)
# rather than `yq` — Python + PyYAML is preinstalled on GitHub Actions
# ubuntu-latest runners and every supported dev environment, eliminating
# an extra tool dependency. The inline script prints one service name per
# line on stdout, and errors (missing file, malformed YAML, missing
# `services` key, empty list) exit non-zero so `set -e` aborts this script
# — there is NO silent fallback to a hardcoded list.
#
# CI structural guard (.github/workflows/ci-affected.yml Phase A3):
#   grep -q 'python3.*yaml\.safe_load' on this file
# is asserted on every PR. The single-line `python3 -c` invocation below
# co-locates `python3` and `yaml.safe_load` on one physical line so the
# guard reliably catches a regression that re-introduces a hardcoded list.
# Refactors that split the parsing across multiple lines or hide it in a
# heredoc will fail the structural assertion — that is the intended trip
# wire, not a bug to work around.
SERVICES_YAML="${REPO_ROOT}/infrastructure/nats/services.yaml"
if [ ! -f "$SERVICES_YAML" ]; then
  echo "error: ${SERVICES_YAML} not found — cannot derive per-service cert CN list" >&2
  exit 1
fi
# WHY (single-line form) — keeps `python3` and `yaml.safe_load` on one
# physical line for the CI structural assertion above. Validation
# preserved: dict at top level, non-empty `services` list, every entry
# is a dict with a `name`. The compound `assert` raises AssertionError on
# any structural violation, which exits non-zero and (with `set -e`)
# aborts the shell script — NO silent fallback to a hardcoded list.
# WHAT — reads $SERVICES_YAML, validates structure, prints one CN per line
# on stdout, captured into $SERVICE_NAMES for the iteration loop. Uses
# `;` to chain simple statements and a generator-expression `print` so
# the whole pipeline fits in a single -c argument with no heredoc.
SERVICE_NAMES=$(python3 -c "import sys, yaml; d = yaml.safe_load(open(sys.argv[1])); assert isinstance(d, dict) and isinstance(d.get('services'), list) and d['services'] and all(isinstance(s, dict) and 'name' in s for s in d['services']), f'malformed services.yaml: {sys.argv[1]} — expected dict with non-empty services list, every entry having a name'; print('\n'.join(s['name'] for s in d['services']))" "$SERVICES_YAML")
if [ -z "$SERVICE_NAMES" ]; then
  echo "error: no service names extracted from ${SERVICES_YAML}" >&2
  exit 1
fi
for svc in $SERVICE_NAMES; do
  generate_per_service_client_cert "$svc"
done

# Legacy shared client cert — kept on-disk for compatibility with deployments
# that still mount certs/nats/client-cert.pem. New deployments mount the
# per-service certs from certs/nats/clients/<svc>-cert.pem instead.
generate_client_cert "nats" "aqua-services"

# PostgreSQL expects server.crt and server.key (not postgres-cert.pem)
# Create symlinks so both naming conventions work
PG_DIR="${CERTS_DIR}/postgres"
ln -sf postgres-cert.pem "${PG_DIR}/server.crt"
ln -sf postgres-key.pem "${PG_DIR}/server.key"
ln -sf ca-cert.pem "${PG_DIR}/root.crt"
echo "  [done] PostgreSQL symlinks (server.crt → postgres-cert.pem)"

echo "=== Done ==="
