#!/bin/bash
# =============================================================================
# PostgreSQL SSL Entrypoint Wrapper
#
# IP-1 / INFRA-MEDIUM-054: Copies TLS certificates from exact source mounts
# into container-lifetime tmpfs with correct ownership and permissions. The
# private-key source alone is writable for root ownership/mode enforcement.
#
# WHY: PostgreSQL requires ssl_key_file to be owned by the postgres user with
# chmod 600. Docker bind mounts inherit host uid/gid, which is typically root.
# The key must also remain outside PGDATA: physical base backups archive the
# entire cluster directory, and a drill restore must not inherit production's
# server identity. Compose points ssl_cert_file/ssl_key_file at this tmpfs.
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
set -euo pipefail
umask 077

SSL_MOUNT="/var/lib/postgresql/ssl"
PGDATA="${PGDATA:-/var/lib/postgresql/data}"
TLS_RUNTIME_DIR="${POSTGRES_SSL_RUNTIME_DIR:-/run/aqua-postgres-tls}"
TLS_STAGE_DIR=''

die() {
  printf '[ssl-entrypoint] FATAL: %s\n' "$*" >&2
  exit 126
}

cleanup_tls_stage() {
  if [ -n "${TLS_STAGE_DIR}" ] && [ -d "${TLS_STAGE_DIR}" ]; then
    rm -rf -- "${TLS_STAGE_DIR}"
  fi
}
trap cleanup_tls_stage EXIT

resolve_mounted_file() {
  local requested_path=$1
  local resolved_path

  if [ -L "${requested_path}" ]; then
    die "TLS source must be an exact regular-file mount, not a symlink: ${requested_path}"
  fi
  resolved_path=$(readlink -f "${requested_path}") || die "missing TLS file: ${requested_path}"
  case "${resolved_path}" in
    "${SSL_MOUNT}"/*) ;;
    *) die "TLS source escapes the exact certificate boundary: ${requested_path}" ;;
  esac
  if [ "${resolved_path}" != "${requested_path}" ] || [ ! -f "${resolved_path}" ]; then
    die "TLS source is not a regular file: ${requested_path}"
  fi
  if [ "$(stat -c '%s' "${resolved_path}")" -lt 1 ]; then
    die "TLS source is empty: ${requested_path}"
  fi
  printf '%s' "${resolved_path}"
}

# INFRA-CRITICAL-017: dynamically resolve postgres uid/gid (image-agnostic)
PG_UID=$(id -u postgres 2>/dev/null || echo 999)
PG_GID=$(id -g postgres 2>/dev/null || echo 999)
echo "[ssl-entrypoint] Resolved postgres user: uid=${PG_UID} gid=${PG_GID}"

if [ "$(id -u)" -ne 0 ]; then
  die 'TLS and WAL-G source material must be staged by the root entrypoint.'
fi
if [ "${PG_UID}" -eq 0 ]; then
  die 'postgres runtime user must not be root.'
fi

if [ "${POSTGRES_SSL:-off}" = "on" ]; then
  if [ "${TLS_RUNTIME_DIR}" != '/run/aqua-postgres-tls' ]; then
    die 'POSTGRES_SSL_RUNTIME_DIR must be /run/aqua-postgres-tls.'
  fi
  SERVER_CERT_SOURCE=$(resolve_mounted_file "${SSL_MOUNT}/server.crt")
  SERVER_KEY_SOURCE=$(resolve_mounted_file "${SSL_MOUNT}/server.key")
  ROOT_CERT_SOURCE=$(resolve_mounted_file "${SSL_MOUNT}/root.crt")

  # The host deploy UID can numerically equal the image's postgres UID. The
  # exact key bind is writable solely so this root entrypoint can eliminate
  # that alias before PostgreSQL starts. The persistent source then remains
  # unreadable by postgres while the tmpfs copy below is deliberately owned by
  # postgres and constrained to mode 0600.
  chown 0:0 "${SERVER_KEY_SOURCE}"
  chmod 0600 "${SERVER_KEY_SOURCE}"
  if [ "$(stat -c '%u:%g:%a' "${SERVER_KEY_SOURCE}")" != '0:0:600' ]; then
    die 'PostgreSQL TLS source key must be owned by root:root with mode 0600.'
  fi

  mkdir -p "${TLS_RUNTIME_DIR}"
  if [ "$(stat -f -c '%T' "${TLS_RUNTIME_DIR}")" != 'tmpfs' ]; then
    die 'PostgreSQL TLS runtime directory must reside on tmpfs.'
  fi
  chown "${PG_UID}:${PG_GID}" "${TLS_RUNTIME_DIR}"
  chmod 0700 "${TLS_RUNTIME_DIR}"

  TLS_STAGE_DIR=$(mktemp -d "${TLS_RUNTIME_DIR}/.install.XXXXXX")
  cp --no-preserve=mode,ownership "${SERVER_CERT_SOURCE}" "${TLS_STAGE_DIR}/server.crt"
  cp --no-preserve=mode,ownership "${SERVER_KEY_SOURCE}" "${TLS_STAGE_DIR}/server.key"
  cp --no-preserve=mode,ownership "${ROOT_CERT_SOURCE}" "${TLS_STAGE_DIR}/root.crt"
  chown "${PG_UID}:${PG_GID}" \
    "${TLS_STAGE_DIR}/server.crt" \
    "${TLS_STAGE_DIR}/server.key" \
    "${TLS_STAGE_DIR}/root.crt"
  chmod 0644 "${TLS_STAGE_DIR}/server.crt" "${TLS_STAGE_DIR}/root.crt"
  chmod 0600 "${TLS_STAGE_DIR}/server.key"
  mv -f "${TLS_STAGE_DIR}/server.crt" "${TLS_RUNTIME_DIR}/server.crt"
  mv -f "${TLS_STAGE_DIR}/server.key" "${TLS_RUNTIME_DIR}/server.key"
  mv -f "${TLS_STAGE_DIR}/root.crt" "${TLS_RUNTIME_DIR}/root.crt"
  rmdir "${TLS_STAGE_DIR}"
  TLS_STAGE_DIR=''

  # Remove copies left by the legacy entrypoint before the first physical
  # backup. Command-line ssl_* paths now point only at the tmpfs files.
  for legacy_path in "${PGDATA}/server.crt" "${PGDATA}/server.key" "${PGDATA}/root.crt"; do
    if [ -d "${legacy_path}" ] && [ ! -L "${legacy_path}" ]; then
      die "refusing legacy TLS directory beneath PGDATA: ${legacy_path}"
    fi
    if [ -e "${legacy_path}" ] || [ -L "${legacy_path}" ]; then
      rm -f -- "${legacy_path}"
    fi
  done

  echo "[ssl-entrypoint] TLS certificate and key installed in runtime tmpfs"
fi

# INFRA-HIGH-040: install the manifest-bound WAL-G credential bundle into
# container-lifetime tmpfs before PostgreSQL can enable archive_mode. The
# loader refuses missing/unsafe files and any credential path beneath PGDATA,
# so production cannot start with credentials exposed in image metadata or
# captured by backup-push.
if [ "${WALG_ENABLED:-off}" = "on" ]; then
  /usr/local/bin/walg-load-secrets.sh install
fi

# Delegate to standard PostgreSQL entrypoint
trap - EXIT
exec docker-entrypoint.sh "$@"
