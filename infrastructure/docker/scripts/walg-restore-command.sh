#!/usr/bin/env bash
# PostgreSQL restore_command wrapper: walg-restore-command.sh %f %p

set -euo pipefail

source /usr/local/bin/walg-load-secrets.sh

if [ "$#" -ne 2 ]; then
  echo 'FATAL: restore wrapper requires WAL filename and destination path.' >&2
  exit 126
fi

wal_name=$1
destination=$2
if [[ ! "${wal_name}" =~ ^([0-9A-F]{24}(\.[0-9A-F]{8}\.backup|\.partial)?|[0-9A-F]{8}\.history)$ ]]; then
  echo 'FATAL: requested WAL filename has an invalid PostgreSQL archive form.' >&2
  exit 126
fi
if [ -z "${destination}" ] || [ "${destination#-}" != "${destination}" ] || \
   [ "${wal_name}" != "$(basename "${wal_name}")" ]; then
  echo 'FATAL: invalid WAL fetch arguments.' >&2
  exit 126
fi

if walg_exec wal-fetch "${wal_name}" "${destination}"; then
  exit 0
else
  status=$?
fi
if [ "${status}" -eq 74 ]; then
  # WAL-G reserves EX_IOERR (74) for a segment that does not exist. PostgreSQL
  # depends on this exact status while probing timelines during recovery.
  exit 74
fi
if [ "${status}" -lt 126 ]; then
  exit 126
fi
exit "${status}"
