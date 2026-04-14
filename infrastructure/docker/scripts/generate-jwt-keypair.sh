#!/bin/bash
# =============================================================================
# JWT RSA Keypair Generator — Aquaculture Platform
# Usage: ./generate-jwt-keypair.sh [--force]
# Output: ./certs/jwt/{private,public}.pem
# =============================================================================
# SECURITY: auth-service is the sole token issuer. It signs access tokens with
# the RSA private key; every consumer service verifies them with the public
# key. RS256 asymmetric signing replaces the previous HS256 shared-secret
# model, where any compromised service could forge tokens platform-wide.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
JWT_DIR="${REPO_ROOT}/certs/jwt"
FORCE=false
[ "${1:-}" = "--force" ] && FORCE=true

echo "=== Generating JWT RSA Keypair ==="

if [ -f "${JWT_DIR}/private.pem" ] && [ -f "${JWT_DIR}/public.pem" ] && [ "$FORCE" = false ]; then
  echo "  [skip] JWT keypair exists at ${JWT_DIR} (use --force to regenerate)"
  exit 0
fi

mkdir -p "$JWT_DIR"

# 4096-bit — overkill but matches the CA key size and costs nothing at verify time.
openssl genrsa -out "${JWT_DIR}/private.pem" 4096 2>/dev/null
openssl rsa -in "${JWT_DIR}/private.pem" -pubout -out "${JWT_DIR}/public.pem" 2>/dev/null

# SECURITY: Private key readable only by the owner; public key world-readable.
# Container JWT mount is read-only (see docker-compose.prod.yml jwt volume).
chmod 600 "${JWT_DIR}/private.pem"
chmod 644 "${JWT_DIR}/public.pem"

echo "  [done] ${JWT_DIR}/private.pem (600)"
echo "  [done] ${JWT_DIR}/public.pem (644)"
echo ""
echo "WARNING: auth-service needs both private and public; every other service"
echo "         only needs the public key. Never mount private.pem outside of"
echo "         the auth-service container."
echo "=== Done ==="
