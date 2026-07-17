#!/usr/bin/env bash
# Materialize WAL-G credentials as a manifest-bound file bundle. Secret values
# are never passed to `docker exec`, persisted in container environment
# metadata, or printed to logs.

set +x
set -euo pipefail
umask 077

HOST_SECRET_DIR="${WALG_HOST_SECRET_DIR:-/var/aqua-saas/certs/wal-g/postgres}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-aqua-postgres}"
INSTALL_RUNNING_CONTAINER="${WALG_INSTALL_RUNNING_CONTAINER:-true}"
STAGE_DIR=''
PUBLISH_TEMP_FILES=()
HAD_PUBLISHED_MANIFEST=false
PUBLICATION_STARTED=false
PUBLICATION_COMPLETE=false
BUNDLE_FILES=(
  aws_access_key_id
  aws_secret_access_key
  libsodium.key
  walg_backup_epoch
  walg_s3_prefix
)

cleanup() {
  local canonical_file
  local temp_file

  for temp_file in "${PUBLISH_TEMP_FILES[@]}"; do
    if [ -L "${temp_file}" ] || { [ -e "${temp_file}" ] && [ ! -f "${temp_file}" ]; }; then
      printf 'FATAL: refusing unsafe WAL-G publication residue during cleanup: %s\n' \
        "${temp_file}" >&2
      continue
    fi
    rm -f -- "${temp_file}"
  done
  if [ -n "${STAGE_DIR}" ] && [ -d "${STAGE_DIR}" ]; then
    remove_materialization_stage "${STAGE_DIR}" || true
  fi
  if [ "${PUBLICATION_STARTED}" = 'true' ] && \
     [ "${PUBLICATION_COMPLETE}" != 'true' ] && \
     [ "${HAD_PUBLISHED_MANIFEST}" != 'true' ]; then
    for canonical_file in "${BUNDLE_FILES[@]}" manifest.sha256; do
      if [ -L "${HOST_SECRET_DIR}/${canonical_file}" ] || \
         { [ -e "${HOST_SECRET_DIR}/${canonical_file}" ] && \
           [ ! -f "${HOST_SECRET_DIR}/${canonical_file}" ]; }; then
        printf 'FATAL: refusing unsafe initial-publication entry during cleanup: %s\n' \
          "${canonical_file}" >&2
        continue
      fi
      rm -f -- "${HOST_SECRET_DIR}/${canonical_file}"
    done
  fi
}
trap cleanup EXIT

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

assert_absolute_directory_path() {
  local directory_path=$1
  local current_path=''
  local component
  local -a components

  if [[ "${directory_path}" != /* ]] || [ "${directory_path}" = '/' ] || \
     [[ "${directory_path}" == *$'\n'* ]] || [[ "${directory_path}" == *$'\r'* ]] || \
     [[ "${directory_path}" == *'//'* ]] || [[ "${directory_path}" == */ ]]; then
    die 'WALG_HOST_SECRET_DIR must be a canonical absolute non-root directory path.'
  fi

  IFS='/' read -r -a components <<< "${directory_path#/}"
  for component in "${components[@]}"; do
    if [ -z "${component}" ] || [ "${component}" = '.' ] || [ "${component}" = '..' ]; then
      die 'WALG_HOST_SECRET_DIR must not contain empty, dot, or parent components.'
    fi
    current_path="${current_path}/${component}"
    if [ -L "${current_path}" ]; then
      die "WALG host secret directory has a symlink ancestor: ${current_path}"
    fi
    if [ -e "${current_path}" ] && [ ! -d "${current_path}" ]; then
      die "WALG host secret directory ancestor is not a directory: ${current_path}"
    fi
  done
}

create_directory_tree_without_symlinks() {
  local directory_path=$1
  local current_path=''
  local component
  local -a components

  assert_absolute_directory_path "${directory_path}"
  IFS='/' read -r -a components <<< "${directory_path#/}"
  for component in "${components[@]}"; do
    current_path="${current_path}/${component}"
    if [ ! -e "${current_path}" ] && [ ! -L "${current_path}" ]; then
      mkdir -- "${current_path}"
    fi
    if [ -L "${current_path}" ] || [ ! -d "${current_path}" ]; then
      die "WALG host secret directory path became unsafe: ${current_path}"
    fi
  done
  assert_absolute_directory_path "${directory_path}"
}

remove_materialization_stage() {
  local stage_path=$1
  local entry
  local entry_name
  local owner_uid

  if [ -L "${stage_path}" ] || [ ! -d "${stage_path}" ]; then
    printf 'FATAL: WAL-G materialization residue is not a real directory: %s\n' \
      "${stage_path}" >&2
    return 2
  fi
  owner_uid=$(stat -c '%u' "${stage_path}") || return 2
  if [ "${owner_uid}" -ne "$(id -u)" ]; then
    printf 'FATAL: WAL-G materialization residue has an unexpected owner: %s\n' \
      "${stage_path}" >&2
    return 2
  fi

  while IFS= read -r -d '' entry; do
    if [ ! -e "${entry}" ] && [ ! -L "${entry}" ]; then
      continue
    fi
    entry_name=${entry##*/}
    case "${entry_name}" in
      aws_access_key_id|aws_secret_access_key|libsodium.key|walg_backup_epoch|walg_s3_prefix|manifest.sha256|.libsodium.decoded|.initial-publication) ;;
      *)
        printf 'FATAL: WAL-G materialization residue contains an unexpected entry: %s\n' \
          "${entry}" >&2
        return 2
        ;;
    esac
    if [ -L "${entry}" ] || [ ! -f "${entry}" ]; then
      printf 'FATAL: WAL-G materialization residue contains an unsafe entry: %s\n' \
        "${entry}" >&2
      return 2
    fi
    if [ "$(stat -c '%u' "${entry}")" -ne "$(id -u)" ]; then
      printf 'FATAL: WAL-G materialization residue entry has an unexpected owner: %s\n' \
        "${entry}" >&2
      return 2
    fi
  done < <(find "${stage_path}" -mindepth 1 -maxdepth 1 -print0)

  find "${stage_path}" -mindepth 1 -maxdepth 1 -type f -delete
  rmdir -- "${stage_path}"
}

recover_publication_residue() {
  local entry
  local entry_name
  local initial_entry
  local owner_uid

  while IFS= read -r -d '' entry; do
    if [ ! -e "${entry}" ] && [ ! -L "${entry}" ]; then
      continue
    fi
    entry_name=${entry##*/}
    case "${entry_name}" in
      .lock|aws_access_key_id|aws_secret_access_key|libsodium.key|walg_backup_epoch|walg_s3_prefix|manifest.sha256)
        if [ -L "${entry}" ] || [ ! -f "${entry}" ]; then
          die "WAL-G host bundle contains an unsafe canonical entry: ${entry_name}"
        fi
        ;;
      .materialize.??????)
        if [[ ! "${entry_name}" =~ ^\.materialize\.[A-Za-z0-9]{6}$ ]]; then
          die "WAL-G host bundle contains unsafe materialization residue: ${entry_name}"
        fi
        if [ -f "${entry}/.initial-publication" ] && \
           [ ! -L "${entry}/.initial-publication" ]; then
          for initial_entry in "${BUNDLE_FILES[@]}" manifest.sha256; do
            if [ -L "${HOST_SECRET_DIR}/${initial_entry}" ] || \
               { [ -e "${HOST_SECRET_DIR}/${initial_entry}" ] && \
                 [ ! -f "${HOST_SECRET_DIR}/${initial_entry}" ]; }; then
              die "initial WAL-G publication left an unsafe canonical entry: ${initial_entry}"
            fi
            rm -f -- "${HOST_SECRET_DIR}/${initial_entry}"
          done
        fi
        remove_materialization_stage "${entry}" || die 'unsafe WAL-G materialization residue cannot be recovered.'
        ;;
      .aws_access_key_id.next.*|.aws_secret_access_key.next.*|.libsodium.key.next.*|.walg_backup_epoch.next.*|.walg_s3_prefix.next.*|.manifest.sha256.next.*)
        if [[ ! "${entry_name}" =~ ^\.(aws_access_key_id|aws_secret_access_key|libsodium\.key|walg_backup_epoch|walg_s3_prefix|manifest\.sha256)\.next\.[1-9][0-9]*$ ]] || \
           [ -L "${entry}" ] || [ ! -f "${entry}" ]; then
          die "WAL-G host bundle contains unsafe publication residue: ${entry_name}"
        fi
        owner_uid=$(stat -c '%u' "${entry}") || die 'cannot inspect WAL-G publication residue.'
        if [ "${owner_uid}" -ne "$(id -u)" ]; then
          die "WAL-G publication residue has an unexpected owner: ${entry_name}"
        fi
        rm -- "${entry}"
        ;;
      *)
        die "WAL-G host bundle contains an unexpected entry: ${entry_name}"
        ;;
    esac
  done < <(find "${HOST_SECRET_DIR}" -mindepth 1 -maxdepth 1 -print0)
}

assert_exact_published_bundle() {
  local entry
  local entry_name
  local canonical_count=0

  while IFS= read -r -d '' entry; do
    entry_name=${entry##*/}
    case "${entry_name}" in
      .lock|aws_access_key_id|aws_secret_access_key|libsodium.key|walg_backup_epoch|walg_s3_prefix|manifest.sha256)
        if [ -L "${entry}" ] || [ ! -f "${entry}" ]; then
          die "published WAL-G bundle entry is unsafe: ${entry_name}"
        fi
        canonical_count=$((canonical_count + 1))
        ;;
      *)
        die "published WAL-G bundle contains an unexpected entry: ${entry_name}"
        ;;
    esac
  done < <(find "${HOST_SECRET_DIR}" -mindepth 1 -maxdepth 1 -print0)
  if [ "${canonical_count}" -ne 7 ]; then
    die 'published WAL-G bundle does not contain the exact canonical entry set.'
  fi
}

validate_manifest_shape() {
  local manifest_path=$1
  local manifest_line=''
  local manifest_entry
  local entry_count=0
  local entry_pattern='^([0-9a-f]{64})  (aws_access_key_id|aws_secret_access_key|libsodium[.]key|walg_backup_epoch|walg_s3_prefix)$'
  local -A seen_entries=()

  if [ ! -f "${manifest_path}" ] || [ -L "${manifest_path}" ]; then
    die 'existing WAL-G manifest is missing or unsafe.'
  fi
  while IFS= read -r manifest_line || [ -n "${manifest_line}" ]; do
    if [[ ! "${manifest_line}" =~ ${entry_pattern} ]]; then
      die 'existing WAL-G manifest contains an invalid entry.'
    fi
    manifest_entry=${BASH_REMATCH[2]}
    if [ -n "${seen_entries[${manifest_entry}]:-}" ]; then
      die 'existing WAL-G manifest repeats a canonical entry.'
    fi
    seen_entries[${manifest_entry}]=true
    entry_count=$((entry_count + 1))
  done < "${manifest_path}"
  if [ "${entry_count}" -ne "${#BUNDLE_FILES[@]}" ]; then
    die 'existing WAL-G manifest does not bind the exact canonical tuple.'
  fi
}

manifest_hash_for() {
  local manifest_path=$1
  local target_entry=$2
  local manifest_hash=''
  local manifest_entry=''

  while read -r manifest_hash manifest_entry; do
    if [ "${manifest_entry}" = "${target_entry}" ]; then
      printf '%s' "${manifest_hash}"
      return 0
    fi
  done < "${manifest_path}"
  return 2
}

sha256_text() {
  printf '%s' "$1" | sha256sum | while read -r hash _; do printf '%s' "${hash}"; done
}

validate_rotation_authority() {
  local canonical_entry_count=0
  local entry
  local old_epoch_hash
  local old_libsodium_hash
  local old_prefix_hash
  local new_epoch_hash
  local new_libsodium_hash
  local new_prefix_hash

  for entry in "${BUNDLE_FILES[@]}" manifest.sha256; do
    if [ -e "${HOST_SECRET_DIR}/${entry}" ] || [ -L "${HOST_SECRET_DIR}/${entry}" ]; then
      canonical_entry_count=$((canonical_entry_count + 1))
    fi
  done
  if [ "${canonical_entry_count}" -eq 0 ]; then
    return 0
  fi
  if [ ! -f "${HOST_SECRET_DIR}/manifest.sha256" ] || [ -L "${HOST_SECRET_DIR}/manifest.sha256" ]; then
    die 'partial WAL-G publication lacks the prior manifest authority.'
  fi

  validate_manifest_shape "${HOST_SECRET_DIR}/manifest.sha256"
  assert_exact_published_bundle
  if ! (
    cd "${HOST_SECRET_DIR}"
    sha256sum --strict --status -c manifest.sha256
  ); then
    die 'existing WAL-G credential manifest does not match the prior bundle bytes.'
  fi
  HAD_PUBLISHED_MANIFEST=true
  old_epoch_hash=$(manifest_hash_for "${HOST_SECRET_DIR}/manifest.sha256" walg_backup_epoch) || \
    die 'existing WAL-G manifest omits backup epoch authority.'
  old_libsodium_hash=$(manifest_hash_for "${HOST_SECRET_DIR}/manifest.sha256" libsodium.key) || \
    die 'existing WAL-G manifest omits encryption-key authority.'
  old_prefix_hash=$(manifest_hash_for "${HOST_SECRET_DIR}/manifest.sha256" walg_s3_prefix) || \
    die 'existing WAL-G manifest omits archive-prefix authority.'
  new_epoch_hash=$(sha256_text "${WALG_BACKUP_EPOCH}")
  new_libsodium_hash=$(sha256_text "${WALG_LIBSODIUM_KEY_B64}")
  new_prefix_hash=$(sha256_text "${WALG_S3_PREFIX}")

  if [ "${new_epoch_hash}" = "${old_epoch_hash}" ]; then
    if [ "${new_libsodium_hash}" != "${old_libsodium_hash}" ] || \
       [ "${new_prefix_hash}" != "${old_prefix_hash}" ]; then
      die 'same-epoch WAL-G rotation may change only the access-key principal.'
    fi
  elif [ "${new_libsodium_hash}" = "${old_libsodium_hash}" ] || \
       [ "${new_prefix_hash}" = "${old_prefix_hash}" ]; then
    die 'a new WAL-G backup epoch requires both a new archive prefix and a new encryption key.'
  fi

  unset old_epoch_hash old_libsodium_hash old_prefix_hash
  unset new_epoch_hash new_libsodium_hash new_prefix_hash
}

case "${INSTALL_RUNNING_CONTAINER}" in
  true|false) ;;
  *) die 'WALG_INSTALL_RUNNING_CONTAINER must be true or false.' ;;
esac
if [[ ! "${POSTGRES_CONTAINER}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  die 'POSTGRES_CONTAINER contains unsafe characters.'
fi
assert_absolute_directory_path "${HOST_SECRET_DIR}"

: "${WALG_S3_ACCESS_KEY_ID:?WALG_S3_ACCESS_KEY_ID required}"
: "${WALG_S3_SECRET_ACCESS_KEY:?WALG_S3_SECRET_ACCESS_KEY required}"
: "${WALG_LIBSODIUM_KEY_B64:?WALG_LIBSODIUM_KEY_B64 required}"
: "${WALG_BACKUP_EPOCH:?WALG_BACKUP_EPOCH required}"
: "${WALG_S3_PREFIX:?WALG_S3_PREFIX required}"

for credential_value in "${WALG_S3_ACCESS_KEY_ID}" "${WALG_S3_SECRET_ACCESS_KEY}"; do
  if [[ "${credential_value}" == *$'\n'* ]] || [[ "${credential_value}" == *$'\r'* ]]; then
    die 'WAL-G S3 credentials must be single-line values.'
  fi
  if [ "${#credential_value}" -lt 1 ] || [ "${#credential_value}" -gt 4096 ]; then
    die 'WAL-G S3 credential length is outside the accepted range.'
  fi
done
if [[ ! "${WALG_LIBSODIUM_KEY_B64}" =~ ^[A-Za-z0-9+/]{43}=$ ]]; then
  die 'WALG_LIBSODIUM_KEY_B64 must be canonical base64 for exactly 32 bytes.'
fi
if [[ ! "${WALG_BACKUP_EPOCH}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]; then
  die 'WALG_BACKUP_EPOCH must be a canonical lowercase epoch slug.'
fi
if [[ ! "${WALG_S3_PREFIX}" =~ ^s3://[A-Za-z0-9._-]+/postgres/wal-g/[a-z0-9][a-z0-9-]{0,63}$ ]] || \
   [ "${WALG_S3_PREFIX##*/}" != "${WALG_BACKUP_EPOCH}" ]; then
  die 'WALG_S3_PREFIX must be the canonical epoch-scoped PostgreSQL WAL-G prefix.'
fi

create_directory_tree_without_symlinks "${HOST_SECRET_DIR}"
chmod 0700 "${HOST_SECRET_DIR}"
if [ -e "${HOST_SECRET_DIR}/.lock" ] && \
   { [ ! -f "${HOST_SECRET_DIR}/.lock" ] || [ -L "${HOST_SECRET_DIR}/.lock" ]; }; then
  die 'WAL-G host bundle lock must be a regular non-symlink file.'
fi
touch "${HOST_SECRET_DIR}/.lock"
chmod 0600 "${HOST_SECRET_DIR}/.lock"

exec 9>> "${HOST_SECRET_DIR}/.lock"
flock -x 9
assert_absolute_directory_path "${HOST_SECRET_DIR}"
recover_publication_residue
validate_rotation_authority

STAGE_DIR=$(mktemp -d "${HOST_SECRET_DIR}/.materialize.XXXXXX")
chmod 0700 "${STAGE_DIR}"
if [ "${HAD_PUBLISHED_MANIFEST}" != 'true' ]; then
  touch "${STAGE_DIR}/.initial-publication"
  chmod 0600 "${STAGE_DIR}/.initial-publication"
fi
printf '%s' "${WALG_S3_ACCESS_KEY_ID}" > "${STAGE_DIR}/aws_access_key_id"
printf '%s' "${WALG_S3_SECRET_ACCESS_KEY}" > "${STAGE_DIR}/aws_secret_access_key"
if ! printf '%s' "${WALG_LIBSODIUM_KEY_B64}" | base64 --decode > "${STAGE_DIR}/.libsodium.decoded"; then
  die 'WALG_LIBSODIUM_KEY_B64 is not valid base64.'
fi
if [ "$(stat -c '%s' "${STAGE_DIR}/.libsodium.decoded")" -ne 32 ]; then
  die 'decoded WAL-G libsodium key is not exactly 32 bytes.'
fi
if [ "$(base64 -w0 "${STAGE_DIR}/.libsodium.decoded")" != "${WALG_LIBSODIUM_KEY_B64}" ]; then
  die 'WALG_LIBSODIUM_KEY_B64 is not in canonical base64 form.'
fi
rm -f "${STAGE_DIR}/.libsodium.decoded"
printf '%s' "${WALG_LIBSODIUM_KEY_B64}" > "${STAGE_DIR}/libsodium.key"
printf '%s' "${WALG_BACKUP_EPOCH}" > "${STAGE_DIR}/walg_backup_epoch"
printf '%s' "${WALG_S3_PREFIX}" > "${STAGE_DIR}/walg_s3_prefix"
for bundle_file in "${BUNDLE_FILES[@]}"; do
  chmod 0600 "${STAGE_DIR}/${bundle_file}"
done
(
  cd "${STAGE_DIR}"
  sha256sum "${BUNDLE_FILES[@]}" > manifest.sha256
)
chmod 0600 "${STAGE_DIR}/manifest.sha256"
if ! (
  cd "${STAGE_DIR}"
  sha256sum --strict --status -c manifest.sha256
); then
  die 'generated WAL-G credential manifest failed verification.'
fi

# Prevent credentials from remaining in this script's environment after the
# files have been written. Xtrace remains disabled for the entire process.
unset WALG_S3_ACCESS_KEY_ID WALG_S3_SECRET_ACCESS_KEY WALG_LIBSODIUM_KEY_B64
unset WALG_BACKUP_EPOCH WALG_S3_PREFIX credential_value

PUBLICATION_STARTED=true
for bundle_file in "${BUNDLE_FILES[@]}"; do
  publish_temp="${HOST_SECRET_DIR}/.${bundle_file}.next.$$"
  PUBLISH_TEMP_FILES+=("${publish_temp}")
  mv "${STAGE_DIR}/${bundle_file}" "${publish_temp}"
  chmod 0600 "${publish_temp}"
done
publish_temp="${HOST_SECRET_DIR}/.manifest.sha256.next.$$"
PUBLISH_TEMP_FILES+=("${publish_temp}")
mv "${STAGE_DIR}/manifest.sha256" "${publish_temp}"
chmod 0600 "${publish_temp}"
for bundle_file in "${BUNDLE_FILES[@]}"; do
  mv -f "${HOST_SECRET_DIR}/.${bundle_file}.next.$$" "${HOST_SECRET_DIR}/${bundle_file}"
done
# Publishing the manifest last makes a partially observed rotation fail closed.
mv -f "${HOST_SECRET_DIR}/.manifest.sha256.next.$$" "${HOST_SECRET_DIR}/manifest.sha256"
rm -f "${STAGE_DIR}/.initial-publication"
rmdir "${STAGE_DIR}"
STAGE_DIR=''
PUBLISH_TEMP_FILES=()
assert_exact_published_bundle
if ! (
  cd "${HOST_SECRET_DIR}"
  sha256sum --strict --status -c manifest.sha256
); then
  die 'published WAL-G credential manifest failed verification.'
fi
PUBLICATION_COMPLETE=true
flock -u 9
exec 9>&-

printf 'WAL-G host credential bundle materialized; epoch-bound tuple and manifest verified.\n'

if [ "${INSTALL_RUNNING_CONTAINER}" = 'true' ]; then
  container_list=''
  if ! command -v docker >/dev/null 2>&1; then
    die 'docker is required to update the running PostgreSQL container.'
  fi
  if ! container_list=$(docker container ls --all \
    --filter "name=^/${POSTGRES_CONTAINER}$" --format '{{.Names}}'); then
    die 'Docker control plane is unavailable while activating WAL-G credentials.'
  fi
  if [ -z "${container_list}" ]; then
    printf 'PostgreSQL container is absent; boot-time installer will load the verified bundle.\n'
  elif [[ "${container_list}" == *$'\n'* ]] || [ "${container_list}" != "${POSTGRES_CONTAINER}" ]; then
    die 'Docker returned an ambiguous PostgreSQL container identity.'
  elif ! container_running=$(docker container inspect \
    --format '{{.State.Running}}' "${POSTGRES_CONTAINER}"); then
    die 'PostgreSQL container state inspection failed after exact identity resolution.'
  elif [ "${container_running}" = 'true' ]; then
    docker exec --user root "${POSTGRES_CONTAINER}" \
      /usr/local/bin/walg-load-secrets.sh install
    printf 'Running PostgreSQL container WAL-G credentials rotated atomically.\n'
  elif [ "${container_running}" = 'false' ]; then
    printf 'PostgreSQL container is stopped; boot-time installer will load the verified bundle.\n'
  else
    die 'PostgreSQL container returned a non-canonical running state.'
  fi
fi
