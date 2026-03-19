#!/usr/bin/env bash
# =============================================================================
# SEC-022: Docker Secrets Setup
#
# Generates initial secret files under ./secrets/ for Docker Compose
# file-based secrets. Each file contains a single secret value.
#
# Usage:
#   ./scripts/setup-secrets.sh           # Generate missing secrets (skip existing)
#   ./scripts/setup-secrets.sh --force   # Regenerate ALL secrets (destructive!)
#
# The generated files are mounted into containers via docker-compose secrets:
#   secrets:
#     jwt_secret:
#       file: ./secrets/jwt_secret
# =============================================================================

set -euo pipefail

SECRETS_DIR="$(cd "$(dirname "$0")/.." && pwd)/secrets"
FORCE="${1:-}"

info()  { echo -e "\033[0;34m[INFO]\033[0m  $1"; }
warn()  { echo -e "\033[0;33m[WARN]\033[0m  $1"; }
ok()    { echo -e "\033[0;32m[OK]\033[0m    $1"; }
skip()  { echo -e "\033[0;90m[SKIP]\033[0m  $1 (already exists)"; }

generate_secret() {
  local name="$1"
  local file="${SECRETS_DIR}/${name}"
  local generator="${2:-openssl rand -base64 32}"

  if [ -f "$file" ] && [ "$FORCE" != "--force" ]; then
    skip "$name"
    return
  fi

  eval "$generator" > "$file"
  chmod 600 "$file"
  ok "$name"
}

# ---------------------------------------------------------------------------
info "Setting up Docker Secrets in ${SECRETS_DIR}"
info "============================================="
# ---------------------------------------------------------------------------

mkdir -p "$SECRETS_DIR"

# Core infrastructure secrets
generate_secret "database_password"       "openssl rand -base64 32"
generate_secret "redis_password"          "openssl rand -base64 32"
generate_secret "jwt_secret"              "openssl rand -base64 48"
generate_secret "nats_password"           "openssl rand -base64 32"
generate_secret "encryption_key"          "openssl rand -hex 32"

# Service-specific secrets
generate_secret "smtp_password"           "echo 'CHANGEME_smtp_password'"
generate_secret "mqtt_auth_secret"        "openssl rand -base64 32"
generate_secret "minio_password"          "openssl rand -base64 32"
generate_secret "observability_api_key"   "openssl rand -base64 32"
generate_secret "super_admin_password"    "openssl rand -base64 24"
generate_secret "mfa_encryption_key"      "openssl rand -hex 32"
generate_secret "credential_encryption_key" "openssl rand -hex 32"
generate_secret "internal_service_secret" "openssl rand -base64 32"

# ---------------------------------------------------------------------------
# SEC-024: RS256 JWKS key pair for JWT signing/verification
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -f "${SECRETS_DIR}/jwt_private_key.pem" ] || [ "$FORCE" = "--force" ]; then
  info "Generating initial RS256 JWT key pair..."
  "${SCRIPT_DIR}/rotate-jwt-keys.sh" --secrets-dir "$SECRETS_DIR"
else
  skip "jwt_private_key.pem"
  skip "jwt_public_key.pem"
  skip "jwt_key_id"
fi

# Ensure previous key placeholder exists (Docker Compose requires the file)
if [ ! -f "${SECRETS_DIR}/jwt_previous_public_key.pem" ]; then
  touch "${SECRETS_DIR}/jwt_previous_public_key.pem"
  chmod 644 "${SECRETS_DIR}/jwt_previous_public_key.pem"
  ok "jwt_previous_public_key.pem (empty placeholder)"
else
  skip "jwt_previous_public_key.pem"
fi

if [ ! -f "${SECRETS_DIR}/jwt_previous_key_id" ]; then
  touch "${SECRETS_DIR}/jwt_previous_key_id"
  chmod 644 "${SECRETS_DIR}/jwt_previous_key_id"
  ok "jwt_previous_key_id (empty placeholder)"
else
  skip "jwt_previous_key_id"
fi

# Ensure .gitkeep exists
touch "${SECRETS_DIR}/.gitkeep"

echo ""
info "============================================="
info "Secret files generated in: ${SECRETS_DIR}"
warn "Review and update placeholder values (e.g., smtp_password)"
warn "Ensure secrets/ is in .gitignore (it is by default)"
info "============================================="
