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

log "Downloading s3://${SPACES_BUCKET}/${BACKUP_KEY}"
aws s3 cp "s3://${SPACES_BUCKET}/${BACKUP_KEY}" "${LOCAL_DUMP}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --only-show-errors

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
