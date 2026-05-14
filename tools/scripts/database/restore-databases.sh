#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# restore-databases.sh — restore a pg_dump archive from DigitalOcean Spaces
#
# Closes: docs/reviews/infra-expert/2026-04-14-infrastructure-hardening.md#INFRA-BACKUP-002
#
# Downloads one backup artifact (produced by backup-databases.sh), decrypts it
# if it's GPG-encrypted, and restores it into the target Postgres container.
# Always drops + recreates the target database — intended for ephemeral
# restore-drill containers, NOT for in-place production recovery. Production
# recovery follows a different runbook (not yet written; see INFRA-BACKUP-002).
#
# Environment contract (required unless default shown):
#   TARGET_CONTAINER   Docker container running target Postgres   [required]
#   TARGET_USER        Superuser for restore                      [default: aquaculture]
#   TARGET_DB          Database to drop + create + restore into   [default: aquaculture_restore]
#   SPACES_BUCKET      DO Spaces bucket                           [required]
#   SPACES_ENDPOINT    Spaces region endpoint                     [default: https://fra1.digitaloceanspaces.com]
#   AWS_ACCESS_KEY_ID  Spaces access key                          [required]
#   AWS_SECRET_ACCESS_KEY                                         [required]
#   BACKUP_KEY         Object key inside the bucket               [required]
#   BACKUP_GPG_KEY     GPG secret key ID for decryption           [required if .gpg]
# -----------------------------------------------------------------------------

set -euo pipefail

TARGET_USER="${TARGET_USER:-aquaculture}"
TARGET_DB="${TARGET_DB:-aquaculture_restore}"
SPACES_ENDPOINT="${SPACES_ENDPOINT:-https://fra1.digitaloceanspaces.com}"

: "${TARGET_CONTAINER:?TARGET_CONTAINER required}"
: "${SPACES_BUCKET:?SPACES_BUCKET required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required}"
: "${BACKUP_KEY:?BACKUP_KEY required (e.g., pg-backups/2026/04/14/aquaculture-20260414T030000Z.dump)}"

# -----------------------------------------------------------------------------
# Tier-1 destructive-operation guards
# -----------------------------------------------------------------------------
# This script unconditionally DROPs TARGET_DB. A misconfigured environment
# (TARGET_DB=aquaculture + TARGET_CONTAINER=aqua-postgres) would wipe
# production in one step. The guards below refuse any combination that
# could touch live data without an explicit consciously-typed override.

# 1. Protected database names — refuse outright.
_PROTECTED_DBS=(aquaculture postgres template0 template1)
for _protected in "${_PROTECTED_DBS[@]}"; do
  if [ "${TARGET_DB}" = "${_protected}" ]; then
    echo "FATAL: refusing to DROP protected database '${TARGET_DB}'." >&2
    echo "       Use a disposable drill DB name, e.g. aquaculture_restore_$(date -u +%s)." >&2
    exit 4
  fi
done

# 2. Live production container — refuse unless the operator consciously
#    typed I_UNDERSTAND_DRILL_AGAINST_LIVE_CONTAINER=1. The drill runbook
#    (docs/runbooks/database-restore-drill.md) brings up a SEPARATE
#    aqua-postgres-drill container; touching aqua-postgres is outside the
#    documented procedure.
if [ "${TARGET_CONTAINER}" = "aqua-postgres" ] && \
   [ -z "${I_UNDERSTAND_DRILL_AGAINST_LIVE_CONTAINER:-}" ]; then
  echo "FATAL: refusing to restore into live container '${TARGET_CONTAINER}'." >&2
  echo "       The drill runbook uses aqua-postgres-drill (separate container)." >&2
  echo "       If you truly need to restore into the live container, set" >&2
  echo "       I_UNDERSTAND_DRILL_AGAINST_LIVE_CONTAINER=1 after reading the runbook." >&2
  exit 4
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not found on PATH." >&2
  exit 2
fi

if ! docker inspect "${TARGET_CONTAINER}" >/dev/null 2>&1; then
  echo "ERROR: target container '${TARGET_CONTAINER}' not found." >&2
  exit 2
fi

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

TMP=$(mktemp -d -t pg-restore-XXXX)
trap 'rm -rf "${TMP}"' EXIT

LOCAL_DUMP="${TMP}/$(basename "${BACKUP_KEY}")"

log "Reading object metadata for s3://${SPACES_BUCKET}/${BACKUP_KEY}"
HEAD_OBJECT=$(aws s3api head-object \
  --bucket "${SPACES_BUCKET}" \
  --key "${BACKUP_KEY}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query '[ContentLength, Metadata.sha256]' \
  --output text)
read -r REMOTE_SIZE REMOTE_SHA256 <<< "${HEAD_OBJECT}"

if [ -z "${REMOTE_SHA256:-}" ] || [ "${REMOTE_SHA256}" = "None" ] || [ "${REMOTE_SHA256}" = "null" ]; then
  echo "ERROR: backup object is missing required sha256 metadata: s3://${SPACES_BUCKET}/${BACKUP_KEY}" >&2
  exit 5
fi

log "Downloading s3://${SPACES_BUCKET}/${BACKUP_KEY}"
aws s3 cp "s3://${SPACES_BUCKET}/${BACKUP_KEY}" "${LOCAL_DUMP}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --only-show-errors

LOCAL_SIZE=$(stat -c '%s' "${LOCAL_DUMP}")
LOCAL_SHA256=$(sha256sum "${LOCAL_DUMP}" | awk '{print $1}')

if [ "${LOCAL_SIZE}" != "${REMOTE_SIZE}" ]; then
  echo "ERROR: downloaded object size mismatch for s3://${SPACES_BUCKET}/${BACKUP_KEY}: local=${LOCAL_SIZE} remote=${REMOTE_SIZE}" >&2
  exit 5
fi

if [ "${LOCAL_SHA256}" != "${REMOTE_SHA256}" ]; then
  echo "ERROR: downloaded object sha256 mismatch for s3://${SPACES_BUCKET}/${BACKUP_KEY}: local=${LOCAL_SHA256} remote=${REMOTE_SHA256}" >&2
  exit 5
fi

log "Downloaded object integrity verified: size=${LOCAL_SIZE} sha256=${LOCAL_SHA256}"

if [[ "${LOCAL_DUMP}" == *.gpg ]]; then
  : "${BACKUP_GPG_KEY:?BACKUP_GPG_KEY required to decrypt .gpg archive}"
  if ! command -v gpg >/dev/null 2>&1; then
    echo "ERROR: gpg not found on PATH." >&2
    exit 2
  fi
  log "Decrypting with key ${BACKUP_GPG_KEY}"
  DECRYPTED="${LOCAL_DUMP%.gpg}"
  gpg --batch --yes --decrypt \
    --local-user "${BACKUP_GPG_KEY}" \
    --output "${DECRYPTED}" \
    "${LOCAL_DUMP}"
  LOCAL_DUMP="${DECRYPTED}"
fi

log "Dropping and recreating database ${TARGET_DB} in ${TARGET_CONTAINER}"
docker exec -i "${TARGET_CONTAINER}" psql \
  -U "${TARGET_USER}" \
  -d postgres \
  -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS ${TARGET_DB};" \
  -c "CREATE DATABASE ${TARGET_DB};"

log "Restoring archive into ${TARGET_DB}"
docker exec -i "${TARGET_CONTAINER}" \
  pg_restore \
    -U "${TARGET_USER}" \
    -d "${TARGET_DB}" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    --verbose \
  < "${LOCAL_DUMP}"

log "Restore complete — listing schemas in ${TARGET_DB}"
docker exec -i "${TARGET_CONTAINER}" psql \
  -U "${TARGET_USER}" \
  -d "${TARGET_DB}" \
  -c "SELECT schema_name FROM information_schema.schemata
      WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')
        AND schema_name NOT LIKE 'pg_%'
      ORDER BY 1;"

log "Done"
