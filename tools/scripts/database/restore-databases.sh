#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# restore-databases.sh — isolated restore with fail-closed parity verification
#
# Downloads one dump and its snapshot-bound verification JSON, restores into a
# disposable database, then re-runs the same collector and requires byte-for-
# byte parity. The command refuses protected/unsafe database names and enforces
# the 60-minute recovery-time objective by default.
# -----------------------------------------------------------------------------

set -euo pipefail

RESTORE_STARTED_EPOCH=$(date -u +%s)
TARGET_USER="${TARGET_USER:-aquaculture}"
TARGET_DB="${TARGET_DB:-aquaculture_restore}"
SPACES_ENDPOINT="${SPACES_ENDPOINT:-https://fra1.digitaloceanspaces.com}"
MAX_RESTORE_SECONDS="${MAX_RESTORE_SECONDS:-3600}"
DATABASE_VERIFICATION_SQL="${DATABASE_VERIFICATION_SQL:-tools/scripts/database/database-verification.sql}"
RESTORE_TARGET_LABEL='com.aqua-saas.restore.role'
RESTORE_TARGET_ROLE='isolated-drill'

: "${TARGET_CONTAINER:?TARGET_CONTAINER required}"
: "${SPACES_BUCKET:?SPACES_BUCKET required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required}"
: "${BACKUP_KEY:?BACKUP_KEY required}"

if [[ ! "${TARGET_DB}" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
  echo "FATAL: TARGET_DB must match ^[a-z][a-z0-9_]{0,62}$; refusing destructive SQL." >&2
  exit 4
fi

_PROTECTED_DBS=(aquaculture postgres template0 template1)
for _protected in "${_PROTECTED_DBS[@]}"; do
  if [ "${TARGET_DB}" = "${_protected}" ]; then
    echo "FATAL: refusing to DROP protected database '${TARGET_DB}'." >&2
    echo "       Use a disposable drill database name." >&2
    exit 4
  fi
done

if [[ ! "${MAX_RESTORE_SECONDS}" =~ ^[1-9][0-9]*$ ]]; then
  echo "FATAL: MAX_RESTORE_SECONDS must be a positive integer." >&2
  exit 4
fi
if [ "${MAX_RESTORE_SECONDS}" -gt 3600 ]; then
  echo "FATAL: MAX_RESTORE_SECONDS cannot exceed 3600 seconds." >&2
  exit 4
fi

if [ ! -f "${DATABASE_VERIFICATION_SQL}" ]; then
  echo "ERROR: generated verification SQL not found: ${DATABASE_VERIFICATION_SQL}" >&2
  exit 2
fi
if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not found on PATH." >&2
  exit 2
fi
if ! docker inspect "${TARGET_CONTAINER}" >/dev/null 2>&1; then
  echo "ERROR: target container '${TARGET_CONTAINER}' not found." >&2
  exit 2
fi
TARGET_ROLE=$(docker inspect \
  --format '{{ index .Config.Labels "com.aqua-saas.restore.role" }}' \
  "${TARGET_CONTAINER}")
COMPOSE_SERVICE=$(docker inspect \
  --format '{{ index .Config.Labels "com.docker.compose.service" }}' \
  "${TARGET_CONTAINER}")
if [ "${TARGET_ROLE}" != "${RESTORE_TARGET_ROLE}" ] || [ "${COMPOSE_SERVICE}" = 'postgres' ]; then
  echo "FATAL: target container lacks isolated restore attestation." >&2
  echo "       Required label: ${RESTORE_TARGET_LABEL}=${RESTORE_TARGET_ROLE}" >&2
  exit 4
fi

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

TMP=$(mktemp -d -t pg-restore-XXXX)
trap 'rm -rf "${TMP}"' EXIT
LOCAL_DUMP="${TMP}/$(basename "${BACKUP_KEY}")"
EXPECTED_DATABASE_PAYLOAD="${TMP}/expected-database-verification.json"
ACTUAL_DATABASE_PAYLOAD="${TMP}/actual-database-verification.json"
VERIFICATION_STDERR="${TMP}/database-verification.stderr"

log "Reading dump metadata for s3://${SPACES_BUCKET}/${BACKUP_KEY}"
HEAD_DUMP=$(aws s3api head-object \
  --bucket "${SPACES_BUCKET}" \
  --key "${BACKUP_KEY}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query '[ContentLength, Metadata.sha256, Metadata.verification_sha256, Metadata.verification_size, Metadata.verification_key]' \
  --output text)
read -r REMOTE_SIZE REMOTE_SHA256 REMOTE_VERIFICATION_SHA256 REMOTE_VERIFICATION_SIZE VERIFICATION_KEY <<< "${HEAD_DUMP}"

if [ -z "${REMOTE_SHA256:-}" ] || [ "${REMOTE_SHA256}" = "None" ] || \
   [ -z "${REMOTE_VERIFICATION_SHA256:-}" ] || [ "${REMOTE_VERIFICATION_SHA256}" = "None" ] || \
   [ -z "${VERIFICATION_KEY:-}" ] || [ "${VERIFICATION_KEY}" = "None" ]; then
  echo "ERROR: backup object is missing dump or verification binding metadata." >&2
  exit 5
fi
if [ "${VERIFICATION_KEY}" != "${BACKUP_KEY}.verification.json" ]; then
  echo "ERROR: verification key metadata does not match the canonical sidecar key." >&2
  exit 5
fi

log "Reading verification metadata for s3://${SPACES_BUCKET}/${VERIFICATION_KEY}"
HEAD_VERIFICATION=$(aws s3api head-object \
  --bucket "${SPACES_BUCKET}" \
  --key "${VERIFICATION_KEY}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --query '[ContentLength, Metadata.sha256, Metadata.dump_sha256]' \
  --output text)
read -r SIDE_SIZE SIDE_SHA256 SIDE_DUMP_SHA256 <<< "${HEAD_VERIFICATION}"

if [ "${SIDE_SIZE}" != "${REMOTE_VERIFICATION_SIZE}" ] || \
   [ "${SIDE_SHA256}" != "${REMOTE_VERIFICATION_SHA256}" ] || \
   [ "${SIDE_DUMP_SHA256}" != "${REMOTE_SHA256}" ]; then
  echo "ERROR: dump and verification sidecar metadata are not reciprocal." >&2
  exit 5
fi

log "Downloading dump and verification sidecar"
aws s3 cp "s3://${SPACES_BUCKET}/${BACKUP_KEY}" "${LOCAL_DUMP}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --only-show-errors
aws s3 cp "s3://${SPACES_BUCKET}/${VERIFICATION_KEY}" "${EXPECTED_DATABASE_PAYLOAD}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --only-show-errors

LOCAL_SIZE=$(stat -c '%s' "${LOCAL_DUMP}")
LOCAL_SHA256=$(sha256sum "${LOCAL_DUMP}" | awk '{print $1}')
LOCAL_VERIFICATION_SIZE=$(stat -c '%s' "${EXPECTED_DATABASE_PAYLOAD}")
LOCAL_VERIFICATION_SHA256=$(sha256sum "${EXPECTED_DATABASE_PAYLOAD}" | awk '{print $1}')

if [ "${LOCAL_SIZE}" != "${REMOTE_SIZE}" ] || [ "${LOCAL_SHA256}" != "${REMOTE_SHA256}" ]; then
  echo "ERROR: downloaded dump size or SHA-256 mismatch." >&2
  exit 5
fi
if [ "${LOCAL_VERIFICATION_SIZE}" != "${REMOTE_VERIFICATION_SIZE}" ] || \
   [ "${LOCAL_VERIFICATION_SHA256}" != "${REMOTE_VERIFICATION_SHA256}" ]; then
  echo "ERROR: downloaded verification sidecar size or SHA-256 mismatch." >&2
  exit 5
fi

if [[ "${LOCAL_DUMP}" == *.gpg ]]; then
  : "${BACKUP_GPG_KEY:?BACKUP_GPG_KEY required to decrypt .gpg archive}"
  if ! command -v gpg >/dev/null 2>&1; then
    echo "ERROR: gpg not found on PATH." >&2
    exit 2
  fi
  DECRYPTED="${LOCAL_DUMP%.gpg}"
  gpg --batch --yes --decrypt \
    --local-user "${BACKUP_GPG_KEY}" \
    --output "${DECRYPTED}" \
    "${LOCAL_DUMP}"
  LOCAL_DUMP="${DECRYPTED}"
fi

log "Dropping and recreating isolated database ${TARGET_DB}"
docker exec -i \
  -e "PGPASSWORD=${PGPASSWORD:-}" \
  "${TARGET_CONTAINER}" \
  dropdb --if-exists --force "${TARGET_DB}" \
    -U "${TARGET_USER}" \
    --maintenance-db=postgres
docker exec -i \
  -e "PGPASSWORD=${PGPASSWORD:-}" \
  "${TARGET_CONTAINER}" \
  createdb "${TARGET_DB}" \
    -U "${TARGET_USER}" \
    --maintenance-db=postgres

log "Preparing TimescaleDB restore mode"
printf '%s\n' \
  'CREATE EXTENSION IF NOT EXISTS timescaledb;' \
  'SELECT timescaledb_pre_restore();' | \
  docker exec -i \
    -e "PGPASSWORD=${PGPASSWORD:-}" \
    "${TARGET_CONTAINER}" \
    psql \
      -X \
      -qAt \
      -U "${TARGET_USER}" \
      -d "${TARGET_DB}" \
      -v ON_ERROR_STOP=1

log "Restoring archive into ${TARGET_DB}"
docker exec -i \
  -e "PGPASSWORD=${PGPASSWORD:-}" \
  "${TARGET_CONTAINER}" \
  pg_restore \
    -U "${TARGET_USER}" \
    -d "${TARGET_DB}" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    --verbose \
  < "${LOCAL_DUMP}"

log "Finalizing TimescaleDB restore mode"
printf '%s\n' 'SELECT timescaledb_post_restore();' | \
  docker exec -i \
    -e "PGPASSWORD=${PGPASSWORD:-}" \
    "${TARGET_CONTAINER}" \
    psql \
      -X \
      -qAt \
      -U "${TARGET_USER}" \
      -d "${TARGET_DB}" \
      -v ON_ERROR_STOP=1

log "Verifying restored schemas, migration heads, tenants, counts, and checksums"
if ! (
  printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
  sed -n '1,$p' "${DATABASE_VERIFICATION_SQL}"
  printf '\nCOMMIT;\n'
) | docker exec -i \
      -e "PGPASSWORD=${PGPASSWORD:-}" \
      "${TARGET_CONTAINER}" \
      psql \
        -X \
        -qAt \
        -U "${TARGET_USER}" \
        -d "${TARGET_DB}" \
        -v ON_ERROR_STOP=1 \
      > "${ACTUAL_DATABASE_PAYLOAD}" 2> "${VERIFICATION_STDERR}"; then
  if [ -s "${VERIFICATION_STDERR}" ]; then
    sed 's/^/  verification| /' "${VERIFICATION_STDERR}" >&2
  fi
  echo "ERROR: restored database failed structural verification." >&2
  exit 6
fi

if ! cmp -s "${EXPECTED_DATABASE_PAYLOAD}" "${ACTUAL_DATABASE_PAYLOAD}"; then
  EXPECTED_SHA=$(sha256sum "${EXPECTED_DATABASE_PAYLOAD}" | awk '{print $1}')
  ACTUAL_SHA=$(sha256sum "${ACTUAL_DATABASE_PAYLOAD}" | awk '{print $1}')
  echo "ERROR: restored database count/checksum evidence differs from the backup snapshot." >&2
  echo "  expected verification sha256: ${EXPECTED_SHA}" >&2
  echo "  actual verification sha256:   ${ACTUAL_SHA}" >&2
  exit 6
fi

RESTORE_ELAPSED_SECONDS=$(( $(date -u +%s) - RESTORE_STARTED_EPOCH ))
if [ "${RESTORE_ELAPSED_SECONDS}" -gt "${MAX_RESTORE_SECONDS}" ]; then
  echo "ERROR: verified restore exceeded RTO (${RESTORE_ELAPSED_SECONDS}s > ${MAX_RESTORE_SECONDS}s)." >&2
  exit 6
fi

VERIFIED_SHA256=$(sha256sum "${ACTUAL_DATABASE_PAYLOAD}" | awk '{print $1}')
log "RESTORE_VERIFIED database=${TARGET_DB} elapsed_seconds=${RESTORE_ELAPSED_SECONDS} verification_sha256=${VERIFIED_SHA256}"
log "Done"
