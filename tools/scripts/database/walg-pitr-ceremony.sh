#!/usr/bin/env bash
# Execute the hash-pinned, run-scoped PITR Docker ceremony after the protected
# runner bundle has been verified and extracted. The runner-owned workflow
# remains responsible only for transport and archive bootstrap.

set -euo pipefail
umask 077

: "${RUNTIME_ROOT:?RUNTIME_ROOT required}"
: "${BACKUP_NAME:?BACKUP_NAME required}"
: "${PITR_WALG_SPACES_ACCESS_KEY_ID:?PITR_WALG_SPACES_ACCESS_KEY_ID required}"
: "${PITR_WALG_SPACES_SECRET_ACCESS_KEY:?PITR_WALG_SPACES_SECRET_ACCESS_KEY required}"
: "${PITR_WALG_LIBSODIUM_KEY_B64:?PITR_WALG_LIBSODIUM_KEY_B64 required}"
: "${PITR_WALG_BACKUP_EPOCH:?PITR_WALG_BACKUP_EPOCH required}"
: "${TARGET_WALG_S3_PREFIX:?TARGET_WALG_S3_PREFIX required}"
: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_DB:?POSTGRES_DB required}"
: "${EXPECTED_SOURCE_SYSTEM_IDENTIFIER:?EXPECTED_SOURCE_SYSTEM_IDENTIFIER required}"
: "${PITR_MAIN_SHA:?PITR_MAIN_SHA required}"
: "${EVIDENCE_RUN_ID:?EVIDENCE_RUN_ID required}"
: "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256:?EXPECTED_POSTGRES_DR_CONTRACT_SHA256 required}"

[[ "${BACKUP_NAME}" =~ ^base_[A-Za-z0-9._:-]+$ ]]
case "${BACKUP_NAME}" in LATEST|latest) exit 2 ;; esac
[[ "${PITR_WALG_BACKUP_EPOCH}" =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]]
[[ "${TARGET_WALG_S3_PREFIX}" =~ ^s3://[A-Za-z0-9][A-Za-z0-9._-]{1,62}/postgres/wal-g/${PITR_WALG_BACKUP_EPOCH}$ ]]
[[ "${PITR_MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]]
[[ "${EXPECTED_SOURCE_SYSTEM_IDENTIFIER}" =~ ^[0-9]{10,24}$ ]]
[[ "${EVIDENCE_RUN_ID}" =~ ^gha-[1-9][0-9]*-[1-9][0-9]*$ ]]
[[ "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}" =~ ^[0-9a-f]{64}$ ]]
case "${RUNTIME_ROOT}" in
  /tmp/aqua-pitr-runtime.*) ;;
  *) echo 'FATAL: RUNTIME_ROOT is outside the run-scoped PITR namespace.' >&2; exit 2 ;;
esac
[ -d "${RUNTIME_ROOT}" ] && [ ! -L "${RUNTIME_ROOT}" ]
[ "$(pwd -P)" = "${RUNTIME_ROOT}" ]

RESOURCE_NONCE=$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')
if [[ ! "${RESOURCE_NONCE}" =~ ^[0-9a-f]{32}$ ]]; then
  echo 'FATAL: could not create a cryptographically random PITR resource nonce.'
  exit 2
fi
TARGET_CONTAINER="aqua-pitr-${EVIDENCE_RUN_ID}-${RESOURCE_NONCE}"
TARGET_NETWORK="aqua-pitr-${EVIDENCE_RUN_ID}-${RESOURCE_NONCE}"
TARGET_VOLUME="aqua-pitr-${EVIDENCE_RUN_ID}-${RESOURCE_NONCE}-pgdata"
TARGET_SECRET_SOURCE="${RUNTIME_ROOT}/target-wal-g-secrets"
TARGET_CONTAINER_ID=
TARGET_NETWORK_ID=
TARGET_VOLUME_CREATED_AT=
TARGET_VOLUME_MOUNTPOINT=
TARGET_CREATED=false
NETWORK_CREATED=false
VOLUME_CREATED=false

attest_target_container() {
  local attestation current_id current_name current_role current_run current_nonce
  local current_resource current_owner_network_id
  [ -n "${TARGET_CONTAINER_ID}" ] || return 1
  attestation=$(docker container inspect --format \
    '{{.Id}}|{{.Name}}|{{ index .Config.Labels "com.aqua-saas.restore.role" }}|{{ index .Config.Labels "com.aqua-saas.restore.run-id" }}|{{ index .Config.Labels "com.aqua-saas.restore.nonce" }}|{{ index .Config.Labels "com.aqua-saas.restore.resource" }}|{{ index .Config.Labels "com.aqua-saas.restore.owner-network-id" }}' \
    "${TARGET_CONTAINER_ID}") || return 1
  IFS='|' read -r current_id current_name current_role current_run current_nonce \
    current_resource current_owner_network_id <<< "${attestation}"
  [ "${current_id}" = "${TARGET_CONTAINER_ID}" ] && \
    [ "${current_name}" = "/${TARGET_CONTAINER}" ] && \
    [ "${current_role}" = 'isolated-drill' ] && \
    [ "${current_run}" = "${EVIDENCE_RUN_ID}" ] && \
    [ "${current_nonce}" = "${RESOURCE_NONCE}" ] && \
    [ "${current_resource}" = 'container' ] && \
    [ "${current_owner_network_id}" = "${TARGET_NETWORK_ID}" ]
}

attest_target_network() {
  local attestation current_id current_name current_role current_run current_nonce
  local current_resource
  [ -n "${TARGET_NETWORK_ID}" ] || return 1
  attestation=$(docker network inspect --format \
    '{{.Id}}|{{.Name}}|{{ index .Labels "com.aqua-saas.restore.role" }}|{{ index .Labels "com.aqua-saas.restore.run-id" }}|{{ index .Labels "com.aqua-saas.restore.nonce" }}|{{ index .Labels "com.aqua-saas.restore.resource" }}' \
    "${TARGET_NETWORK_ID}") || return 1
  IFS='|' read -r current_id current_name current_role current_run current_nonce \
    current_resource <<< "${attestation}"
  [ "${current_id}" = "${TARGET_NETWORK_ID}" ] && \
    [ "${current_name}" = "${TARGET_NETWORK}" ] && \
    [ "${current_role}" = 'isolated-drill' ] && \
    [ "${current_run}" = "${EVIDENCE_RUN_ID}" ] && \
    [ "${current_nonce}" = "${RESOURCE_NONCE}" ] && \
    [ "${current_resource}" = 'network' ]
}

attest_target_volume() {
  local attestation current_name current_created_at current_mountpoint current_role
  local current_run current_nonce current_resource current_owner_network_id
  [ -n "${TARGET_VOLUME_CREATED_AT}" ] && \
    [ -n "${TARGET_VOLUME_MOUNTPOINT}" ] || return 1
  attestation=$(docker volume inspect --format \
    '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}|{{ index .Labels "com.aqua-saas.restore.role" }}|{{ index .Labels "com.aqua-saas.restore.run-id" }}|{{ index .Labels "com.aqua-saas.restore.nonce" }}|{{ index .Labels "com.aqua-saas.restore.resource" }}|{{ index .Labels "com.aqua-saas.restore.owner-network-id" }}' \
    "${TARGET_VOLUME}") || return 1
  IFS='|' read -r current_name current_created_at current_mountpoint current_role \
    current_run current_nonce current_resource current_owner_network_id <<< "${attestation}"
  [ "${current_name}" = "${TARGET_VOLUME}" ] && \
    [ "${current_created_at}" = "${TARGET_VOLUME_CREATED_AT}" ] && \
    [ "${current_mountpoint}" = "${TARGET_VOLUME_MOUNTPOINT}" ] && \
    [ "${current_role}" = 'isolated-drill' ] && \
    [ "${current_run}" = "${EVIDENCE_RUN_ID}" ] && \
    [ "${current_nonce}" = "${RESOURCE_NONCE}" ] && \
    [ "${current_resource}" = 'pgdata-volume' ] && \
    [ "${current_owner_network_id}" = "${TARGET_NETWORK_ID}" ]
}

cleanup_runtime() {
  status=$?
  trap - EXIT
  cleanup_status=0
  if [ "${TARGET_CREATED}" = 'true' ]; then
    if ! attest_target_container; then
      echo 'FATAL: refusing to remove a PITR container whose immutable identity or ownership labels changed.' >&2
      cleanup_status=1
    elif ! docker rm --force "${TARGET_CONTAINER_ID}" >/dev/null 2>&1 || \
       docker container inspect "${TARGET_CONTAINER_ID}" >/dev/null 2>&1; then
      echo 'FATAL: disposable PITR container cleanup failed.' >&2
      cleanup_status=1
    fi
  fi
  if [ "${NETWORK_CREATED}" = 'true' ]; then
    if ! attest_target_network; then
      echo 'FATAL: refusing to remove a PITR network whose immutable identity or ownership labels changed.' >&2
      cleanup_status=1
    elif ! docker network rm "${TARGET_NETWORK_ID}" >/dev/null 2>&1 || \
       docker network inspect "${TARGET_NETWORK_ID}" >/dev/null 2>&1; then
      echo 'FATAL: disposable PITR network cleanup failed.' >&2
      cleanup_status=1
    fi
  fi
  if [ "${VOLUME_CREATED}" = 'true' ]; then
    if ! attest_target_volume; then
      echo 'FATAL: refusing to remove a PITR volume whose creation identity or ownership labels changed.' >&2
      cleanup_status=1
    elif ! docker volume rm "${TARGET_VOLUME}" >/dev/null 2>&1 || \
       docker volume inspect "${TARGET_VOLUME}" >/dev/null 2>&1; then
      echo 'FATAL: disposable PITR data-volume cleanup failed.' >&2
      cleanup_status=1
    fi
  fi
  if ! rm -rf -- "${RUNTIME_ROOT}" || [ -e "${RUNTIME_ROOT}" ]; then
    echo 'FATAL: PITR run-scoped runtime cleanup failed.' >&2
    cleanup_status=1
  fi
  if [ "${status}" -eq 0 ] && [ "${cleanup_status}" -ne 0 ]; then
    status=1
  fi
  exit "${status}"
}
trap cleanup_runtime EXIT

for target_object in "${TARGET_CONTAINER}" "${TARGET_NETWORK}" "${TARGET_VOLUME}"; do
  if docker inspect "${target_object}" >/dev/null 2>&1 || \
     docker network inspect "${target_object}" >/dev/null 2>&1 || \
     docker volume inspect "${target_object}" >/dev/null 2>&1; then
    echo "FATAL: run-scoped Docker object already exists: ${target_object}"
    exit 2
  fi
done
# Source attestation, disposable resource mutation, restore, and
# cleanup are one exclusive production-host ceremony.
# shellcheck source=scripts/deploy/production-host-control-plane.sh
source scripts/deploy/production-host-control-plane.sh
aqua_control_plane_lock_acquire exclusive 5400
aqua_control_plane_lock_assert
aqua_control_plane_guard_dr_state

export POSTGRES_CONTAINER=aqua-postgres
export WALG_EVIDENCE_DIR="${RUNTIME_ROOT}/walg-evidence"
mkdir -p "${WALG_EVIDENCE_DIR}"

SOURCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' "${POSTGRES_CONTAINER}")
[[ "${SOURCE_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]]
SOURCE_WALG_BACKUP_EPOCH=$(docker exec "${POSTGRES_CONTAINER}" bash -ceu 'printf %s "${WALG_BACKUP_EPOCH:?}"')
SOURCE_WALG_S3_PREFIX=$(docker exec "${POSTGRES_CONTAINER}" bash -ceu 'printf %s "${WALG_S3_PREFIX:?}"')
SOURCE_WALG_S3_ENDPOINT=$(docker exec "${POSTGRES_CONTAINER}" bash -ceu 'printf %s "${WALG_S3_ENDPOINT:?}"')
SOURCE_WALG_S3_REGION=$(docker exec "${POSTGRES_CONTAINER}" bash -ceu 'printf %s "${WALG_S3_REGION:?}"')
SOURCE_S3_PATH_STYLE=$(docker exec "${POSTGRES_CONTAINER}" bash -ceu 'printf %s "${AWS_S3_FORCE_PATH_STYLE:-true}"')
if [ "${SOURCE_WALG_BACKUP_EPOCH}" != "${PITR_WALG_BACKUP_EPOCH}" ] || \
   [ "${SOURCE_WALG_S3_PREFIX}" != "${TARGET_WALG_S3_PREFIX}" ]; then
  echo 'FATAL: selected PITR epoch/prefix is not the active source archive chain.'
  exit 2
fi
[[ "${SOURCE_WALG_S3_ENDPOINT}" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]
[[ "${SOURCE_WALG_S3_REGION}" =~ ^[A-Za-z0-9._-]+$ ]]
case "${SOURCE_S3_PATH_STYLE}" in true|false) ;; *) exit 2 ;; esac

WALG_HOST_SECRET_DIR="${TARGET_SECRET_SOURCE}" \
WALG_S3_ACCESS_KEY_ID="${PITR_WALG_SPACES_ACCESS_KEY_ID}" \
WALG_S3_SECRET_ACCESS_KEY="${PITR_WALG_SPACES_SECRET_ACCESS_KEY}" \
WALG_LIBSODIUM_KEY_B64="${PITR_WALG_LIBSODIUM_KEY_B64}" \
WALG_BACKUP_EPOCH="${PITR_WALG_BACKUP_EPOCH}" \
WALG_S3_PREFIX="${TARGET_WALG_S3_PREFIX}" \
WALG_INSTALL_RUNNING_CONTAINER=false \
  bash tools/scripts/database/materialize-walg-secrets.sh
unset PITR_WALG_LIBSODIUM_KEY_B64 PITR_WALG_SPACES_ACCESS_KEY_ID
unset PITR_WALG_SPACES_SECRET_ACCESS_KEY

TARGET_NETWORK_ID=$(docker network create \
  --label com.aqua-saas.restore.role=isolated-drill \
  --label "com.aqua-saas.restore.run-id=${EVIDENCE_RUN_ID}" \
  --label "com.aqua-saas.restore.nonce=${RESOURCE_NONCE}" \
  --label com.aqua-saas.restore.resource=network \
  --opt com.docker.network.bridge.enable_icc=false \
  "${TARGET_NETWORK}")
[[ "${TARGET_NETWORK_ID}" =~ ^[0-9a-f]{64}$ ]]
NETWORK_CREATED=true
if ! attest_target_network; then
  echo 'FATAL: newly created PITR network identity or ownership labels are invalid.'
  exit 2
fi
CREATED_VOLUME_NAME=$(docker volume create \
  --label com.aqua-saas.restore.role=isolated-drill \
  --label "com.aqua-saas.restore.run-id=${EVIDENCE_RUN_ID}" \
  --label "com.aqua-saas.restore.nonce=${RESOURCE_NONCE}" \
  --label com.aqua-saas.restore.resource=pgdata-volume \
  --label "com.aqua-saas.restore.owner-network-id=${TARGET_NETWORK_ID}" \
  "${TARGET_VOLUME}")
if [ "${CREATED_VOLUME_NAME}" != "${TARGET_VOLUME}" ]; then
  echo 'FATAL: Docker did not return the requested PITR volume name.'
  exit 2
fi
VOLUME_ATTESTATION=$(docker volume inspect --format \
  '{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}|{{ index .Labels "com.aqua-saas.restore.role" }}|{{ index .Labels "com.aqua-saas.restore.run-id" }}|{{ index .Labels "com.aqua-saas.restore.nonce" }}|{{ index .Labels "com.aqua-saas.restore.resource" }}|{{ index .Labels "com.aqua-saas.restore.owner-network-id" }}' \
  "${TARGET_VOLUME}")
IFS='|' read -r CREATED_VOLUME_NAME TARGET_VOLUME_CREATED_AT TARGET_VOLUME_MOUNTPOINT \
  CREATED_VOLUME_ROLE CREATED_VOLUME_RUN CREATED_VOLUME_NONCE CREATED_VOLUME_RESOURCE \
  CREATED_VOLUME_OWNER_NETWORK_ID <<< "${VOLUME_ATTESTATION}"
if [ "${CREATED_VOLUME_NAME}" != "${TARGET_VOLUME}" ] || \
   [ -z "${TARGET_VOLUME_CREATED_AT}" ] || \
   [ -z "${TARGET_VOLUME_MOUNTPOINT}" ] || \
   [ "${CREATED_VOLUME_ROLE}" != 'isolated-drill' ] || \
   [ "${CREATED_VOLUME_RUN}" != "${EVIDENCE_RUN_ID}" ] || \
   [ "${CREATED_VOLUME_NONCE}" != "${RESOURCE_NONCE}" ] || \
   [ "${CREATED_VOLUME_RESOURCE}" != 'pgdata-volume' ] || \
   [ "${CREATED_VOLUME_OWNER_NETWORK_ID}" != "${TARGET_NETWORK_ID}" ]; then
  echo 'FATAL: refusing to claim a PITR volume without exact fresh-run ownership.'
  exit 2
fi
VOLUME_CREATED=true
TARGET_CONTAINER_ID=$(docker create \
  --name "${TARGET_CONTAINER}" \
  --user root \
  --network "${TARGET_NETWORK}" \
  --label com.aqua-saas.restore.role=isolated-drill \
  --label "com.aqua-saas.restore.run-id=${EVIDENCE_RUN_ID}" \
  --label "com.aqua-saas.restore.nonce=${RESOURCE_NONCE}" \
  --label com.aqua-saas.restore.resource=container \
  --label "com.aqua-saas.restore.owner-network-id=${TARGET_NETWORK_ID}" \
  --read-only \
  --memory 2g \
  --memory-swap 2g \
  --cpus 1 \
  --pids-limit 256 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --cap-add CHOWN \
  --cap-add DAC_OVERRIDE \
  --cap-add FOWNER \
  --tmpfs /run:rw,noexec,nosuid,nodev,size=2m,mode=0755 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777 \
  --mount "type=volume,source=${TARGET_VOLUME},target=/var/lib/postgresql/data" \
  --mount "type=bind,source=${TARGET_SECRET_SOURCE},target=/var/lib/postgresql/wal-g-secrets-source,readonly" \
  --env PGDATA=/var/lib/postgresql/data \
  --env "POSTGRES_USER=${POSTGRES_USER}" \
  --env "POSTGRES_DB=${POSTGRES_DB}" \
  --env "WALG_BACKUP_EPOCH=${PITR_WALG_BACKUP_EPOCH}" \
  --env "WALG_S3_PREFIX=${TARGET_WALG_S3_PREFIX}" \
  --env "WALG_S3_ENDPOINT=${SOURCE_WALG_S3_ENDPOINT}" \
  --env "WALG_S3_REGION=${SOURCE_WALG_S3_REGION}" \
  --env "AWS_S3_FORCE_PATH_STYLE=${SOURCE_S3_PATH_STYLE}" \
  --entrypoint /bin/bash \
  "${SOURCE_IMAGE_ID}" \
  -ceu 'trap : TERM INT; while :; do sleep 3600; done')
[[ "${TARGET_CONTAINER_ID}" =~ ^[0-9a-f]{64}$ ]]
TARGET_CREATED=true
if ! attest_target_container; then
  echo 'FATAL: newly created PITR container identity or ownership labels are invalid.'
  exit 2
fi
docker start "${TARGET_CONTAINER_ID}" >/dev/null

TARGET_CONTAINER="${TARGET_CONTAINER}" \
TARGET_PGDATA_VOLUME="${TARGET_VOLUME}" \
TARGET_NETWORK="${TARGET_NETWORK}" \
TARGET_WALG_SECRET_SOURCE="${TARGET_SECRET_SOURCE}" \
BACKUP_NAME="${BACKUP_NAME}" \
EXPECTED_SOURCE_SYSTEM_IDENTIFIER="${EXPECTED_SOURCE_SYSTEM_IDENTIFIER}" \
SOURCE_POSTGRES_USER="${POSTGRES_USER}" \
SOURCE_POSTGRES_DB="${POSTGRES_DB}" \
TARGET_POSTGRES_USER="${POSTGRES_USER}" \
TARGET_POSTGRES_DB="${POSTGRES_DB}" \
EVIDENCE_RUN_ID="${EVIDENCE_RUN_ID}" \
MAIN_SHA="${PITR_MAIN_SHA}" \
EXPECTED_POSTGRES_DR_CONTRACT_SHA256="${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}" \
PITR_RESET_TARGET=true \
DATABASE_VERIFICATION_SQL=tools/scripts/database/database-verification.sql \
PITR_SOURCE_VERIFICATION_LOCKS_SQL=tools/scripts/database/pitr-source-verification-locks.sql \
BOUNDED_LINE_READER=tools/scripts/database/read-bounded-line.mjs \
  bash tools/scripts/database/walg-pitr-restore.sh

mapfile -t PITR_EVIDENCE_FILES < <(
  find "${WALG_EVIDENCE_DIR}" -maxdepth 1 -type f -name 'timestamp-pitr-*.json' -print
)
if [ "${#PITR_EVIDENCE_FILES[@]}" -ne 1 ]; then
  echo "FATAL: expected one PITR evidence record, found ${#PITR_EVIDENCE_FILES[@]}."
  exit 2
fi
EVIDENCE_FILE=${PITR_EVIDENCE_FILES[0]}
EVIDENCE_BYTES=$(stat -c '%s' "${EVIDENCE_FILE}")
[[ "${EVIDENCE_BYTES}" =~ ^[1-9][0-9]*$ ]]
test "${EVIDENCE_BYTES}" -le 8388608
EVIDENCE_GZIP_FILE="${RUNTIME_ROOT}/evidence-transport.json.gz"
gzip -n -9 -c -- "${EVIDENCE_FILE}" > "${EVIDENCE_GZIP_FILE}"
EVIDENCE_GZIP_BYTES=$(stat -c '%s' "${EVIDENCE_GZIP_FILE}")
[[ "${EVIDENCE_GZIP_BYTES}" =~ ^[1-9][0-9]*$ ]]
test "${EVIDENCE_GZIP_BYTES}" -le 9437184
printf 'AQUA_WALG_EVIDENCE_GZIP_B64='
base64 -w0 "${EVIDENCE_GZIP_FILE}"
printf '\n'
rm -f -- "${EVIDENCE_GZIP_FILE}"
