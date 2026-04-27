#!/bin/bash
# =============================================================================
# PostgreSQL SSL Entrypoint Wrapper
#
# IP-1: Copies TLS certificates from mount point to $PGDATA with correct
# ownership (postgres:postgres) and permissions (key: 600, cert: 644).
#
# WHY: PostgreSQL requires ssl_key_file to be owned by the postgres user
# with chmod 600. Docker volume mounts inherit host uid/gid which is
# typically root — PG refuses to start with a world-readable key. This
# wrapper runs before the standard entrypoint, copies certs into PGDATA
# (which is writable and owned by postgres), then delegates to the
# standard docker-entrypoint.sh.
#
# INFRA-CRITICAL-017: postgres uid is image-family dependent.
#   - Alpine-based timescale/timescaledb image: postgres uid 999
#   - Debian/Ubuntu-based timescale/timescaledb-ha image: postgres uid 1000
# Hard-coding `chown 999:999` broke the HA image swap (b11bac15) — cert
# files ended up owned by a UID that postgres-as-1000 couldn't read,
# postgres failed its readiness check, the entire deploy chain blocked.
# Fix: detect the postgres uid/gid at runtime, so this wrapper works on
# ANY image with a `postgres` user. Falls back to 999 only if the user
# doesn't exist (defensive — should not happen with any sane PG image).
#
# Usage in docker-compose:
#   entrypoint: ["/usr/local/bin/postgres-ssl-entrypoint.sh"]
#   command: postgres -c ssl=on ...
# =============================================================================
set -e

SSL_MOUNT="/var/lib/postgresql/ssl"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"

# INFRA-CRITICAL-017: dynamically resolve postgres uid/gid (image-agnostic)
PG_UID=$(id -u postgres 2>/dev/null || echo 999)
PG_GID=$(id -g postgres 2>/dev/null || echo 999)
echo "[ssl-entrypoint] Resolved postgres user: uid=${PG_UID} gid=${PG_GID}"

if [ "${POSTGRES_SSL:-off}" = "on" ] && [ -f "${SSL_MOUNT}/server.crt" ]; then
  echo "[ssl-entrypoint] Copying TLS certificates from ${SSL_MOUNT} to ${PGDATA}"
  cp "${SSL_MOUNT}/server.crt" "${PGDATA}/server.crt"
  cp "${SSL_MOUNT}/server.key" "${PGDATA}/server.key"
  [ -f "${SSL_MOUNT}/root.crt" ] && cp "${SSL_MOUNT}/root.crt" "${PGDATA}/root.crt"

  # PostgreSQL requires key owned by postgres user with chmod 600
  chown ${PG_UID}:${PG_GID} "${PGDATA}/server.crt" "${PGDATA}/server.key"
  chmod 600 "${PGDATA}/server.key"
  chmod 644 "${PGDATA}/server.crt"
  [ -f "${PGDATA}/root.crt" ] && chown ${PG_UID}:${PG_GID} "${PGDATA}/root.crt" && chmod 644 "${PGDATA}/root.crt"

  echo "[ssl-entrypoint] Certificates installed (server.crt, server.key)"
elif [ "${POSTGRES_SSL:-off}" = "on" ]; then
  echo "[ssl-entrypoint] POSTGRES_SSL=on but no certs at ${SSL_MOUNT} — generating self-signed"
  # Generate self-signed cert if external mount is missing
  if [ ! -f "${PGDATA}/server.crt" ]; then
    openssl req -new -x509 -days 365 -nodes \
      -out "${PGDATA}/server.crt" \
      -keyout "${PGDATA}/server.key" \
      -subj "/CN=aqua-postgres/O=Aquaculture Platform" 2>/dev/null
    chown ${PG_UID}:${PG_GID} "${PGDATA}/server.crt" "${PGDATA}/server.key"
    chmod 600 "${PGDATA}/server.key"
    echo "[ssl-entrypoint] Self-signed certificate generated"
  fi
fi

# Delegate to standard PostgreSQL entrypoint
exec docker-entrypoint.sh "$@"
