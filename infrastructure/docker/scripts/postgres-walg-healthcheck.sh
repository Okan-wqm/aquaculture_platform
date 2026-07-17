#!/usr/bin/env bash
# Production PostgreSQL readiness plus continuous-archive freshness. A live SQL
# socket is insufficient: a stalled archive queue violates the five-minute RPO
# while the database can continue accepting writes.

set -euo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
POSTGRES_USER="${POSTGRES_USER:-aquaculture}"
POSTGRES_DB="${POSTGRES_DB:-aquaculture}"
MAX_RPO_SECONDS=300
MAX_WAL_DISK_PERCENT=90

die() {
  printf 'WAL-G healthcheck failed: %s\n' "$*" >&2
  exit 1
}

require_positive_seconds() {
  local variable_name=$1
  local value=${!variable_name:-}

  if [[ ! "${value}" =~ ^[1-9][0-9]*$ ]]; then
    die "${variable_name} must be a positive integer number of seconds"
  fi
}

for budget_name in \
  WALG_RPO_BUDGET_SECONDS \
  WALG_ARCHIVE_SWITCH_BUDGET_SECONDS \
  WALG_WAL_PUSH_BUDGET_SECONDS \
  WALG_HEALTH_DETECTION_BUDGET_SECONDS; do
  require_positive_seconds "${budget_name}"
  if [ "${!budget_name}" -gt "${MAX_RPO_SECONDS}" ]; then
    die "${budget_name} exceeds ${MAX_RPO_SECONDS}s"
  fi
done
ALLOCATED_RPO_SECONDS=$((
  WALG_ARCHIVE_SWITCH_BUDGET_SECONDS +
  WALG_WAL_PUSH_BUDGET_SECONDS +
  WALG_HEALTH_DETECTION_BUDGET_SECONDS
))
if [ "${ALLOCATED_RPO_SECONDS}" -ne "${WALG_RPO_BUDGET_SECONDS}" ]; then
  die "WAL switch, upload, and detection allocations must equal the RPO budget"
fi
MAX_READY_AGE_SECONDS=${WALG_WAL_PUSH_BUDGET_SECONDS}

for required_command in date df find pg_isready psql stat; do
  command -v "${required_command}" >/dev/null 2>&1 || die "${required_command} is unavailable"
done
for required_config in WALG_BACKUP_EPOCH WALG_S3_PREFIX WALG_S3_ENDPOINT WALG_S3_REGION; do
  [ -n "${!required_config:-}" ] || die "${required_config} is empty"
done
if [[ ! "${WALG_BACKUP_EPOCH}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || \
   [[ ! "${WALG_S3_PREFIX}" =~ ^s3://[A-Za-z0-9._-]+/postgres/wal-g/[a-z0-9][a-z0-9-]{0,63}$ ]] || \
   [ "${WALG_S3_PREFIX##*/}" != "${WALG_BACKUP_EPOCH}" ]; then
  die 'WAL-G archive prefix is not canonically bound to its backup epoch'
fi

pg_isready -q -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" || die 'PostgreSQL is not ready'
/usr/local/bin/walg-load-secrets.sh assert-runtime >/dev/null || die 'runtime secrets are invalid'

ARCHIVER_HEALTH=$(PGPASSWORD="${POSTGRES_PASSWORD:-}" \
  psql -X -qAt \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    -v ON_ERROR_STOP=1 \
    -c "
      SELECT CASE
        WHEN current_setting('archive_mode') <> 'on' THEN 'f'
        WHEN current_setting('archive_command') <> '/usr/local/bin/walg-archive-command.sh %p %f' THEN 'f'
        WHEN EXTRACT(EPOCH FROM current_setting('archive_timeout')::interval)::integer
          <> ${WALG_ARCHIVE_SWITCH_BUDGET_SECONDS} THEN 'f'
        WHEN failed_count > 0
          AND (last_archived_time IS NULL OR last_failed_time > last_archived_time) THEN 'f'
        ELSE 't'
      END
      FROM pg_stat_archiver;")
if [ "${ARCHIVER_HEALTH}" != 't' ]; then
  die 'archive settings are unsafe or the newest archive attempt failed'
fi

ARCHIVE_STATUS_DIR="${PGDATA}/pg_wal/archive_status"
[ -d "${ARCHIVE_STATUS_DIR}" ] || die 'archive_status directory is missing'
NOW_EPOCH=$(date -u +%s)
OLDEST_READY_EPOCH=''
while IFS= read -r -d '' ready_path; do
  ready_epoch=$(stat -c '%Y' "${ready_path}")
  if [ -z "${OLDEST_READY_EPOCH}" ] || [ "${ready_epoch}" -lt "${OLDEST_READY_EPOCH}" ]; then
    OLDEST_READY_EPOCH=${ready_epoch}
  fi
done < <(find "${ARCHIVE_STATUS_DIR}" -maxdepth 1 -type f -name '*.ready' -print0)
if [ -n "${OLDEST_READY_EPOCH}" ]; then
  READY_AGE_SECONDS=$(( NOW_EPOCH - OLDEST_READY_EPOCH ))
  if [ "${READY_AGE_SECONDS}" -gt "${MAX_READY_AGE_SECONDS}" ]; then
    die "oldest unarchived WAL is ${READY_AGE_SECONDS}s old (limit ${MAX_READY_AGE_SECONDS}s)"
  fi
fi

WAL_DISK_PERCENT=$(df -P "${PGDATA}/pg_wal" | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
if [[ ! "${WAL_DISK_PERCENT}" =~ ^[0-9]+$ ]]; then
  die 'could not determine pg_wal filesystem utilization'
fi
if [ "${WAL_DISK_PERCENT}" -ge "${MAX_WAL_DISK_PERCENT}" ]; then
  die "pg_wal filesystem utilization is ${WAL_DISK_PERCENT}% (limit ${MAX_WAL_DISK_PERCENT}%)"
fi
