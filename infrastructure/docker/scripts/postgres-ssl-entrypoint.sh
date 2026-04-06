#!/bin/bash
# =============================================================================
# PostgreSQL SSL Entrypoint Wrapper
#
# IP-1: Copies TLS certificates from mount point to $PGDATA with correct
# ownership (postgres:postgres) and permissions (key: 600, cert: 644).
#
# WHY: PostgreSQL requires ssl_key_file to be owned by the postgres user
# (uid 999) with chmod 600. Docker volume mounts inherit host uid/gid
# which typically is root — PG refuses to start with a world-readable key.
# This wrapper runs before the standard entrypoint, copies certs into
# PGDATA (which is writable and owned by postgres), then delegates to
# the standard docker-entrypoint.sh.
#
# Usage in docker-compose:
#   entrypoint: ["/usr/local/bin/postgres-ssl-entrypoint.sh"]
#   command: postgres -c ssl=on ...
# =============================================================================
set -e

SSL_MOUNT="/var/lib/postgresql/ssl"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"

if [ "${POSTGRES_SSL:-off}" = "on" ] && [ -f "${SSL_MOUNT}/server.crt" ]; then
  echo "[ssl-entrypoint] Copying TLS certificates from ${SSL_MOUNT} to ${PGDATA}"
  cp "${SSL_MOUNT}/server.crt" "${PGDATA}/server.crt"
  cp "${SSL_MOUNT}/server.key" "${PGDATA}/server.key"
  [ -f "${SSL_MOUNT}/root.crt" ] && cp "${SSL_MOUNT}/root.crt" "${PGDATA}/root.crt"

  # PostgreSQL requires key owned by postgres (uid 999) with 600
  chown 999:999 "${PGDATA}/server.crt" "${PGDATA}/server.key"
  chmod 600 "${PGDATA}/server.key"
  chmod 644 "${PGDATA}/server.crt"
  [ -f "${PGDATA}/root.crt" ] && chown 999:999 "${PGDATA}/root.crt" && chmod 644 "${PGDATA}/root.crt"

  echo "[ssl-entrypoint] Certificates installed (server.crt, server.key)"
elif [ "${POSTGRES_SSL:-off}" = "on" ]; then
  echo "[ssl-entrypoint] POSTGRES_SSL=on but no certs at ${SSL_MOUNT} — generating self-signed"
  # Generate self-signed cert if external mount is missing
  if [ ! -f "${PGDATA}/server.crt" ]; then
    openssl req -new -x509 -days 365 -nodes \
      -out "${PGDATA}/server.crt" \
      -keyout "${PGDATA}/server.key" \
      -subj "/CN=aqua-postgres/O=Aquaculture Platform" 2>/dev/null
    chown 999:999 "${PGDATA}/server.crt" "${PGDATA}/server.key"
    chmod 600 "${PGDATA}/server.key"
    echo "[ssl-entrypoint] Self-signed certificate generated"
  fi
fi

# Delegate to standard PostgreSQL entrypoint
exec docker-entrypoint.sh "$@"
