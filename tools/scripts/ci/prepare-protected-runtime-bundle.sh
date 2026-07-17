#!/usr/bin/env bash
# Build the exact backup/PITR runtime bundle from the protected runner checkout.
# The target host receives only these verified bytes and never reads its mutable
# worktree or Git object/configuration state.

set -euo pipefail
umask 077

: "${OUTPUT_PATH:?OUTPUT_PATH required}"
: "${SOURCE_SHA:?SOURCE_SHA required}"

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

case "${OUTPUT_PATH}" in
  /*) ;;
  *) die 'OUTPUT_PATH must be absolute.' ;;
esac
[[ "${SOURCE_SHA}" =~ ^[0-9a-f]{40}$ ]] || \
  die 'SOURCE_SHA must be a lowercase 40-character commit SHA.'
[ ! -e "${OUTPUT_PATH}" ] && [ ! -L "${OUTPUT_PATH}" ] || \
  die 'OUTPUT_PATH must not already exist.'
[ -d "$(dirname "${OUTPUT_PATH}")" ] || die 'OUTPUT_PATH parent must exist.'

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)
GIT_BINARY=$(command -v git)
case "${GIT_BINARY}" in
  /*) ;;
  *) die 'git must resolve to an absolute system path.' ;;
esac

protected_git() {
  /usr/bin/env -i \
    PATH=/usr/bin:/bin \
    HOME=/nonexistent \
    LC_ALL=C \
    GIT_CONFIG_NOSYSTEM=1 \
    GIT_CONFIG_GLOBAL=/dev/null \
    "${GIT_BINARY}" \
      --no-replace-objects \
      -c core.hooksPath=/dev/null \
      -c protocol.allow=never \
      -C "${REPO_ROOT}" \
      "$@"
}

MANIFEST=.github/manifests/backup-script.sha256
DR_CONTRACT_MANIFEST=.github/manifests/postgres-dr-contract.sha256
EXPECTED_RUNTIME_PATHS=$(printf '%s\n' \
  .github/manifests/postgres-dr-contract.sha256 \
  tools/scripts/database/backup-databases.sh \
  tools/scripts/database/database-verification.sql \
  tools/scripts/database/evaluate-walg-evidence.mjs \
  tools/scripts/database/materialize-walg-secrets.sh \
  tools/scripts/database/walg-base-backup.sh \
  tools/scripts/database/walg-pitr-restore.sh)
EXPECTED_ARCHIVE_PATHS=$(printf '%s\n%s\n' \
  "${MANIFEST}" "${EXPECTED_RUNTIME_PATHS}")
mapfile -t TRUSTED_PATHS < <(printf '%s\n' "${EXPECTED_ARCHIVE_PATHS}")

RESOLVED_SOURCE_SHA=$(protected_git rev-parse --verify "${SOURCE_SHA}^{commit}")
[ "${RESOLVED_SOURCE_SHA}" = "${SOURCE_SHA}" ] || \
  die 'SOURCE_SHA does not resolve to the exact requested commit.'

TREE_LISTING=$(protected_git ls-tree -r --full-tree "${SOURCE_SHA}" -- "${TRUSTED_PATHS[@]}")
mapfile -t TREE_RECORDS < <(printf '%s\n' "${TREE_LISTING}")
[ "${#TREE_RECORDS[@]}" -eq "${#TRUSTED_PATHS[@]}" ] || \
  die 'protected commit tree does not contain the exact runtime path count.'
declare -A TREE_OBJECTS=()
ACTUAL_TREE_PATHS=
for tree_record in "${TREE_RECORDS[@]}"; do
  IFS=$'\t' read -r tree_metadata tree_path <<< "${tree_record}"
  read -r tree_mode tree_type tree_object <<< "${tree_metadata}"
  case "${tree_mode}:${tree_type}" in
    100644:blob|100755:blob) ;;
    *) die "protected runtime tree entry is not a regular file: ${tree_path}" ;;
  esac
  [[ "${tree_object}" =~ ^[0-9a-f]{40,64}$ ]] || \
    die "protected runtime tree object is invalid: ${tree_path}"
  TREE_OBJECTS["${tree_path}"]="${tree_object}"
  ACTUAL_TREE_PATHS+="${tree_path}"$'\n'
done
ACTUAL_TREE_PATHS=$(printf '%s' "${ACTUAL_TREE_PATHS}" | sort)
[ "${ACTUAL_TREE_PATHS}" = "${EXPECTED_ARCHIVE_PATHS}" ] || \
  die 'protected commit runtime path set is not exact.'

STAGING_ROOT=$(mktemp -d -t aqua-runtime-bundle-stage-XXXXXX)
cleanup_staging_root() {
  status=$?
  trap - EXIT
  cleanup_status=0
  if ! rm -rf -- "${STAGING_ROOT}" || [ -e "${STAGING_ROOT}" ]; then
    printf 'FATAL: runtime bundle staging cleanup failed.\n' >&2
    cleanup_status=1
  fi
  if [ "${status}" -eq 0 ] && [ "${cleanup_status}" -ne 0 ]; then
    status=1
  fi
  exit "${status}"
}
trap cleanup_staging_root EXIT
RAW_ARCHIVE="${STAGING_ROOT}/protected-tree.tar"
TREE_ROOT="${STAGING_ROOT}/tree"
mkdir -m 0700 "${TREE_ROOT}"
protected_git archive --format=tar --output="${RAW_ARCHIVE}" \
  "${SOURCE_SHA}" -- "${TRUSTED_PATHS[@]}"

EXPECTED_RAW_ARCHIVE_PATHS=$(printf '%s\n' \
  .github/ \
  .github/manifests/ \
  .github/manifests/backup-script.sha256 \
  .github/manifests/postgres-dr-contract.sha256 \
  tools/ \
  tools/scripts/ \
  tools/scripts/database/ \
  tools/scripts/database/backup-databases.sh \
  tools/scripts/database/database-verification.sql \
  tools/scripts/database/evaluate-walg-evidence.mjs \
  tools/scripts/database/materialize-walg-secrets.sh \
  tools/scripts/database/walg-base-backup.sh \
  tools/scripts/database/walg-pitr-restore.sh)
RAW_ARCHIVE_PATHS=$(tar -tf "${RAW_ARCHIVE}" | sort)
UNIQUE_RAW_ARCHIVE_PATHS=$(tar -tf "${RAW_ARCHIVE}" | sort -u)
RAW_REGULAR_COUNT=$(tar -tvf "${RAW_ARCHIVE}" | awk '$1 ~ /^-/ {count++} END {print count + 0}')
RAW_DIRECTORY_COUNT=$(tar -tvf "${RAW_ARCHIVE}" | awk '$1 ~ /^d/ {count++} END {print count + 0}')
RAW_UNSAFE_TYPE_COUNT=$(tar -tvf "${RAW_ARCHIVE}" | awk '$1 !~ /^[-d]/ {count++} END {print count + 0}')
if [ "${RAW_ARCHIVE_PATHS}" != "${EXPECTED_RAW_ARCHIVE_PATHS}" ] || \
   [ "${UNIQUE_RAW_ARCHIVE_PATHS}" != "${EXPECTED_RAW_ARCHIVE_PATHS}" ] || \
   [ "${RAW_REGULAR_COUNT}" -ne 8 ] || \
   [ "${RAW_DIRECTORY_COUNT}" -ne 5 ] || \
   [ "${RAW_UNSAFE_TYPE_COUNT}" -ne 0 ]; then
  die 'protected commit archive membership or entry types are not exact.'
fi
tar --extract --no-same-owner --no-same-permissions \
  --file "${RAW_ARCHIVE}" --directory "${TREE_ROOT}"

for trusted_path in "${TRUSTED_PATHS[@]}"; do
  [ -f "${TREE_ROOT}/${trusted_path}" ] && [ ! -L "${TREE_ROOT}/${trusted_path}" ] || \
    die "archived protected path is not a regular file: ${trusted_path}"
  extracted_object=$(protected_git hash-object --no-filters "${TREE_ROOT}/${trusted_path}")
  expected_tree_object=${TREE_OBJECTS["${trusted_path}"]}
  [ "${extracted_object}" = "${expected_tree_object}" ] || \
    die "archived bytes do not match the protected tree blob: ${trusted_path}"
done

cd "${TREE_ROOT}"
[ -f "${MANIFEST}" ] && [ ! -L "${MANIFEST}" ] || \
  die 'archived backup integrity manifest is not a regular file.'
if grep -q '__COMPUTE_ON_MERGE__' "${MANIFEST}"; then
  die 'archived backup integrity manifest contains an unresolved placeholder.'
fi
ACTUAL_MANIFEST_PATHS=$(awk '$1 !~ /^#/ && NF == 2 {print $2}' "${MANIFEST}" | sort)
[ "${ACTUAL_MANIFEST_PATHS}" = "${EXPECTED_RUNTIME_PATHS}" ] || \
  die 'archived backup integrity manifest path set is not exact.'
sha256sum --check "${MANIFEST}" >/dev/null

[ -f "${DR_CONTRACT_MANIFEST}" ] && [ ! -L "${DR_CONTRACT_MANIFEST}" ] || \
  die 'archived PostgreSQL DR contract manifest is not a regular file.'
EXPECTED_DR_CONTRACT_PATHS=$(printf '%s\n' \
  infrastructure/docker/Dockerfile.postgres-walg \
  infrastructure/docker/scripts/postgres-ssl-entrypoint.sh \
  infrastructure/docker/scripts/postgres-walg-healthcheck.sh \
  infrastructure/docker/scripts/walg-archive-command.sh \
  infrastructure/docker/scripts/walg-load-secrets.sh \
  infrastructure/docker/scripts/walg-restore-command.sh \
  infrastructure/docker/scripts/walg-runtime-command.sh)
ACTUAL_DR_CONTRACT_PATHS=$(awk '$1 !~ /^#/ && NF == 2 {print $2}' \
  "${DR_CONTRACT_MANIFEST}" | sort)
[ "${ACTUAL_DR_CONTRACT_PATHS}" = "${EXPECTED_DR_CONTRACT_PATHS}" ] || \
  die 'archived PostgreSQL DR contract manifest path set is not exact.'

tar --create --format=posix --no-recursion --file "${OUTPUT_PATH}" \
  "${TRUSTED_PATHS[@]}"
chmod 0600 "${OUTPUT_PATH}"
ARCHIVE_PATHS=$(tar -tf "${OUTPUT_PATH}" | sort)
UNIQUE_ARCHIVE_PATHS=$(tar -tf "${OUTPUT_PATH}" | sort -u)
ARCHIVE_MEMBER_TYPES=$(tar -tvf "${OUTPUT_PATH}" | awk '{print substr($1, 1, 1)}' | sort -u)
if [ "${ARCHIVE_PATHS}" != "${EXPECTED_ARCHIVE_PATHS}" ] || \
   [ "${UNIQUE_ARCHIVE_PATHS}" != "${EXPECTED_ARCHIVE_PATHS}" ] || \
   [ "${ARCHIVE_MEMBER_TYPES}" != '-' ]; then
  die 'protected runtime archive membership or file types are not exact.'
fi
sha256sum "${OUTPUT_PATH}" | awk '{print $1}'
