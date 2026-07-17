#!/usr/bin/env bash
# Secure WAL-G credential loader and boot-time installer.
#
# Secret bytes are copied from the read-only host bind directly into a tmpfs
# directory outside PGDATA. No file or symlink beneath PGDATA participates in
# credential resolution: WAL-G v3.0.8's PostgreSQL tar interpreter does not
# preserve arbitrary symlink targets across backup-push/backup-fetch.

set +x

if [ -z "${BASH_VERSION:-}" ]; then
  echo "FATAL: walg-load-secrets.sh requires bash." >&2
  exit 126
fi

set -euo pipefail
# This file is a credential boundary. A caller may source it after enabling
# xtrace, so tracing is disabled globally and again at every secret-reading
# entry point before any credential byte is expanded.

_walg_die() {
  printf 'FATAL: %s\n' "$*" >&2
  return 126
}

_walg_pgdata() {
  printf '%s' "${PGDATA:-/var/lib/postgresql/data}"
}

_walg_runtime_dir() {
  printf '%s' "${WALG_SECRET_RUNTIME_DIR:-/run/aqua-walg-secrets}"
}

_walg_logical_dir() {
  printf '%s' "${WALG_SECRET_DIR:-$(_walg_runtime_dir)}"
}

_walg_lock_file() {
  printf '%s' "${WALG_SECRET_LOCK_FILE:-/run/aqua-walg-secrets.lock}"
}

_walg_require_directory_no_symlink_ancestors() {
  local directory_path=$1
  local current_path=''
  local component
  local -a components

  if [[ "${directory_path}" != /* ]] || [ "${directory_path}" = '/' ] || \
     [[ "${directory_path}" == *$'\n'* ]] || [[ "${directory_path}" == *$'\r'* ]] || \
     [[ "${directory_path}" == *'//'* ]] || [[ "${directory_path}" == */ ]]; then
    _walg_die "WAL-G directory path must be canonical, absolute, and non-root: ${directory_path}"
    return
  fi

  IFS='/' read -r -a components <<< "${directory_path#/}"
  for component in "${components[@]}"; do
    if [ -z "${component}" ] || [ "${component}" = '.' ] || [ "${component}" = '..' ]; then
      _walg_die "WAL-G directory path contains an unsafe component: ${directory_path}"
      return
    fi
    current_path="${current_path}/${component}"
    if [ -L "${current_path}" ] || [ ! -d "${current_path}" ]; then
      _walg_die "WAL-G directory path has a missing or symlinked ancestor: ${current_path}"
      return
    fi
  done
}

_walg_require_safe_lock_file() {
  local lock_path=$1
  local lock_parent=${lock_path%/*}
  local lock_mode

  if [ -z "${lock_parent}" ] || [ "${lock_parent}" = "${lock_path}" ]; then
    _walg_die "WAL-G lock path must be absolute"
    return
  fi
  _walg_require_directory_no_symlink_ancestors "${lock_parent}" || return
  if [ ! -f "${lock_path}" ] || [ -L "${lock_path}" ]; then
    _walg_die "WAL-G lock must be a regular non-symlink file: ${lock_path}"
    return
  fi
  lock_mode=$(stat -c '%a' "${lock_path}") || return 126
  case "${lock_mode}" in
    400|600) ;;
    *)
      _walg_die "WAL-G lock must have mode 0400 or 0600: ${lock_path}"
      return
      ;;
  esac
}

_walg_require_regular_file() {
  local file_path=$1
  local expected_size=${2:-}
  local actual_size
  local file_mode

  if [ ! -f "${file_path}" ] || [ -L "${file_path}" ]; then
    _walg_die "required WAL-G credential file is not a regular file: ${file_path}"
    return
  fi

  file_mode=$(stat -c '%a' "${file_path}") || return 126
  case "${file_mode}" in
    400|600) ;;
    *)
      _walg_die "WAL-G credential file must have mode 0400 or 0600: ${file_path}"
      return
      ;;
  esac

  actual_size=$(stat -c '%s' "${file_path}") || return 126
  if [ -n "${expected_size}" ]; then
    if [ "${actual_size}" -ne "${expected_size}" ]; then
      _walg_die "WAL-G libsodium key must contain exactly ${expected_size} bytes"
      return
    fi
  elif [ "${actual_size}" -lt 1 ] || [ "${actual_size}" -gt 4096 ]; then
    _walg_die "WAL-G credential length is outside the accepted range: ${file_path}"
    return
  fi
}

_walg_validate_manifest_entries() {
  local manifest_path=$1
  local manifest_line=''
  local manifest_entry
  local entry_pattern='^([0-9a-f]{64})  (aws_access_key_id|aws_secret_access_key|libsodium[.]key|walg_backup_epoch|walg_s3_prefix)$'
  local access_key_entries=0
  local secret_key_entries=0
  local libsodium_key_entries=0
  local backup_epoch_entries=0
  local s3_prefix_entries=0
  local entry_count=0

  while IFS= read -r manifest_line || [ -n "${manifest_line}" ]; do
    if [[ ! "${manifest_line}" =~ ${entry_pattern} ]]; then
      _walg_die 'WAL-G credential manifest contains an invalid entry'
      return
    fi
    manifest_entry=${BASH_REMATCH[2]}
    entry_count=$((entry_count + 1))
    case "${manifest_entry}" in
      aws_access_key_id)
        access_key_entries=$((access_key_entries + 1))
        ;;
      aws_secret_access_key)
        secret_key_entries=$((secret_key_entries + 1))
        ;;
      libsodium.key)
        libsodium_key_entries=$((libsodium_key_entries + 1))
        ;;
      walg_backup_epoch)
        backup_epoch_entries=$((backup_epoch_entries + 1))
        ;;
      walg_s3_prefix)
        s3_prefix_entries=$((s3_prefix_entries + 1))
        ;;
    esac
  done < "${manifest_path}"

  if [ "${entry_count}" -ne 5 ] || \
     [ "${access_key_entries}" -ne 1 ] || \
     [ "${secret_key_entries}" -ne 1 ] || \
     [ "${libsodium_key_entries}" -ne 1 ] || \
     [ "${backup_epoch_entries}" -ne 1 ] || \
     [ "${s3_prefix_entries}" -ne 1 ]; then
    _walg_die 'WAL-G credential manifest must contain each canonical credential exactly once'
    return
  fi
}

_walg_validate_bundle_entries() {
  local secret_dir=$1
  local bundle_kind=${2:-runtime}
  local entry
  local entry_count=0
  local entry_name
  local expected_count=6

  _walg_require_directory_no_symlink_ancestors "${secret_dir}" || return
  if [ "${bundle_kind}" = 'source' ]; then
    expected_count=7
  elif [ "${bundle_kind}" != 'runtime' ]; then
    _walg_die "unknown WAL-G bundle kind: ${bundle_kind}"
    return
  fi

  while IFS= read -r -d '' entry; do
    entry_name=${entry##*/}
    case "${entry_name}" in
      aws_access_key_id|aws_secret_access_key|libsodium.key|walg_backup_epoch|walg_s3_prefix|manifest.sha256) ;;
      .lock)
        if [ "${bundle_kind}" != 'source' ]; then
          _walg_die "WAL-G runtime bundle contains a source lock entry"
          return
        fi
        ;;
      *)
        _walg_die "WAL-G bundle contains an unexpected entry: ${entry_name}"
        return
        ;;
    esac
    if [ -L "${entry}" ] || [ ! -f "${entry}" ]; then
      _walg_die "WAL-G bundle contains an unsafe entry: ${entry_name}"
      return
    fi
    entry_count=$((entry_count + 1))
  done < <(find "${secret_dir}" -mindepth 1 -maxdepth 1 -print0)

  if [ "${entry_count}" -ne "${expected_count}" ]; then
    _walg_die "WAL-G bundle does not contain the exact canonical entry set"
    return
  fi
}

_walg_validate_bundle() {
  set +x
  local secret_dir=$1
  local bundle_kind=${2:-runtime}
  local manifest_path="${secret_dir}/manifest.sha256"
  local backup_epoch
  local credential_size
  local stripped_size
  local libsodium_key_b64
  local decoded_key_size
  local expected_backup_epoch=${WALG_BACKUP_EPOCH:-}
  local expected_s3_prefix=${WALG_S3_PREFIX:-}
  local s3_prefix

  _walg_validate_bundle_entries "${secret_dir}" "${bundle_kind}" || return

  _walg_require_regular_file "${secret_dir}/aws_access_key_id" || return
  _walg_require_regular_file "${secret_dir}/aws_secret_access_key" || return
  _walg_require_regular_file "${secret_dir}/libsodium.key" 44 || return
  _walg_require_regular_file "${secret_dir}/walg_backup_epoch" || return
  _walg_require_regular_file "${secret_dir}/walg_s3_prefix" || return
  _walg_require_regular_file "${manifest_path}" || return
  _walg_validate_manifest_entries "${manifest_path}" || return

  if ! (
    cd "${secret_dir}" &&
      sha256sum --strict --status -c manifest.sha256
  ); then
    _walg_die "WAL-G credential manifest verification failed"
    return
  fi

  for credential_file in aws_access_key_id aws_secret_access_key; do
    credential_size=$(stat -c '%s' "${secret_dir}/${credential_file}") || return 126
    stripped_size=$(LC_ALL=C tr -d '\r\n' < "${secret_dir}/${credential_file}" | wc -c)
    if [ "${credential_size}" -ne "${stripped_size}" ]; then
      _walg_die "WAL-G text credentials must be single-line values without line terminators"
      return
    fi
  done

  libsodium_key_b64=$(< "${secret_dir}/libsodium.key")
  if [[ ! "${libsodium_key_b64}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
    _walg_die "WAL-G libsodium key file must contain canonical base64 text"
    return
  fi
  if ! decoded_key_size=$(printf '%s' "${libsodium_key_b64}" | base64 --decode | wc -c); then
    _walg_die "WAL-G libsodium key file is not valid base64"
    return
  fi
  if [ "${decoded_key_size}" -ne 32 ]; then
    _walg_die "WAL-G libsodium key must decode to exactly 32 bytes"
    return
  fi
  backup_epoch=$(< "${secret_dir}/walg_backup_epoch")
  s3_prefix=$(< "${secret_dir}/walg_s3_prefix")
  if [[ ! "${backup_epoch}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; then
    _walg_die "WAL-G backup epoch is not canonical"
    return
  fi
  if [[ ! "${s3_prefix}" =~ ^s3://[A-Za-z0-9._-]+/postgres/wal-g/[a-z0-9][a-z0-9-]{0,63}$ ]] || \
     [ "${s3_prefix##*/}" != "${backup_epoch}" ]; then
    _walg_die "WAL-G archive prefix is not bound to its backup epoch"
    return
  fi
  if [ -z "${expected_backup_epoch}" ] || [ -z "${expected_s3_prefix}" ] || \
     [ "${backup_epoch}" != "${expected_backup_epoch}" ] || \
     [ "${s3_prefix}" != "${expected_s3_prefix}" ]; then
    _walg_die "WAL-G bundle epoch/prefix differs from the container configuration"
    return
  fi
  unset libsodium_key_b64
  unset backup_epoch s3_prefix expected_backup_epoch expected_s3_prefix
}

_walg_resolve_secret_dir() {
  local logical_dir
  local runtime_dir

  logical_dir=$(_walg_logical_dir)
  runtime_dir=$(_walg_runtime_dir)

  if [ "${logical_dir}" != "${runtime_dir}" ]; then
    _walg_die "WALG_SECRET_DIR must resolve directly to the WAL-G tmpfs runtime directory"
    return
  fi
  printf '%s' "${runtime_dir}"
}

walg_assert_runtime_secrets() {
  set +x
  local secret_dir
  local lock_file
  local lock_fd
  local status=0

  if ! command -v flock >/dev/null 2>&1; then
    _walg_die "flock is required to verify WAL-G credentials"
    return
  fi

  lock_file=$(_walg_lock_file)
  _walg_require_safe_lock_file "${lock_file}" || return
  exec {lock_fd}>> "${lock_file}" || return 126
  flock -s "${lock_fd}" || status=126
  if [ "${status}" -eq 0 ]; then
    secret_dir=$(_walg_resolve_secret_dir) || status=$?
  fi
  if [ "${status}" -eq 0 ]; then
    _walg_validate_bundle "${secret_dir}" || status=$?
  fi
  flock -u "${lock_fd}" || status=126
  exec {lock_fd}>&- || status=126
  return "${status}"
}

walg_exec() {
  local secret_dir
  local access_key
  local secret_key
  local database_user
  local database_name
  local status
  local had_xtrace=false
  local lock_file

  case $- in
    *x*)
      had_xtrace=true
      set +x
      ;;
  esac

  if [ "$#" -lt 1 ]; then
    _walg_die "walg_exec requires a WAL-G command"
    return
  fi
  for config_name in WALG_BACKUP_EPOCH WALG_S3_PREFIX WALG_S3_ENDPOINT WALG_S3_REGION; do
    if [ -z "${!config_name:-}" ]; then
      _walg_die "${config_name} is required"
      return
    fi
  done
  database_user=${PGUSER:-${POSTGRES_USER:-}}
  database_name=${PGDATABASE:-${POSTGRES_DB:-}}
  if [[ ! "${database_user}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || \
     [[ ! "${database_name}" =~ ^[a-z][a-z0-9_]{0,62}$ ]]; then
    _walg_die "POSTGRES_USER/POSTGRES_DB must provide safe WAL-G database identity"
    return
  fi

  if ! command -v flock >/dev/null 2>&1; then
    _walg_die "flock is required to protect atomic WAL-G credential rotation"
    return
  fi
  if ! command -v "${WALG_BIN:-wal-g}" >/dev/null 2>&1; then
    _walg_die "WAL-G executable not found"
    return
  fi

  lock_file=$(_walg_lock_file)
  _walg_require_safe_lock_file "${lock_file}" || return
  exec 9>> "${lock_file}" || return 126
  flock -s 9 || return 126
  secret_dir=$(_walg_resolve_secret_dir) || return
  _walg_validate_bundle "${secret_dir}" || return

  access_key=$(< "${secret_dir}/aws_access_key_id")
  secret_key=$(< "${secret_dir}/aws_secret_access_key")

  if env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=/var/lib/postgresql \
    LC_ALL=C \
    LANG=C \
    AWS_ACCESS_KEY_ID="${access_key}" \
    AWS_SECRET_ACCESS_KEY="${secret_key}" \
    AWS_ENDPOINT="${WALG_S3_ENDPOINT}" \
    AWS_REGION="${WALG_S3_REGION}" \
    AWS_DEFAULT_REGION="${WALG_S3_REGION}" \
    WALG_S3_PREFIX="${WALG_S3_PREFIX}" \
    WALG_LIBSODIUM_KEY_PATH="${secret_dir}/libsodium.key" \
    WALG_LIBSODIUM_KEY_TRANSFORM=base64 \
    WALG_PREVENT_WAL_OVERWRITE=true \
    WALG_COMPRESSION_METHOD=lz4 \
    WALG_DELTA_MAX_STEPS=0 \
    PGUSER="${database_user}" \
    PGDATABASE="${database_name}" \
    "${WALG_BIN:-wal-g}" "$@"; then
    status=0
  else
    status=$?
  fi

  unset access_key secret_key database_user database_name
  flock -u 9 || status=126
  exec 9>&-
  if [ "${had_xtrace}" = true ]; then
    set -x
  fi
  return "${status}"
}

_walg_remove_install_stage() {
  local stage_path=$1
  local postgres_uid=$2
  local entry
  local entry_name
  local entry_uid

  if [ -L "${stage_path}" ] || [ ! -d "${stage_path}" ] || \
     [ "$(stat -c '%u' "${stage_path}")" -ne "$(id -u)" ]; then
    _walg_die "WAL-G runtime install residue is unsafe: ${stage_path}"
    return
  fi
  while IFS= read -r -d '' entry; do
    entry_name=${entry##*/}
    case "${entry_name}" in
      aws_access_key_id|aws_secret_access_key|libsodium.key|walg_backup_epoch|walg_s3_prefix|manifest.sha256) ;;
      *)
        _walg_die "WAL-G runtime install residue contains an unexpected entry: ${entry_name}"
        return
        ;;
    esac
    entry_uid=$(stat -c '%u' "${entry}") || return 126
    if [ -L "${entry}" ] || [ ! -f "${entry}" ] || \
       { [ "${entry_uid}" -ne "${postgres_uid}" ] && \
         [ "${entry_uid}" -ne "$(id -u)" ]; }; then
      _walg_die "WAL-G runtime install residue contains an unsafe entry: ${entry_name}"
      return
    fi
  done < <(find "${stage_path}" -mindepth 1 -maxdepth 1 -print0)

  find "${stage_path}" -mindepth 1 -maxdepth 1 -type f -delete
  rmdir -- "${stage_path}"
}

_walg_recover_runtime_residue() {
  local runtime_dir=$1
  local postgres_uid=$2
  local entry
  local entry_name

  while IFS= read -r -d '' entry; do
    entry_name=${entry##*/}
    case "${entry_name}" in
      aws_access_key_id|aws_secret_access_key|libsodium.key|walg_backup_epoch|walg_s3_prefix|manifest.sha256)
        if [ -L "${entry}" ] || [ ! -f "${entry}" ]; then
          _walg_die "WAL-G runtime bundle contains an unsafe canonical entry: ${entry_name}"
          return
        fi
        ;;
      .install.??????)
        if [[ ! "${entry_name}" =~ ^\.install\.[A-Za-z0-9]{6}$ ]]; then
          _walg_die "WAL-G runtime bundle contains unsafe install residue: ${entry_name}"
          return
        fi
        _walg_remove_install_stage "${entry}" "${postgres_uid}" || return
        ;;
      *)
        _walg_die "WAL-G runtime bundle contains an unexpected entry: ${entry_name}"
        return
        ;;
    esac
  done < <(find "${runtime_dir}" -mindepth 1 -maxdepth 1 -print0)
}

_walg_install_runtime_secrets() {
  set +x
  local source_dir=${WALG_SECRET_SOURCE_DIR:-/var/lib/postgresql/wal-g-secrets-source}
  local runtime_dir
  local logical_dir
  local pgdata
  local source_lock
  local runtime_lock
  local stage_dir
  local legacy_logical_dir
  local legacy_link_target
  local postgres_uid
  local postgres_gid
  local runtime_filesystem
  local runtime_parent

  runtime_dir=$(_walg_runtime_dir)
  logical_dir=$(_walg_logical_dir)
  pgdata=$(_walg_pgdata)
  legacy_logical_dir="${pgdata}/wal-g-secrets"
  source_lock="${source_dir}/.lock"
  runtime_lock=$(_walg_lock_file)

  if [ "${logical_dir}" != "${runtime_dir}" ]; then
    _walg_die "WALG_SECRET_DIR must resolve directly to the WAL-G tmpfs runtime directory"
    return
  fi
  if [ "${runtime_dir}" != '/run/aqua-walg-secrets' ]; then
    _walg_die "WAL-G runtime secrets must be installed at /run/aqua-walg-secrets"
    return
  fi
  if [ ! -d "${pgdata}" ] || [ -L "${pgdata}" ]; then
    _walg_die "PGDATA must be a real directory before WAL-G credential installation"
    return
  fi
  _walg_require_directory_no_symlink_ancestors "${pgdata}" || return
  _walg_require_directory_no_symlink_ancestors "${source_dir}" || return
  _walg_require_safe_lock_file "${source_lock}" || return
  if ! command -v flock >/dev/null 2>&1; then
    _walg_die "flock is required to install WAL-G credentials"
    return
  fi

  exec 8< "${source_lock}" || return 126
  flock -s 8 || return 126
  _walg_validate_bundle "${source_dir}" source || return

  runtime_parent=${runtime_dir%/*}
  _walg_require_directory_no_symlink_ancestors "${runtime_parent}" || return
  if [ -L "${runtime_dir}" ] || { [ -e "${runtime_dir}" ] && [ ! -d "${runtime_dir}" ]; }; then
    _walg_die "WAL-G runtime credential directory is unsafe"
    return
  fi
  if [ ! -d "${runtime_dir}" ]; then
    mkdir -- "${runtime_dir}"
  fi
  _walg_require_directory_no_symlink_ancestors "${runtime_dir}" || return
  runtime_filesystem=$(stat -f -c '%T' "${runtime_dir}") || return 126
  if [ "${runtime_filesystem}" != 'tmpfs' ]; then
    _walg_die "WAL-G runtime credential directory must reside on tmpfs"
    return
  fi

  postgres_uid=$(id -u postgres) || return 126
  postgres_gid=$(id -g postgres) || return 126
  chown "${postgres_uid}:${postgres_gid}" "${runtime_dir}"
  chmod 0700 "${runtime_dir}"
  touch "${runtime_lock}"
  chown "${postgres_uid}:${postgres_gid}" "${runtime_lock}"
  chmod 0600 "${runtime_lock}"
  _walg_require_safe_lock_file "${runtime_lock}" || return

  exec 9>> "${runtime_lock}" || return 126
  flock -x 9 || return 126
  _walg_recover_runtime_residue "${runtime_dir}" "${postgres_uid}" || return
  stage_dir=$(mktemp -d "${runtime_dir}/.install.XXXXXX") || return 126
  chmod 0700 "${stage_dir}"

  for secret_file in aws_access_key_id aws_secret_access_key libsodium.key walg_backup_epoch walg_s3_prefix manifest.sha256; do
    cp --no-preserve=mode,ownership "${source_dir}/${secret_file}" "${stage_dir}/${secret_file}"
    chown "${postgres_uid}:${postgres_gid}" "${stage_dir}/${secret_file}"
    chmod 0600 "${stage_dir}/${secret_file}"
  done
  _walg_validate_bundle "${stage_dir}" || return

  for secret_file in aws_access_key_id aws_secret_access_key libsodium.key walg_backup_epoch walg_s3_prefix; do
    mv -f "${stage_dir}/${secret_file}" "${runtime_dir}/${secret_file}"
  done
  mv -f "${stage_dir}/manifest.sha256" "${runtime_dir}/manifest.sha256"
  rmdir "${stage_dir}"
  _walg_validate_bundle "${runtime_dir}" || return

  # Migrate the exact pre-INFRA-HIGH-056 link only. Arbitrary restored links,
  # including WAL-G v3.0.8's rewritten /wal-g-secrets target, remain a hard
  # failure instead of becoming an attacker-controlled cleanup primitive.
  if [ -e "${legacy_logical_dir}" ] && [ ! -L "${legacy_logical_dir}" ]; then
    _walg_die "credential material is forbidden beneath PGDATA"
    return
  fi
  if [ -L "${legacy_logical_dir}" ]; then
    legacy_link_target=$(readlink "${legacy_logical_dir}") || return 126
    if [ "${legacy_link_target}" != "${runtime_dir}" ]; then
      _walg_die "refusing WAL-G symlink with an unexpected target beneath PGDATA"
      return
    fi
    rm -- "${legacy_logical_dir}"
  fi

  flock -u 9
  exec 9>&-
  flock -u 8
  exec 8>&-
  printf 'WAL-G runtime credentials installed on tmpfs; manifest verified.\n'
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -euo pipefail
  umask 077
  case "${1:-}" in
    install)
      if [ "$#" -ne 1 ]; then
        _walg_die "usage: walg-load-secrets.sh install"
        exit 126
      fi
      _walg_install_runtime_secrets
      ;;
    assert-runtime)
      if [ "$#" -ne 1 ]; then
        _walg_die "usage: walg-load-secrets.sh assert-runtime"
        exit 126
      fi
      walg_assert_runtime_secrets
      printf 'WAL-G runtime credential bundle verified.\n'
      ;;
    *)
      _walg_die "usage: walg-load-secrets.sh {install|assert-runtime}"
      exit 126
      ;;
  esac
fi
