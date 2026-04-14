#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# backup-databases.sh — nightly PostgreSQL backup → DigitalOcean Spaces
#
# Closes: docs/reviews/infra-expert/2026-04-14-infrastructure-hardening.md#INFRA-BACKUP-001
#
# Runs against the droplet's local PostgreSQL container via `docker exec`.
# Produces a `pg_dump --format=custom` archive (binary, compressed, parallel-
# restorable), optionally GPG-encrypts it, and uploads to a DigitalOcean Spaces
# bucket. Retention is enforced by the bucket's lifecycle policy — this script
# does not delete remote objects.
#
# Intended callers:
#   1. GitHub Actions workflow `.github/workflows/backup-production.yml`
#      (SSHes into the droplet, exports env vars, invokes this script).
#   2. Operator on-call (`sudo bash backup-databases.sh` after setting env).
#
# Environment contract (required unless default shown):
#   POSTGRES_CONTAINER    Docker container name              [default: aqua-postgres]
#   POSTGRES_USER         Superuser for the dump             [default: aquaculture]
#   POSTGRES_DB           Database name                       [default: aquaculture]
#   SPACES_BUCKET         DO Spaces bucket (no s3:// prefix)  [required]
#   SPACES_ENDPOINT       Spaces region endpoint              [default: https://fra1.digitaloceanspaces.com]
#   AWS_ACCESS_KEY_ID     Spaces access key                   [required]
#   AWS_SECRET_ACCESS_KEY Spaces secret key                   [required]
#   BACKUP_PREFIX         Key prefix inside the bucket        [default: pg-backups]
#   BACKUP_GPG_RECIPIENT  GPG recipient for encryption        [optional; skip if unset]
#   MIN_DUMP_BYTES        Abort if dump is smaller            [default: 10000]
# -----------------------------------------------------------------------------

set -euo pipefail

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-aqua-postgres}"
POSTGRES_USER="${POSTGRES_USER:-aquaculture}"
POSTGRES_DB="${POSTGRES_DB:-aquaculture}"
SPACES_ENDPOINT="${SPACES_ENDPOINT:-https://fra1.digitaloceanspaces.com}"
BACKUP_PREFIX="${BACKUP_PREFIX:-pg-backups}"
BACKUP_GPG_RECIPIENT="${BACKUP_GPG_RECIPIENT:-}"
MIN_DUMP_BYTES="${MIN_DUMP_BYTES:-10000}"

: "${SPACES_BUCKET:?SPACES_BUCKET required}"
: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required}"

if ! command -v aws >/dev/null 2>&1; then
  echo "ERROR: aws CLI not found on PATH. Install awscli v2." >&2
  exit 2
fi

if ! docker inspect "${POSTGRES_CONTAINER}" >/dev/null 2>&1; then
  echo "ERROR: docker container '${POSTGRES_CONTAINER}' not found or docker daemon unreachable." >&2
  exit 2
fi

log() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP_NAME="${POSTGRES_DB}-${TIMESTAMP}.dump"
DUMP_DIR=$(mktemp -d -t pg-backup-XXXX)
trap 'rm -rf "${DUMP_DIR}"' EXIT
DUMP_PATH="${DUMP_DIR}/${DUMP_NAME}"

log "Starting pg_dump of ${POSTGRES_DB} via ${POSTGRES_CONTAINER} (custom format, compression 6)"

# --format=custom: binary, compressed, parallel-restorable
# --no-owner / --no-privileges: dump is restorable into any role layout,
#   which is what the drill runbook depends on.
docker exec -i "${POSTGRES_CONTAINER}" \
  pg_dump \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    --format=custom \
    --compress=6 \
    --no-owner \
    --no-privileges \
  > "${DUMP_PATH}" 2> "${DUMP_PATH}.stderr"

DUMP_SIZE=$(stat -c '%s' "${DUMP_PATH}")
log "pg_dump produced ${DUMP_SIZE} bytes"

# Surface pg_dump stderr unconditionally. TimescaleDB compressed chunks and
# extension-owned objects produce WARN lines that do not fail the dump but
# DO indicate incomplete backups; silently discarding them on the success
# path hides that class of issue. Prefix each line so the job log stays
# grep-friendly.
if [ -s "${DUMP_PATH}.stderr" ]; then
  log "pg_dump stderr (non-empty — review for WARN/NOTICE about skipped objects):"
  sed 's/^/  pg_dump| /' "${DUMP_PATH}.stderr"
fi

if [ "${DUMP_SIZE}" -lt "${MIN_DUMP_BYTES}" ]; then
  echo "ERROR: dump is suspiciously small (${DUMP_SIZE} < ${MIN_DUMP_BYTES} bytes)." >&2
  exit 3
fi

UPLOAD_PATH="${DUMP_PATH}"

if [ -n "${BACKUP_GPG_RECIPIENT}" ]; then
  if ! command -v gpg >/dev/null 2>&1; then
    echo "ERROR: BACKUP_GPG_RECIPIENT set but gpg not found on PATH." >&2
    exit 2
  fi
  log "Encrypting dump for GPG recipient ${BACKUP_GPG_RECIPIENT}"
  gpg --batch --yes --trust-model always --encrypt \
    --recipient "${BACKUP_GPG_RECIPIENT}" \
    --output "${DUMP_PATH}.gpg" \
    "${DUMP_PATH}"
  UPLOAD_PATH="${DUMP_PATH}.gpg"
fi

REMOTE_KEY="${BACKUP_PREFIX}/$(date -u +%Y/%m/%d)/$(basename "${UPLOAD_PATH}")"
log "Uploading to s3://${SPACES_BUCKET}/${REMOTE_KEY}"

aws s3 cp "${UPLOAD_PATH}" "s3://${SPACES_BUCKET}/${REMOTE_KEY}" \
  --endpoint-url "${SPACES_ENDPOINT}" \
  --only-show-errors \
  --sse AES256 \
  --metadata "source=${POSTGRES_CONTAINER},db=${POSTGRES_DB},sha256=$(sha256sum "${UPLOAD_PATH}" | cut -d' ' -f1)"

log "Backup complete: size=${DUMP_SIZE} key=s3://${SPACES_BUCKET}/${REMOTE_KEY}"
