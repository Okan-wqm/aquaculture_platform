#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# backup-databases.sh — PostgreSQL logical backup + snapshot-bound proof
#
# Runs against the droplet's local PostgreSQL container via `docker exec`.
# A single exported REPEATABLE READ snapshot feeds both pg_dump and the
# deterministic database-verification collector. The resulting JSON sidecar is
# hash-bound to the uploaded dump through reciprocal object metadata.
#
# Environment contract (required unless default shown):
#   POSTGRES_CONTAINER       Docker container name             [aqua-postgres]
#   POSTGRES_USER            Superuser for the dump            [aquaculture]
#   POSTGRES_DB              Database name                     [aquaculture]
#   SPACES_BUCKET            DO Spaces bucket                  [required unless dump-only]
#   SPACES_ENDPOINT          Spaces endpoint                   [https://fra1.digitaloceanspaces.com]
#   AWS_ACCESS_KEY_ID        Spaces access key                 [required unless dump-only]
#   AWS_SECRET_ACCESS_KEY    Spaces secret key                 [required unless dump-only]
#   BACKUP_PREFIX            Object prefix                     [pg-backups]
#   BACKUP_GPG_RECIPIENT     GPG recipient                     [required for upload]
#   MIN_DUMP_BYTES           Minimum accepted dump size        [10000]
#   PGPASSWORD               Password passed to Postgres tools [optional]
#   BACKUP_DUMP_ONLY         Skip upload                       [false]
#   DATABASE_VERIFICATION_SQL Generated verification collector [repo path]
# -----------------------------------------------------------------------------

set +x
set -euo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-aqua-postgres}"
POSTGRES_USER="${POSTGRES_USER:-aquaculture}"
POSTGRES_DB="${POSTGRES_DB:-aquaculture}"
SPACES_ENDPOINT="${SPACES_ENDPOINT:-https://fra1.digitaloceanspaces.com}"
BACKUP_PREFIX="${BACKUP_PREFIX:-pg-backups}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-10000}"
BACKUP_DUMP_ONLY="${BACKUP_DUMP_ONLY:-false}"
DATABASE_VERIFICATION_SQL="${DATABASE_VERIFICATION_SQL:-tools/scripts/database/database-verification.sql}"

case "${BACKUP_DUMP_ONLY}" in
  true|false) ;;
  *)
    echo "ERROR: BACKUP_DUMP_ONLY must be 'true' or 'false'." >&2
    exit 2
    ;;
esac

if [[ ! "${POSTGRES_DB}" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
  echo "ERROR: POSTGRES_DB must match ^[a-z][a-z0-9_]{0,62}$ for artifact and SQL safety." >&2
  exit 2
fi

if [[ ! "${MIN_DUMP_BYTES}" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: MIN_DUMP_BYTES must be a positive integer." >&2
  exit 2
fi

if [ ! -f "${DATABASE_VERIFICATION_SQL}" ]; then
  echo "ERROR: generated verification SQL not found: ${DATABASE_VERIFICATION_SQL}" >&2
  exit 2
fi

if [ "${BACKUP_DUMP_ONLY}" != "true" ]; then
  : "${SPACES_BUCKET:?SPACES_BUCKET required}"
  : "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required}"
  : "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required}"
  : "${BACKUP_GPG_RECIPIENT:?BACKUP_GPG_RECIPIENT required for client-encrypted upload}"

  if ! command -v aws >/dev/null 2>&1; then
    echo "ERROR: aws CLI not found on PATH. Install awscli v2." >&2
    exit 2
  fi
  if ! command -v gpg >/dev/null 2>&1; then
    echo "ERROR: gpg is required for client-encrypted upload." >&2
    exit 2
  fi
  if [[ ! "${BACKUP_GPG_RECIPIENT}" =~ ^[A-Fa-f0-9]{40}$ ]]; then
    echo "ERROR: BACKUP_GPG_RECIPIENT must be an exact 40-hex primary-key fingerprint." >&2
    exit 2
  fi
  mapfile -t BACKUP_GPG_PRIMARY_FINGERPRINTS < <(
    gpg --batch --with-colons --fingerprint --list-keys "${BACKUP_GPG_RECIPIENT}" 2>/dev/null |
      awk -F: '$1 == "pub" { want_fingerprint = 1; next } want_fingerprint && $1 == "fpr" { print toupper($10); want_fingerprint = 0 }'
  )
  if [ "${#BACKUP_GPG_PRIMARY_FINGERPRINTS[@]}" -ne 1 ] || \
     [ "${BACKUP_GPG_PRIMARY_FINGERPRINTS[0]}" != "${BACKUP_GPG_RECIPIENT^^}" ]; then
    echo "ERROR: BACKUP_GPG_RECIPIENT does not resolve to exactly one matching primary public key." >&2
    exit 2
  fi
fi

if ! docker inspect "${POSTGRES_CONTAINER}" >/dev/null 2>&1; then
  echo "ERROR: docker container '${POSTGRES_CONTAINER}' not found or docker daemon unreachable." >&2
  exit 2
fi

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_NAME="${POSTGRES_DB}-${TIMESTAMP}.dump"
DUMP_DIR=$(mktemp -d -t pg-backup-XXXX)
DUMP_PATH="${DUMP_DIR}/${DUMP_NAME}"
DATABASE_PAYLOAD="${DUMP_DIR}/${DUMP_NAME}.verification.json"
SNAPSHOT_STDERR="${DUMP_DIR}/snapshot-keeper.stderr"
VERIFICATION_STDERR="${DUMP_DIR}/database-verification.stderr"
KEEPER_PID=""
KEEPER_WRITE_FD=""

cleanup() {
  if [ -n "${KEEPER_PID}" ]; then
    printf 'ROLLBACK;\n\\q\n' >&"${KEEPER_WRITE_FD}" 2>/dev/null || true
    wait "${KEEPER_PID}" 2>/dev/null || true
  fi
  rm -rf "${DUMP_DIR}"
}
trap cleanup EXIT

log "Opening one exported snapshot for pg_dump and verification"
coproc SNAPSHOT_KEEPER {
  docker exec -i \
    -e "PGPASSWORD=${PGPASSWORD:-}" \
    "${POSTGRES_CONTAINER}" \
    psql \
      -X \
      -qAt \
      -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DB}" \
      -v ON_ERROR_STOP=1 \
      2> "${SNAPSHOT_STDERR}"
}
KEEPER_PID="${SNAPSHOT_KEEPER_PID}"
KEEPER_READ_FD="${SNAPSHOT_KEEPER[0]}"
KEEPER_WRITE_FD="${SNAPSHOT_KEEPER[1]}"

printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT pg_export_snapshot();\n' \
  >&"${KEEPER_WRITE_FD}"
if ! IFS= read -r -t 30 SNAPSHOT_ID <&"${KEEPER_READ_FD}"; then
  if [ -s "${SNAPSHOT_STDERR}" ]; then
    sed 's/^/  snapshot| /' "${SNAPSHOT_STDERR}" >&2
  fi
  echo "ERROR: PostgreSQL did not export a backup snapshot within 30 seconds." >&2
  exit 3
fi
if [[ ! "${SNAPSHOT_ID}" =~ ^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$ ]]; then
  echo "ERROR: PostgreSQL returned an invalid exported snapshot identifier." >&2
  exit 3
fi

log "Starting pg_dump of ${POSTGRES_DB} from the exported snapshot"
if ! docker exec -i \
    -e "PGPASSWORD=${PGPASSWORD:-}" \
    "${POSTGRES_CONTAINER}" \
    pg_dump \
      -U "${POSTGRES_USER}" \
      -d "${POSTGRES_DB}" \
      --format=custom \
      --compress=6 \
      --no-owner \
      --no-privileges \
      --snapshot="${SNAPSHOT_ID}" \
    > "${DUMP_PATH}" 2> "${DUMP_PATH}.stderr"; then
  if [ -s "${DUMP_PATH}.stderr" ]; then
    sed 's/^/  pg_dump| /' "${DUMP_PATH}.stderr" >&2
  fi
  echo "ERROR: pg_dump failed for database '${POSTGRES_DB}' in ${POSTGRES_CONTAINER}." >&2
  exit 3
fi

DUMP_SIZE=$(stat -c '%s' "${DUMP_PATH}")
log "pg_dump produced ${DUMP_SIZE} bytes"
if [ -s "${DUMP_PATH}.stderr" ]; then
  log "pg_dump stderr was non-empty:"
  sed 's/^/  pg_dump| /' "${DUMP_PATH}.stderr"
fi
if [ "${DUMP_SIZE}" -lt "${MIN_DUMP_BYTES}" ]; then
  echo "ERROR: dump is suspiciously small (${DUMP_SIZE} < ${MIN_DUMP_BYTES} bytes)." >&2
  exit 3
fi

log "Collecting canonical schema, migration-head, and sentinel parity from the same snapshot"
if ! (
  printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
  printf "SET TRANSACTION SNAPSHOT :'snapshot_id';\n"
  sed -n '1,$p' "${DATABASE_VERIFICATION_SQL}"
  printf '\nCOMMIT;\n'
) | docker exec -i \
      -e "PGPASSWORD=${PGPASSWORD:-}" \
      "${POSTGRES_CONTAINER}" \
      psql \
        -X \
        -qAt \
        -U "${POSTGRES_USER}" \
        -d "${POSTGRES_DB}" \
        -v ON_ERROR_STOP=1 \
        -v "snapshot_id=${SNAPSHOT_ID}" \
      > "${DATABASE_PAYLOAD}" 2> "${VERIFICATION_STDERR}"; then
  if [ -s "${VERIFICATION_STDERR}" ]; then
    sed 's/^/  verification| /' "${VERIFICATION_STDERR}" >&2
  fi
  echo "ERROR: database verification failed; refusing to publish the dump." >&2
  exit 3
fi
if [ ! -s "${DATABASE_PAYLOAD}" ] || [ "$(wc -l < "${DATABASE_PAYLOAD}")" -ne 1 ]; then
  echo "ERROR: database verification must produce exactly one non-empty JSON line." >&2
  exit 3
fi

printf 'COMMIT;\n\\q\n' >&"${KEEPER_WRITE_FD}"
if ! wait "${KEEPER_PID}"; then
  if [ -s "${SNAPSHOT_STDERR}" ]; then
    sed 's/^/  snapshot| /' "${SNAPSHOT_STDERR}" >&2
  fi
  echo "ERROR: snapshot keeper did not close cleanly." >&2
  exit 3
fi
KEEPER_PID=""

UPLOAD_PATH="${DUMP_PATH}"
VERIFICATION_UPLOAD_PATH="${DATABASE_PAYLOAD}"
if [ -n "${BACKUP_GPG_RECIPIENT}" ]; then
  if ! command -v gpg >/dev/null 2>&1; then
    echo "ERROR: BACKUP_GPG_RECIPIENT set but gpg not found on PATH." >&2
    exit 2
  fi
  log "Encrypting dump for configured GPG recipient"
  gpg --batch --yes --trust-model always --encrypt \
    --recipient "${BACKUP_GPG_RECIPIENT}" \
    --output "${DUMP_PATH}.gpg" \
    "${DUMP_PATH}"
  gpg --batch --yes --trust-model always --encrypt \
    --recipient "${BACKUP_GPG_RECIPIENT}" \
    --output "${DATABASE_PAYLOAD}.gpg" \
    "${DATABASE_PAYLOAD}"
  UPLOAD_PATH="${DUMP_PATH}.gpg"
  VERIFICATION_UPLOAD_PATH="${DATABASE_PAYLOAD}.gpg"
fi

UPLOAD_SIZE=$(stat -c '%s' "${UPLOAD_PATH}")
UPLOAD_SHA256=$(sha256sum "${UPLOAD_PATH}" | awk '{print $1}')
VERIFICATION_SIZE=$(stat -c '%s' "${VERIFICATION_UPLOAD_PATH}")
VERIFICATION_SHA256=$(sha256sum "${VERIFICATION_UPLOAD_PATH}" | awk '{print $1}')
VERIFICATION_PAYLOAD_SHA256=$(sha256sum "${DATABASE_PAYLOAD}" | awk '{print $1}')
log "Local dump integrity: size=${UPLOAD_SIZE} sha256=${UPLOAD_SHA256}"
log "Local encrypted verification integrity: size=${VERIFICATION_SIZE} sha256=${VERIFICATION_SHA256}"

if [ "${BACKUP_DUMP_ONLY}" = "true" ]; then
  log "BACKUP_DUMP_ONLY=true — snapshot-bound dump and verification completed; skipping upload"
  exit 0
fi

REMOTE_KEY="${BACKUP_PREFIX}/$(date -u +%Y/%m/%d)/$(basename "${UPLOAD_PATH}")"
VERIFICATION_KEY="${REMOTE_KEY}.verification.json.gpg"

log "Uploading verification sidecar to s3://${SPACES_BUCKET}/${VERIFICATION_KEY}"
aws s3 cp "${VERIFICATION_UPLOAD_PATH}" "s3://${SPACES_BUCKET}/${VERIFICATION_KEY}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --only-show-errors \
  --metadata "source=${POSTGRES_CONTAINER},db=${POSTGRES_DB},sha256=${VERIFICATION_SHA256},payload_sha256=${VERIFICATION_PAYLOAD_SHA256},dump_sha256=${UPLOAD_SHA256}"

log "Uploading dump to s3://${SPACES_BUCKET}/${REMOTE_KEY}"
aws s3 cp "${UPLOAD_PATH}" "s3://${SPACES_BUCKET}/${REMOTE_KEY}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --only-show-errors \
  --metadata "source=${POSTGRES_CONTAINER},db=${POSTGRES_DB},sha256=${UPLOAD_SHA256},verification_sha256=${VERIFICATION_SHA256},verification_payload_sha256=${VERIFICATION_PAYLOAD_SHA256},verification_size=${VERIFICATION_SIZE},verification_key=${VERIFICATION_KEY}"

HEAD_DUMP=$(aws s3api head-object \
  --bucket "${SPACES_BUCKET}" \
  --key "${REMOTE_KEY}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query '[ContentLength, Metadata.sha256, Metadata.verification_sha256, Metadata.verification_payload_sha256, Metadata.verification_key]' \
  --output text)
read -r REMOTE_SIZE REMOTE_SHA256 REMOTE_VERIFICATION_SHA256 REMOTE_VERIFICATION_PAYLOAD_SHA256 REMOTE_VERIFICATION_KEY <<< "${HEAD_DUMP}"

if [ "${REMOTE_SIZE}" != "${UPLOAD_SIZE}" ] || [ "${REMOTE_SHA256}" != "${UPLOAD_SHA256}" ]; then
  echo "ERROR: uploaded dump size or SHA-256 metadata mismatch." >&2
  exit 5
fi
if [ "${REMOTE_VERIFICATION_SHA256}" != "${VERIFICATION_SHA256}" ] || \
   [ "${REMOTE_VERIFICATION_PAYLOAD_SHA256}" != "${VERIFICATION_PAYLOAD_SHA256}" ] || \
   [ "${REMOTE_VERIFICATION_KEY}" != "${VERIFICATION_KEY}" ]; then
  echo "ERROR: uploaded dump is not bound to the expected verification sidecar." >&2
  exit 5
fi

HEAD_VERIFICATION=$(aws s3api head-object \
  --bucket "${SPACES_BUCKET}" \
  --key "${VERIFICATION_KEY}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query '[ContentLength, Metadata.sha256, Metadata.payload_sha256, Metadata.dump_sha256]' \
  --output text)
read -r REMOTE_VERIFICATION_SIZE REMOTE_SIDE_SHA256 REMOTE_SIDE_PAYLOAD_SHA256 REMOTE_SIDE_DUMP_SHA256 <<< "${HEAD_VERIFICATION}"

if [ "${REMOTE_VERIFICATION_SIZE}" != "${VERIFICATION_SIZE}" ] || \
   [ "${REMOTE_SIDE_SHA256}" != "${VERIFICATION_SHA256}" ] || \
   [ "${REMOTE_SIDE_PAYLOAD_SHA256}" != "${VERIFICATION_PAYLOAD_SHA256}" ] || \
   [ "${REMOTE_SIDE_DUMP_SHA256}" != "${UPLOAD_SHA256}" ]; then
  echo "ERROR: uploaded verification sidecar metadata does not match the dump." >&2
  exit 5
fi

log "Backup complete: dump=s3://${SPACES_BUCKET}/${REMOTE_KEY} verification=s3://${SPACES_BUCKET}/${VERIFICATION_KEY}"
