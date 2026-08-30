#!/usr/bin/env bash
# Narrow, secret-safe operator surface for WAL-G commands executed in a
# PostgreSQL container. Arbitrary WAL-G arguments are intentionally forbidden.

set -euo pipefail

source /usr/local/bin/walg-load-secrets.sh

require_safe_token() {
  local value=$1
  local label=$2
  if [[ ! "${value}" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    printf 'FATAL: invalid %s.\n' "${label}" >&2
    exit 126
  fi
}

require_backup_name() {
  require_safe_token "$1" 'backup name'
  if [[ ! "$1" =~ ^base_[A-Za-z0-9._:-]+$ ]]; then
    echo 'FATAL: backup name must be an explicit WAL-G base_* name.' >&2
    exit 126
  fi
}

assert_pgdata_boundary() {
  local pgdata=${PGDATA:?PGDATA required}
  local first_symlink

  if [ ! -d "${pgdata}" ] || [ -L "${pgdata}" ]; then
    echo 'FATAL: PGDATA must be a real directory.' >&2
    exit 126
  fi
  if [ -e "${pgdata}/wal-g-secrets" ] || [ -L "${pgdata}/wal-g-secrets" ]; then
    echo 'FATAL: WAL-G credential paths are forbidden beneath PGDATA.' >&2
    exit 126
  fi

  # This platform does not support external PostgreSQL tablespaces; the PITR
  # target rejects a non-empty tablespace_map as well. WAL-G v3.0.8 does not
  # preserve ordinary symlink targets, so any symlink would make the physical
  # backup unsafe to restore and must stop the ceremony before storage writes.
  first_symlink=$(find -P "${pgdata}" -xdev -type l -print -quit)
  if [ -n "${first_symlink}" ]; then
    echo 'FATAL: symlinks are forbidden in the canonical PGDATA backup boundary.' >&2
    exit 126
  fi
}

command_name=${1:-}
if [ "$#" -gt 0 ]; then
  shift
fi

case "${command_name}" in
  backup-list-json)
    [ "$#" -eq 0 ] || { echo 'FATAL: backup-list-json takes no arguments.' >&2; exit 126; }
    walg_exec backup-list --detail --json
    ;;
  backup-push-full)
    [ "$#" -eq 2 ] || { echo 'FATAL: backup-push-full requires run ID and main SHA.' >&2; exit 126; }
    require_safe_token "$1" 'evidence run ID'
    if [[ ! "$2" =~ ^[0-9a-f]{40}$ ]]; then
      echo 'FATAL: main SHA must be a lowercase 40-character Git SHA.' >&2
      exit 126
    fi
    assert_pgdata_boundary
    user_data=$(printf '{"aqua_run_id":"%s","main_sha":"%s","backup_kind":"full"}' "$1" "$2")
    walg_exec backup-push "${PGDATA:?PGDATA required}" --full --verify --add-user-data "${user_data}"
    ;;
  wal-verify)
    [ "$#" -eq 1 ] || { echo 'FATAL: wal-verify requires an explicit backup name.' >&2; exit 126; }
    require_backup_name "$1"
    case "$1" in
      LATEST|latest) echo 'FATAL: LATEST is forbidden; select an explicit backup name.' >&2; exit 126 ;;
    esac
    walg_exec wal-verify integrity timeline --backup-name "$1" --json
    ;;
  wal-verify-at-lsn)
    [ "$#" -eq 3 ] || { echo 'FATAL: wal-verify-at-lsn requires backup name, timeline, and LSN.' >&2; exit 126; }
    require_backup_name "$1"
    case "$1" in
      LATEST|latest) echo 'FATAL: LATEST is forbidden; select an explicit backup name.' >&2; exit 126 ;;
    esac
    if [[ ! "$2" =~ ^[1-9][0-9]{0,9}$ ]]; then
      echo 'FATAL: timeline must be a positive decimal integer.' >&2
      exit 126
    fi
    if [[ ! "$3" =~ ^[0-9A-F]+/[0-9A-F]{1,8}$ ]]; then
      echo 'FATAL: LSN must use canonical uppercase PostgreSQL notation.' >&2
      exit 126
    fi
    walg_exec wal-verify integrity timeline \
      --backup-name "$1" --timeline "$2" --lsn "$3" --json
    ;;
  backup-fetch)
    [ "$#" -eq 1 ] || { echo 'FATAL: backup-fetch requires one explicit backup name.' >&2; exit 126; }
    backup_name=$1
    require_backup_name "${backup_name}"
    case "${backup_name}" in
      LATEST|latest) echo 'FATAL: LATEST is forbidden; select an explicit backup name.' >&2; exit 126 ;;
    esac
    # PGDATA is empty during backup-fetch, so the normal symlink cannot exist.
    # The actual key remains available only from the tmpfs runtime directory.
    WALG_SECRET_DIR=$(_walg_runtime_dir)
    export WALG_SECRET_DIR
    walg_exec backup-fetch "${PGDATA:?PGDATA required}" "${backup_name}"
    assert_pgdata_boundary
    ;;
  assert-pgdata-boundary)
    [ "$#" -eq 0 ] || { echo 'FATAL: assert-pgdata-boundary takes no arguments.' >&2; exit 126; }
    assert_pgdata_boundary
    ;;
  assert-runtime)
    [ "$#" -eq 0 ] || { echo 'FATAL: assert-runtime takes no arguments.' >&2; exit 126; }
    walg_assert_runtime_secrets
    ;;
  *)
    echo 'FATAL: usage: walg-runtime-command.sh {backup-list-json|backup-push-full|wal-verify|wal-verify-at-lsn|backup-fetch|assert-pgdata-boundary|assert-runtime}' >&2
    exit 126
    ;;
esac
