#!/usr/bin/env bash
# PostgreSQL archive_command wrapper: walg-archive-command.sh %p %f

set -euo pipefail

source /usr/local/bin/walg-load-secrets.sh

MAX_RPO_SECONDS=300
WALG_WAL_PUSH_TERM_GRACE_SECONDS=1

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 126
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
if [ "${WALG_WAL_PUSH_BUDGET_SECONDS}" -le "${WALG_WAL_PUSH_TERM_GRACE_SECONDS}" ]; then
  die 'WAL push budget must exceed its termination grace'
fi

# timeout(1) cannot invoke a shell function directly. Re-enter this immutable
# wrapper as a child process so timeout owns the full WAL-G process group and a
# hung uploader cannot survive its allocation. The TERM grace is subtracted
# from the soft deadline, keeping TERM plus KILL inside the declared budget.
if [ "$#" -eq 2 ] && [ "$1" = '__aqua_bounded_wal_push' ]; then
  wal_path=$2
  walg_exec wal-push "${wal_path}"
  exit $?
fi

if [ "$#" -ne 2 ]; then
  echo 'FATAL: archive wrapper requires WAL path and WAL filename.' >&2
  exit 126
fi

wal_path=$1
wal_name=$2
if [[ ! "${wal_name}" =~ ^([0-9A-F]{24}(\.[0-9A-F]{8}\.backup|\.partial)?|[0-9A-F]{8}\.history)$ ]]; then
  echo 'FATAL: archive WAL filename has an invalid PostgreSQL archive form.' >&2
  exit 126
fi
if [ ! -f "${wal_path}" ] || [ -L "${wal_path}" ]; then
  echo 'FATAL: archive source is not a regular WAL file.' >&2
  exit 126
fi
if [ "${wal_name}" != "$(basename "${wal_name}")" ] || [ "$(basename "${wal_path}")" != "${wal_name}" ]; then
  echo 'FATAL: archive WAL filename does not match its source path.' >&2
  exit 126
fi

for required_command in readlink timeout; do
  command -v "${required_command}" >/dev/null 2>&1 || die "${required_command} is unavailable"
done
archive_wrapper_path=$(readlink -f "${BASH_SOURCE[0]}")
wal_push_soft_timeout_seconds=$((
  WALG_WAL_PUSH_BUDGET_SECONDS - WALG_WAL_PUSH_TERM_GRACE_SECONDS
))
if timeout \
  --signal=TERM \
  --kill-after="${WALG_WAL_PUSH_TERM_GRACE_SECONDS}s" \
  "${wal_push_soft_timeout_seconds}s" \
  "${archive_wrapper_path}" __aqua_bounded_wal_push "${wal_path}"; then
  exit 0
else
  status=$?
fi
# timeout reports 124 after TERM and 137 after the bounded KILL fallback.
# Normalize both to EX_TEMPFAIL so PostgreSQL records a retryable archive
# failure while the .ready file remains observable to the healthcheck.
if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
  status=75
fi
# PostgreSQL retries ordinary non-zero archive_command statuses and records
# them in pg_stat_archiver. Statuses above 125 abort/restart the archiver and
# are intentionally reserved for this wrapper's execution/config errors.
exit "${status}"
