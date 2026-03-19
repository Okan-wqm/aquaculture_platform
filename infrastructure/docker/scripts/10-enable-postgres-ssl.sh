#!/bin/bash
# =============================================================================
# Enable SSL on PostgreSQL for production deployments
# =============================================================================
# This script runs inside the postgres container on first boot.
# It generates a self-signed certificate if no external cert is mounted,
# then enables ssl=on in postgresql.conf.
#
# For production with a real CA certificate:
#   Mount your cert/key at /var/lib/postgresql/ssl/server.crt and server.key
#   and your CA at /var/lib/postgresql/ssl/ca.crt
# =============================================================================

set -euo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
SSL_DIR="/var/lib/postgresql/ssl"

# Only enable SSL if POSTGRES_SSL=on is set
if [ "${POSTGRES_SSL:-off}" != "on" ]; then
  echo "SSL not requested (POSTGRES_SSL != on), skipping."
  exit 0
fi

echo "=== Enabling PostgreSQL SSL ==="

# If external certs are mounted, use them
if [ -f "$SSL_DIR/server.crt" ] && [ -f "$SSL_DIR/server.key" ]; then
  echo "Using externally mounted SSL certificates from $SSL_DIR"
  cp "$SSL_DIR/server.crt" "$PGDATA/server.crt"
  cp "$SSL_DIR/server.key" "$PGDATA/server.key"
  if [ -f "$SSL_DIR/ca.crt" ]; then
    cp "$SSL_DIR/ca.crt" "$PGDATA/root.crt"
  fi
else
  # Generate self-signed certificate for staging/initial setup
  echo "No external certs found in $SSL_DIR — generating self-signed certificate..."
  if [ ! -f "$PGDATA/server.crt" ] || [ ! -f "$PGDATA/server.key" ]; then
    openssl req -new -x509 -days 3650 -nodes \
      -out "$PGDATA/server.crt" \
      -keyout "$PGDATA/server.key" \
      -subj "/CN=aqua-postgres/O=Aquaculture Platform"
    echo "Self-signed certificate generated."
  else
    echo "Certificates already exist in $PGDATA, skipping generation."
  fi
fi

# Fix permissions (PostgreSQL requires key to be readable only by owner)
chmod 600 "$PGDATA/server.key"
chown postgres:postgres "$PGDATA/server.crt" "$PGDATA/server.key"
if [ -f "$PGDATA/root.crt" ]; then
  chmod 600 "$PGDATA/root.crt"
  chown postgres:postgres "$PGDATA/root.crt"
fi

# Enable SSL in postgresql.conf if not already enabled
if ! grep -q "^ssl = on" "$PGDATA/postgresql.conf" 2>/dev/null; then
  echo "" >> "$PGDATA/postgresql.conf"
  echo "# --- SSL configuration (added by 10-enable-postgres-ssl.sh) ---" >> "$PGDATA/postgresql.conf"
  echo "ssl = on" >> "$PGDATA/postgresql.conf"
  echo "ssl_cert_file = 'server.crt'" >> "$PGDATA/postgresql.conf"
  echo "ssl_key_file = 'server.key'" >> "$PGDATA/postgresql.conf"
  if [ -f "$PGDATA/root.crt" ]; then
    echo "ssl_ca_file = 'root.crt'" >> "$PGDATA/postgresql.conf"
  fi
  echo "SSL configuration appended to postgresql.conf"
else
  echo "SSL already enabled in postgresql.conf"
fi

echo "=== PostgreSQL SSL setup complete ==="
