#!/bin/bash
# Generate RSA key pair for RS256 JWT signing
# Usage: ./scripts/generate-jwt-keys.sh [output-dir]
#
# This generates:
#   - jwt-private.pem: RSA 2048-bit private key (auth-service ONLY)
#   - jwt-public.pem:  Corresponding public key (all verifying services)
#   - A suggested JWT_KEY_ID value for key rotation tracking

set -euo pipefail

OUTPUT_DIR="${1:-.}"
mkdir -p "$OUTPUT_DIR"

PRIVATE_KEY="$OUTPUT_DIR/jwt-private.pem"
PUBLIC_KEY="$OUTPUT_DIR/jwt-public.pem"

echo "Generating RSA 2048-bit key pair for JWT RS256 signing..."

# Generate private key
openssl genrsa -out "$PRIVATE_KEY" 2048 2>/dev/null

# Extract public key
openssl rsa -in "$PRIVATE_KEY" -pubout -out "$PUBLIC_KEY" 2>/dev/null

# Set restrictive permissions on private key
chmod 600 "$PRIVATE_KEY"
chmod 644 "$PUBLIC_KEY"

KEY_ID="key-$(date +%s)"

echo ""
echo "Keys generated successfully:"
echo "  Private key: $PRIVATE_KEY (auth-service only)"
echo "  Public key:  $PUBLIC_KEY (all services)"
echo ""
echo "Suggested environment variables:"
echo ""
echo "  # Auth service (signs tokens):"
echo "  JWT_PRIVATE_KEY_FILE=$PRIVATE_KEY"
echo "  JWT_PUBLIC_KEY_FILE=$PUBLIC_KEY"
echo "  JWT_KEY_ID=$KEY_ID"
echo ""
echo "  # All other services (verify tokens):"
echo "  JWT_PUBLIC_KEY_FILE=$PUBLIC_KEY"
echo ""
echo "  # Or inline (for Docker/K8s secrets):"
echo "  JWT_PRIVATE_KEY=\$(cat $PRIVATE_KEY)"
echo "  JWT_PUBLIC_KEY=\$(cat $PUBLIC_KEY)"
echo ""
echo "SECURITY: Never share the private key outside auth-service!"
