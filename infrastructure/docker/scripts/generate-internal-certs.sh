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

generate_server_cert() {
  local name="$1" cn="$2" san="$3" dir="${CERTS_DIR}/${1}"
  if [ -f "${dir}/${name}-cert.pem" ] && [ "$FORCE" = false ]; then
    echo "  [skip] ${name}"; return; fi
  mkdir -p "$dir"
  openssl genrsa -out "${dir}/${name}-key.pem" 2048 2>/dev/null
  openssl req -new -key "${dir}/${name}-key.pem" -out "${dir}/${name}.csr" \
    -subj "/CN=${cn}/O=Aquaculture Platform" -addext "subjectAltName=${san}" 2>/dev/null
  openssl x509 -req -days 365 -in "${dir}/${name}.csr" \
    -CA "${CERTS_DIR}/ca/ca-cert.pem" -CAkey "${CERTS_DIR}/ca/ca-key.pem" \
    -CAcreateserial -out "${dir}/${name}-cert.pem" -copy_extensions copyall 2>/dev/null
  cp "${CERTS_DIR}/ca/ca-cert.pem" "${dir}/ca-cert.pem"
  rm -f "${dir}/${name}.csr"
  # WHY: 644 not 600 — container processes (redis, nats, postgres) run as
  # non-root users that need to read the key file. The key only protects
  # against eavesdropping on the internal Docker network; the CA private key
  # (which can mint new certs) remains 600.
  chmod 644 "${dir}/${name}-key.pem" "${dir}/${name}-cert.pem" "${dir}/ca-cert.pem"
  echo "  [done] ${name} (CN=${cn})"
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
generate_server_cert "postgres" "postgres" "DNS:postgres,DNS:aqua-postgres,DNS:localhost"

# PostgreSQL expects server.crt and server.key (not postgres-cert.pem)
# Create symlinks so both naming conventions work
PG_DIR="${CERTS_DIR}/postgres"
ln -sf postgres-cert.pem "${PG_DIR}/server.crt"
ln -sf postgres-key.pem "${PG_DIR}/server.key"
ln -sf ca-cert.pem "${PG_DIR}/root.crt"
echo "  [done] PostgreSQL symlinks (server.crt → postgres-cert.pem)"

echo "=== Done ==="
