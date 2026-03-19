#!/usr/bin/env bash
# =============================================================================
# JWT JWKS Key Rotation Script
#
# Performs zero-downtime RS256 JWT key rotation:
#   1. Backs up current key pair as "previous" (for token grace period)
#   2. Generates a new RSA 2048-bit key pair
#   3. Writes new key ID
#
# After running this script, restart auth-service so it picks up the new keys.
# The JWKS endpoint will serve BOTH keys during the rotation window, so tokens
# signed with the old key remain valid until they expire (default TTL: 1h).
#
# Usage:
#   ./scripts/rotate-jwt-keys.sh                     # Default: ./secrets
#   ./scripts/rotate-jwt-keys.sh --secrets-dir /path  # Custom secrets dir
#
# Files managed:
#   jwt_private_key.pem          - Current RSA private key (auth-service only)
#   jwt_public_key.pem           - Current RSA public key
#   jwt_key_id                   - Current key ID (e.g. key-1711036800)
#   jwt_previous_public_key.pem  - Previous public key (rotation grace period)
#   jwt_previous_key_id          - Previous key ID
#
# Environment variables set by these files (in docker-compose):
#   JWT_PRIVATE_KEY_FILE  -> jwt_private_key.pem
#   JWT_PUBLIC_KEY_FILE   -> jwt_public_key.pem
#   JWT_KEY_ID            -> contents of jwt_key_id
#   JWT_PREVIOUS_PUBLIC_KEY_FILE -> jwt_previous_public_key.pem
#   JWT_PREVIOUS_KEY_ID   -> contents of jwt_previous_key_id
#
# Cron example (monthly rotation at 3 AM on the 1st):
#   0 3 1 * * /opt/aquaculture/scripts/rotate-jwt-keys.sh --secrets-dir /opt/aquaculture/secrets >> /var/log/jwt-rotation.log 2>&1
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
    -h|--help)
      echo "Usage: $0 [--secrets-dir <path>]"
      echo ""
      echo "Options:"
      echo "  --secrets-dir <path>   Directory for secret files (default: ./secrets)"
      echo "  -h, --help             Show this help"
      exit 0
      ;;
    *)
      err "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# Default secrets dir
if [ -z "$SECRETS_DIR" ]; then
  SECRETS_DIR="${REPO_ROOT}/secrets"
fi

# ---------------------------------------------------------------------------
# Preflight checks
# ---------------------------------------------------------------------------
if ! command -v openssl &> /dev/null; then
  err "openssl is required but not found in PATH"
  exit 1
fi

mkdir -p "$SECRETS_DIR"

# ---------------------------------------------------------------------------
# Step 1: Backup current keys as "previous" (if they exist)
# ---------------------------------------------------------------------------
if [ -f "$SECRETS_DIR/jwt_public_key.pem" ]; then
  log "Backing up current public key as previous..."
  cp "$SECRETS_DIR/jwt_public_key.pem" "$SECRETS_DIR/jwt_previous_public_key.pem"
  chmod 644 "$SECRETS_DIR/jwt_previous_public_key.pem"

  if [ -f "$SECRETS_DIR/jwt_key_id" ]; then
    cp "$SECRETS_DIR/jwt_key_id" "$SECRETS_DIR/jwt_previous_key_id"
    chmod 644 "$SECRETS_DIR/jwt_previous_key_id"
    PREV_KEY_ID="$(cat "$SECRETS_DIR/jwt_previous_key_id")"
    log "Previous key ID preserved: $PREV_KEY_ID"
  else
    warn "No jwt_key_id file found; previous key ID will be empty"
  fi
else
  log "No existing keys found -- this is the first key generation"
fi

# ---------------------------------------------------------------------------
# Step 2: Generate new RSA 2048-bit key pair
# ---------------------------------------------------------------------------
NEW_KEY_ID="key-$(date +%s)"

log "Generating new RSA 2048-bit key pair..."
openssl genrsa -out "$SECRETS_DIR/jwt_private_key.pem" 2048 2>/dev/null

openssl rsa \
  -in "$SECRETS_DIR/jwt_private_key.pem" \
  -pubout \
  -out "$SECRETS_DIR/jwt_public_key.pem" 2>/dev/null

echo -n "$NEW_KEY_ID" > "$SECRETS_DIR/jwt_key_id"

# Restrictive permissions: private key readable only by owner
chmod 600 "$SECRETS_DIR/jwt_private_key.pem"
chmod 644 "$SECRETS_DIR/jwt_public_key.pem"
chmod 644 "$SECRETS_DIR/jwt_key_id"

log "New key generated successfully"
log "  Key ID:      $NEW_KEY_ID"
log "  Private key: $SECRETS_DIR/jwt_private_key.pem"
log "  Public key:  $SECRETS_DIR/jwt_public_key.pem"

# ---------------------------------------------------------------------------
# Step 3: Verify the key pair
# ---------------------------------------------------------------------------
log "Verifying key pair..."
TEST_DATA="rotation-verify-$(date +%s)"
echo -n "$TEST_DATA" | openssl dgst -sha256 -sign "$SECRETS_DIR/jwt_private_key.pem" -out /tmp/jwt-rotation-sig.bin 2>/dev/null
VERIFY_RESULT=$(echo -n "$TEST_DATA" | openssl dgst -sha256 -verify "$SECRETS_DIR/jwt_public_key.pem" -signature /tmp/jwt-rotation-sig.bin 2>&1)
rm -f /tmp/jwt-rotation-sig.bin

if echo "$VERIFY_RESULT" | grep -q "Verified OK"; then
  log "Key pair verification: OK"
else
  err "Key pair verification FAILED -- aborting"
  exit 1
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
log "=========================================="
log "JWT Key Rotation Complete"
log "=========================================="
log "New key ID:      $NEW_KEY_ID"

if [ -f "$SECRETS_DIR/jwt_previous_key_id" ]; then
  log "Previous key ID: $(cat "$SECRETS_DIR/jwt_previous_key_id")"
fi

echo ""
log "Next steps:"
log "  1. Restart auth-service to pick up new keys"
log "  2. JWKS endpoint will serve both keys during grace period"
log "  3. After token TTL expires (default 1h), old tokens are gone"
log "  4. Optionally remove previous key files after grace period"
echo ""
log "For Docker deployment, use: ./scripts/rotate-jwt-keys-docker.sh"
