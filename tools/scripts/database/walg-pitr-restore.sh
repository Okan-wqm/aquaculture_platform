#!/usr/bin/env bash
# Restore one explicit WAL-G base backup into a positively attested disposable
# container. The command creates its own immutable BEFORE/AFTER source
# sentinels, derives the timestamp target from the source PostgreSQL clock,
# waits for the AFTER WAL segment to archive, and proves the full canonical
# database-verification contract on the promoted target.

set +x
set -euo pipefail
umask 077
export LC_ALL=C

SOURCE_CONTAINER="${POSTGRES_CONTAINER:-aqua-postgres}"
TARGET_CONTAINER="${TARGET_CONTAINER:?TARGET_CONTAINER required}"
SOURCE_CONTAINER_NAME="${SOURCE_CONTAINER}"
TARGET_CONTAINER_NAME="${TARGET_CONTAINER}"
TARGET_PGDATA_VOLUME="${TARGET_PGDATA_VOLUME:?TARGET_PGDATA_VOLUME required}"
TARGET_NETWORK="${TARGET_NETWORK:?TARGET_NETWORK required}"
TARGET_WALG_SECRET_SOURCE="${TARGET_WALG_SECRET_SOURCE:?TARGET_WALG_SECRET_SOURCE required}"
BACKUP_NAME="${BACKUP_NAME:?BACKUP_NAME required}"
EXPECTED_SOURCE_SYSTEM_IDENTIFIER="${EXPECTED_SOURCE_SYSTEM_IDENTIFIER:?EXPECTED_SOURCE_SYSTEM_IDENTIFIER required}"
SOURCE_POSTGRES_USER="${SOURCE_POSTGRES_USER:-aquaculture}"
SOURCE_POSTGRES_DB="${SOURCE_POSTGRES_DB:-aquaculture}"
TARGET_POSTGRES_USER="${TARGET_POSTGRES_USER:-aquaculture}"
TARGET_POSTGRES_DB="${TARGET_POSTGRES_DB:-aquaculture}"
TARGET_POSTGRES_PORT="${TARGET_POSTGRES_PORT:-55432}"
MAX_RPO_SECONDS="${MAX_RPO_SECONDS:-300}"
MAX_RTO_SECONDS="${MAX_RTO_SECONDS:-3600}"
PSQL_TIMEOUT_SECONDS="${PSQL_TIMEOUT_SECONDS:-30}"
CONTROL_TIMEOUT_SECONDS="${CONTROL_TIMEOUT_SECONDS:-60}"
WALG_RUNTIME_COMMAND="${WALG_RUNTIME_COMMAND:-/usr/local/bin/walg-runtime-command.sh}"
WALG_EVIDENCE_DIR="${WALG_EVIDENCE_DIR:?WALG_EVIDENCE_DIR required}"
EVIDENCE_RUN_ID="${EVIDENCE_RUN_ID:?EVIDENCE_RUN_ID required}"
MAIN_SHA="${MAIN_SHA:?MAIN_SHA required}"
EXPECTED_POSTGRES_DR_CONTRACT_SHA256="${EXPECTED_POSTGRES_DR_CONTRACT_SHA256:?EXPECTED_POSTGRES_DR_CONTRACT_SHA256 required}"
PITR_RESET_TARGET="${PITR_RESET_TARGET:-false}"
DATABASE_VERIFICATION_SQL="${DATABASE_VERIFICATION_SQL:-tools/scripts/database/database-verification.sql}"

RESTORE_ROLE='isolated-drill'
RESTORE_LABEL='com.aqua-saas.restore.role'
RESTORE_RUN_LABEL='com.aqua-saas.restore.run-id'
EXPECTED_WALG_REVISION='f81943e64bdf97aa66f6c52fec55114703f97af7'
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SECONDS=0
EVIDENCE_PATH=''
EVIDENCE_WRITTEN=false
FAILURE_STAGE='preflight'
TARGET_POSTGRES_STARTED=false
ISOLATED_TARGET_ATTESTED=false
WAL_VERIFIED=false
BEFORE_SENTINEL_PRESENT=false
AFTER_SENTINEL_PRESENT=false
PROMOTED=false
DATABASE_VERIFIED=false
RPO_SECONDS=0
RTO_SECONDS=0
ARCHIVE_WAIT_SECONDS=0
ARCHIVE_OBSERVED_AT=''
RECOVERY_TARGET_TIME=''
FAILURE_TIME=''
SOURCE_BEFORE_RECORDED_AT=''
SOURCE_BEFORE_RECORDED_LSN=''
SOURCE_BEFORE_COMMIT_FENCE_AT=''
SOURCE_BEFORE_COMMIT_FENCE_LSN=''
SOURCE_AFTER_RECORDED_AT=''
SOURCE_AFTER_RECORDED_LSN=''
SOURCE_AFTER_COMMIT_FENCE_AT=''
SOURCE_AFTER_COMMIT_FENCE_LSN=''
SOURCE_TIMELINE_ID=''
RESTORED_BEFORE_RECORDED_AT=''
RESTORED_BEFORE_RECORDED_LSN=''
ARCHIVED_THROUGH_WAL=''
ARCHIVE_REQUIRED_WAL=''
SOURCE_SYSTEM_IDENTIFIER=''
RESTORED_SYSTEM_IDENTIFIER=''
SOURCE_IMAGE_ID=''
SOURCE_IMAGE_REVISION=''
SOURCE_POSTGRES_DR_CONTRACT_SHA256=''
SOURCE_WALG_REVISION=''
DATABASE_VERIFICATION_SHA256=''
TARGET_READ_ONLY_ROOTFS=false
WALG_CONFIG_SHA256=''
WALG_ROTATION_BUNDLE_SHA256=''
SOURCE_INITIAL_WALG_ROTATION_BUNDLE_SHA256=''
TARGET_SOCKET_DIR="/tmp/aqua-walg-pitr-${EVIDENCE_RUN_ID}"
TMP_DIR=''

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

is_evidence_timestamp() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$ ]] &&
    date -u -d "$1" +%s%N >/dev/null 2>&1
}

validate_sentinel_result() {
  node -e '
    const value = process.argv[1];
    const timestamp = "[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z";
    const lsn = "[0-9A-F]+/[0-9A-F]{1,8}";
    const wal = "[0-9A-F]{24}";
    if (!(new RegExp(`^${timestamp}\\|${lsn}\\|${timestamp}\\|${lsn}\\|${wal}$`)).test(value)) process.exit(2);
  ' "$1" || die 'sentinel protocol did not return exactly five canonical fields.'
}

for container_name in "${SOURCE_CONTAINER}" "${TARGET_CONTAINER}"; do
  [[ "${container_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'container name contains unsafe characters.'
done
if [ "${SOURCE_CONTAINER}" = "${TARGET_CONTAINER}" ]; then
  die 'source and target containers must be different.'
fi
for docker_name in "${TARGET_PGDATA_VOLUME}" "${TARGET_NETWORK}"; do
  [[ "${docker_name}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || die 'Docker volume/network name contains unsafe characters.'
done
if [[ "${TARGET_WALG_SECRET_SOURCE}" != /* ]] || \
   [[ "${TARGET_WALG_SECRET_SOURCE}" == *$'\n'* ]] || \
   [[ "${TARGET_WALG_SECRET_SOURCE}" == *$'\r'* ]] || \
   [[ "${TARGET_WALG_SECRET_SOURCE}" == *'//'* ]] || \
   [[ "${TARGET_WALG_SECRET_SOURCE}" == */ ]] || \
   [[ "/${TARGET_WALG_SECRET_SOURCE#/}/" == *'/./'* ]] || \
   [[ "/${TARGET_WALG_SECRET_SOURCE#/}/" == *'/../'* ]]; then
  die 'TARGET_WALG_SECRET_SOURCE must be a canonical absolute path.'
fi
if [[ ! "${EVIDENCE_RUN_ID}" =~ ^[A-Za-z0-9._:-]+$ ]]; then
  die 'EVIDENCE_RUN_ID contains unsafe characters.'
fi
if [[ ! "${MAIN_SHA}" =~ ^[0-9a-f]{40}$ ]]; then
  die 'MAIN_SHA must be a lowercase 40-character Git SHA.'
fi
if [[ ! "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  die 'EXPECTED_POSTGRES_DR_CONTRACT_SHA256 must be a lowercase SHA-256 digest.'
fi
if [[ ! "${EXPECTED_SOURCE_SYSTEM_IDENTIFIER}" =~ ^[0-9]{10,24}$ ]]; then
  die 'EXPECTED_SOURCE_SYSTEM_IDENTIFIER must be a numeric PostgreSQL system identifier.'
fi
if [[ ! "${BACKUP_NAME}" =~ ^base_[A-Za-z0-9._:-]+$ ]]; then
  die 'BACKUP_NAME must be one explicit WAL-G base_* name.'
fi
case "${BACKUP_NAME}" in LATEST|latest) die 'LATEST is forbidden.' ;; esac
for identifier in \
  "${SOURCE_POSTGRES_USER}" "${SOURCE_POSTGRES_DB}" \
  "${TARGET_POSTGRES_USER}" "${TARGET_POSTGRES_DB}"; do
  [[ "${identifier}" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die 'database identifiers must be lowercase PostgreSQL identifiers.'
done
for bounded_value in \
  "${MAX_RPO_SECONDS}" "${MAX_RTO_SECONDS}" "${TARGET_POSTGRES_PORT}" \
  "${PSQL_TIMEOUT_SECONDS}" "${CONTROL_TIMEOUT_SECONDS}"; do
  [[ "${bounded_value}" =~ ^[1-9][0-9]*$ ]] || die 'RPO, RTO, and port values must be positive integers.'
done
if [ "${MAX_RPO_SECONDS}" -gt 300 ] || [ "${MAX_RTO_SECONDS}" -gt 3600 ]; then
  die 'RPO cannot exceed 300 seconds and RTO cannot exceed 3600 seconds.'
fi
if [ "${TARGET_POSTGRES_PORT}" -lt 1024 ] || [ "${TARGET_POSTGRES_PORT}" -gt 65535 ]; then
  die 'TARGET_POSTGRES_PORT must be between 1024 and 65535.'
fi
if [ "${PITR_RESET_TARGET}" != 'true' ]; then
  die 'PITR_RESET_TARGET=true is required before erasing the attested drill target.'
fi
if [ ! -f "${DATABASE_VERIFICATION_SQL}" ] || [ -L "${DATABASE_VERIFICATION_SQL}" ]; then
  die 'DATABASE_VERIFICATION_SQL must be a regular non-symlink file.'
fi
for required_command in awk base64 date docker find node readlink sed sha256sum timeout; do
  command -v "${required_command}" >/dev/null 2>&1 || die "${required_command} is required."
done

RESOLVED_TARGET_WALG_SECRET_SOURCE=$(readlink -f -- "${TARGET_WALG_SECRET_SOURCE}") || \
  die 'TARGET_WALG_SECRET_SOURCE must resolve to an existing directory.'
if [ "${RESOLVED_TARGET_WALG_SECRET_SOURCE}" != "${TARGET_WALG_SECRET_SOURCE}" ] || \
   [ ! -d "${TARGET_WALG_SECRET_SOURCE}" ] || [ -L "${TARGET_WALG_SECRET_SOURCE}" ]; then
  die 'TARGET_WALG_SECRET_SOURCE and every ancestor must be a direct non-symlink directory path.'
fi
if [ "${TARGET_WALG_SECRET_SOURCE}" = '/var/aqua-saas/certs/wal-g/postgres' ]; then
  die 'PITR target must not mount the production WAL-G write-credential source.'
fi
unset RESOLVED_TARGET_WALG_SECRET_SOURCE

mkdir -p "${WALG_EVIDENCE_DIR}"
EVIDENCE_PATH="${WALG_EVIDENCE_DIR}/timestamp-pitr-${EVIDENCE_RUN_ID}.json"
if [ -e "${EVIDENCE_PATH}" ]; then
  die "refusing to overwrite evidence: ${EVIDENCE_PATH}"
fi
TMP_DIR=$(mktemp -d -t walg-pitr-XXXXXX)

source_psql() {
  timeout --foreground --kill-after=5s "${PSQL_TIMEOUT_SECONDS}s" \
    docker exec --user postgres -i "${SOURCE_CONTAINER}" \
    psql -X -qAt \
      -U "${SOURCE_POSTGRES_USER}" \
      -d "${SOURCE_POSTGRES_DB}" \
      -v ON_ERROR_STOP=1 "$@"
}

target_psql() {
  timeout --foreground --kill-after=5s "${PSQL_TIMEOUT_SECONDS}s" \
    docker exec --user postgres -i "${TARGET_CONTAINER}" \
    psql -X -qAt \
      -h "${TARGET_SOCKET_DIR}" \
      -p "${TARGET_POSTGRES_PORT}" \
      -U "${TARGET_POSTGRES_USER}" \
      -d "${TARGET_POSTGRES_DB}" \
      -v ON_ERROR_STOP=1 "$@"
}

target_psql_with_rto_budget() {
  local remaining
  remaining=$(remaining_rto_seconds)
  timeout --foreground --kill-after=30s "${remaining}s" \
    docker exec --user postgres -i "${TARGET_CONTAINER}" \
    psql -X -qAt \
      -h "${TARGET_SOCKET_DIR}" \
      -p "${TARGET_POSTGRES_PORT}" \
      -U "${TARGET_POSTGRES_USER}" \
      -d "${TARGET_POSTGRES_DB}" \
      -v ON_ERROR_STOP=1 "$@"
}

container_walg_config_sha256() {
  timeout --foreground --kill-after=5s "${CONTROL_TIMEOUT_SECONDS}s" \
    docker exec --user postgres "$1" bash -ceu '
    : "${WALG_BACKUP_EPOCH:?WALG_BACKUP_EPOCH required}"
    : "${WALG_S3_PREFIX:?WALG_S3_PREFIX required}"
    : "${WALG_S3_ENDPOINT:?WALG_S3_ENDPOINT required}"
    : "${WALG_S3_REGION:?WALG_S3_REGION required}"
    printf "%s\0%s\0%s\0%s\0%s\0" \
      "${WALG_BACKUP_EPOCH}" "${WALG_S3_PREFIX}" "${WALG_S3_ENDPOINT}" "${WALG_S3_REGION}" \
      "${AWS_S3_FORCE_PATH_STYLE:-true}" | sha256sum | \
      while read -r hash _; do printf "%s\n" "${hash}"; done
  '
}

container_walg_rotation_bundle_sha256() {
  timeout --foreground --kill-after=5s "${CONTROL_TIMEOUT_SECONDS}s" \
    docker exec --user postgres "$1" bash -ceu '
    secret_dir=/run/aqua-walg-secrets
    for epoch_file in libsodium.key walg_backup_epoch walg_s3_prefix; do
      [ -f "${secret_dir}/${epoch_file}" ] && [ ! -L "${secret_dir}/${epoch_file}" ]
    done
    cd "${secret_dir}"
    sha256sum libsodium.key walg_backup_epoch walg_s3_prefix | sha256sum | \
      while read -r hash _; do printf "%s\n" "${hash}"; done
  '
}

remaining_rto_seconds() {
  local remaining=$(( MAX_RTO_SECONDS - SECONDS ))
  if [ "${remaining}" -lt 1 ]; then
    die 'no RTO budget remains for the next recovery operation.'
  fi
  printf '%s' "${remaining}"
}

write_evidence() {
  local status=$1
  local completed_at
  local temp_evidence

  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  RTO_SECONDS=${SECONDS}
  temp_evidence="${EVIDENCE_PATH}.next.$$"
  node - \
    "${temp_evidence}" "${status}" "${EVIDENCE_RUN_ID}" "${MAIN_SHA}" \
    "${STARTED_AT}" "${completed_at}" "${BACKUP_NAME}" \
    "${RECOVERY_TARGET_TIME}" "${FAILURE_TIME}" \
    "${SOURCE_BEFORE_RECORDED_AT}" "${SOURCE_BEFORE_RECORDED_LSN}" \
    "${SOURCE_BEFORE_COMMIT_FENCE_AT}" "${SOURCE_BEFORE_COMMIT_FENCE_LSN}" \
    "${SOURCE_AFTER_RECORDED_AT}" "${SOURCE_AFTER_RECORDED_LSN}" \
    "${SOURCE_AFTER_COMMIT_FENCE_AT}" "${SOURCE_AFTER_COMMIT_FENCE_LSN}" \
    "${RESTORED_BEFORE_RECORDED_AT}" "${RESTORED_BEFORE_RECORDED_LSN}" \
    "${RPO_SECONDS}" "${RTO_SECONDS}" "${ARCHIVE_WAIT_SECONDS}" \
    "${ARCHIVE_OBSERVED_AT}" \
    "${ARCHIVE_REQUIRED_WAL}" "${ARCHIVED_THROUGH_WAL}" "${SOURCE_TIMELINE_ID}" \
    "${SOURCE_SYSTEM_IDENTIFIER}" "${RESTORED_SYSTEM_IDENTIFIER}" \
    "${SOURCE_IMAGE_ID}" "${SOURCE_IMAGE_REVISION}" "${SOURCE_POSTGRES_DR_CONTRACT_SHA256}" \
    "${SOURCE_WALG_REVISION}" \
    "${TARGET_PGDATA_VOLUME}" "${TARGET_NETWORK}" \
    "${ISOLATED_TARGET_ATTESTED}" "${WAL_VERIFIED}" \
    "${BEFORE_SENTINEL_PRESENT}" "${AFTER_SENTINEL_PRESENT}" \
    "${PROMOTED}" "${DATABASE_VERIFIED}" "${DATABASE_VERIFICATION_SHA256}" \
    "${TARGET_READ_ONLY_ROOTFS}" \
    "${WALG_CONFIG_SHA256}" "${WALG_ROTATION_BUNDLE_SHA256}" \
    "${FAILURE_STAGE}" "${TMP_DIR}/database-verification.canonical.json" <<'NODE'
const fs = require('node:fs');
const [
  outputPath, status, runId, mainSha, startedAt, completedAt, backupName,
  recoveryTargetTime, failureTime,
  sourceBeforeRecordedAt, sourceBeforeRecordedLsn,
  sourceBeforeCommitFenceAt, sourceBeforeCommitFenceLsn,
  sourceAfterRecordedAt, sourceAfterRecordedLsn,
  sourceAfterCommitFenceAt, sourceAfterCommitFenceLsn,
  restoredBeforeRecordedAt, restoredBeforeRecordedLsn,
  rpoSeconds, rtoSeconds, archiveWaitSeconds, archiveObservedAt,
  archiveRequiredWal, archivedThroughWal, sourceTimelineId,
  sourceSystemIdentifier, restoredSystemIdentifier,
  sourceImageId, sourceImageRevision, sourcePostgresDrContractSha256, sourceWalgRevision,
  targetPgdataVolume, targetNetwork,
  isolatedTargetAttested, walVerified, beforeSentinelPresent,
  afterSentinelPresent, promoted, databaseVerified, databaseVerificationSha256,
  targetReadOnlyRootfs, walgConfigSha256, walgRotationBundleSha256,
  failureStage, databaseVerificationPath,
] = process.argv.slice(2);
const succeeded = status === 'success';
let databaseVerification = null;
if (succeeded) {
  databaseVerification = JSON.parse(fs.readFileSync(databaseVerificationPath, 'utf8'));
}
const record = {
  schema_version: 1,
  evidence_type: 'timestamp_pitr',
  run_id: runId,
  status,
  main_sha: mainSha,
  started_at: startedAt,
  completed_at: completedAt,
  backup_name: backupName,
  recovery_target_time: recoveryTargetTime || null,
  failure_time: failureTime || null,
  source_before_sentinel_recorded_at: sourceBeforeRecordedAt || null,
  source_after_sentinel_recorded_at: sourceAfterRecordedAt || null,
  restored_before_sentinel_recorded_at: restoredBeforeRecordedAt || null,
  source_before_sentinel_recorded_lsn: sourceBeforeRecordedLsn || null,
  source_after_sentinel_recorded_lsn: sourceAfterRecordedLsn || null,
  restored_before_sentinel_recorded_lsn: restoredBeforeRecordedLsn || null,
  source_before_commit_fence_at: sourceBeforeCommitFenceAt || null,
  source_before_commit_fence_lsn: sourceBeforeCommitFenceLsn || null,
  source_after_commit_fence_at: sourceAfterCommitFenceAt || null,
  source_after_commit_fence_lsn: sourceAfterCommitFenceLsn || null,
  timestamp_recovery: succeeded,
  rpo_seconds: Number(rpoSeconds),
  rto_seconds: Number(rtoSeconds),
  archive_wait_seconds: Number(archiveWaitSeconds),
  archive_observed_at: archiveObservedAt || null,
  archive_required_wal: archiveRequiredWal || null,
  archived_through_wal: archivedThroughWal || null,
  source_timeline_id: sourceTimelineId ? Number(sourceTimelineId) : null,
  source_system_identifier: sourceSystemIdentifier || null,
  restored_system_identifier: restoredSystemIdentifier || null,
  source_image_id: sourceImageId || null,
  source_image_revision: sourceImageRevision || null,
  source_postgres_dr_contract_sha256: sourcePostgresDrContractSha256 || null,
  source_wal_g_revision: sourceWalgRevision || null,
  target_pgdata_volume: targetPgdataVolume,
  target_network: targetNetwork,
  isolated_target_attested: isolatedTargetAttested === 'true',
  wal_verified: walVerified === 'true',
  before_sentinel_present: beforeSentinelPresent === 'true',
  after_sentinel_present: afterSentinelPresent === 'true',
  promoted: promoted === 'true',
  database_verified: databaseVerified === 'true',
  database_verification_sha256: databaseVerificationSha256 || null,
  database_verification: databaseVerification,
  target_read_only_rootfs: targetReadOnlyRootfs === 'true',
  walg_config_sha256: walgConfigSha256 || null,
  walg_rotation_bundle_sha256: walgRotationBundleSha256 || null,
  failure_stage: succeeded ? null : failureStage,
};
fs.writeFileSync(outputPath, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
NODE
  mv "${temp_evidence}" "${EVIDENCE_PATH}"
  EVIDENCE_WRITTEN=true
}

stop_target_postgres() {
  if [ "${TARGET_POSTGRES_STARTED}" = 'true' ]; then
    timeout --foreground --kill-after=10s "${CONTROL_TIMEOUT_SECONDS}s" \
      docker exec --user postgres "${TARGET_CONTAINER}" bash -ceu \
        'pg_ctl -D "${PGDATA:?PGDATA required}" -m fast -w stop' >/dev/null
    TARGET_POSTGRES_STARTED=false
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  stop_target_postgres || true
  if [ "${EVIDENCE_WRITTEN}" != 'true' ] && [ -n "${EVIDENCE_PATH}" ] && [ ! -e "${EVIDENCE_PATH}" ]; then
    write_evidence failure || true
  fi
  if [ -n "${TMP_DIR}" ] && [ -d "${TMP_DIR}" ]; then
    rm -rf -- "${TMP_DIR}"
  fi
  exit "${status}"
}
trap cleanup EXIT

FAILURE_STAGE='container-attestation'
for running_container in "${SOURCE_CONTAINER}" "${TARGET_CONTAINER}"; do
  if [ "$(docker inspect --format '{{.State.Running}}' "${running_container}" 2>/dev/null || true)" != 'true' ]; then
    die "required container is not running: ${running_container}"
  fi
done
SOURCE_CONTAINER=$(docker inspect --format '{{.Id}}' "${SOURCE_CONTAINER_NAME}")
TARGET_CONTAINER=$(docker inspect --format '{{.Id}}' "${TARGET_CONTAINER_NAME}")
if [[ ! "${SOURCE_CONTAINER}" =~ ^[0-9a-f]{64}$ ]] || \
   [[ ! "${TARGET_CONTAINER}" =~ ^[0-9a-f]{64}$ ]] || \
   [ "${SOURCE_CONTAINER}" = "${TARGET_CONTAINER}" ]; then
  die 'source/target immutable container IDs are invalid.'
fi
SOURCE_COMPOSE_SERVICE=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "${SOURCE_CONTAINER}")
SOURCE_COMPOSE_WORKING_DIR=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "${SOURCE_CONTAINER}")
SOURCE_COMPOSE_CONFIG_FILES=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.config_files" }}' "${SOURCE_CONTAINER}")
SOURCE_COMPOSE_ONEOFF=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.oneoff" }}' "${SOURCE_CONTAINER}")
TARGET_COMPOSE_SERVICE=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "${TARGET_CONTAINER}")
TARGET_ROLE=$(docker inspect --format '{{ index .Config.Labels "com.aqua-saas.restore.role" }}' "${TARGET_CONTAINER}")
TARGET_RUN=$(docker inspect --format '{{ index .Config.Labels "com.aqua-saas.restore.run-id" }}' "${TARGET_CONTAINER}")
if [ "${SOURCE_COMPOSE_SERVICE}" != 'postgres' ] || \
   [ "${SOURCE_COMPOSE_WORKING_DIR}" != '/var/aqua-saas' ] || \
   [[ "${SOURCE_COMPOSE_CONFIG_FILES}" != *'/var/aqua-saas/docker-compose.droplet.yml'* ]] || \
   [ "${SOURCE_COMPOSE_ONEOFF}" != 'False' ]; then
  die 'source container is not the canonical production Compose postgres service.'
fi
if [ "${TARGET_COMPOSE_SERVICE}" = 'postgres' ] || \
   [ "${TARGET_ROLE}" != "${RESTORE_ROLE}" ] || [ "${TARGET_RUN}" != "${EVIDENCE_RUN_ID}" ]; then
  die "target lacks ${RESTORE_LABEL}=${RESTORE_ROLE} and run-scoped restore attestation."
fi

SOURCE_PORTS=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${SOURCE_CONTAINER}")
TARGET_PORTS=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${TARGET_CONTAINER}")
node - "${SOURCE_PORTS}" "${TARGET_PORTS}" <<'NODE'
for (const [label, raw] of [['source', process.argv[2]], ['target', process.argv[3]]]) {
  const ports = JSON.parse(raw);
  const published = Object.entries(ports ?? {}).filter(([, bindings]) => Array.isArray(bindings) && bindings.length > 0);
  if (published.length > 0) throw new Error(`${label} publishes a database port`);
}
NODE

SOURCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' "${SOURCE_CONTAINER}")
TARGET_IMAGE_ID=$(docker inspect --format '{{.Image}}' "${TARGET_CONTAINER}")
if [ "${SOURCE_IMAGE_ID}" != "${TARGET_IMAGE_ID}" ]; then
  die 'source and target must use the exact same immutable image ID.'
fi
SOURCE_IMAGE_REVISION=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${SOURCE_IMAGE_ID}")
SOURCE_POSTGRES_DR_CONTRACT_SHA256=$(docker image inspect --format '{{ index .Config.Labels "io.aquaculture.postgres.dr-contract-sha256" }}' "${SOURCE_IMAGE_ID}")
SOURCE_WALG_REVISION=$(docker image inspect --format '{{ index .Config.Labels "io.aquaculture.wal-g.revision" }}' "${SOURCE_IMAGE_ID}")
if [[ ! "${SOURCE_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
   [[ ! "${SOURCE_IMAGE_REVISION}" =~ ^[0-9a-f]{40}$ ]] || \
   [ "${SOURCE_IMAGE_REVISION}" = '0000000000000000000000000000000000000000' ] || \
   [ "${SOURCE_POSTGRES_DR_CONTRACT_SHA256}" != "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}" ] || \
   [ "${SOURCE_WALG_REVISION}" != "${EXPECTED_WALG_REVISION}" ]; then
  die 'source/target image provenance, DR contract, or WAL-G revision does not match the protected workflow authority.'
fi

TARGET_HOST_CONFIG=$(docker inspect --format '{{json .HostConfig}}' "${TARGET_CONTAINER}")
TARGET_CONTAINER_CONFIG=$(docker inspect --format '{{json .Config}}' "${TARGET_CONTAINER}")
node - "${TARGET_HOST_CONFIG}" "${TARGET_CONTAINER_CONFIG}" "${TARGET_NETWORK}" <<'NODE'
const config = JSON.parse(process.argv[2]);
const container = JSON.parse(process.argv[3]);
const expectedNetwork = process.argv[4];
if (config?.ReadonlyRootfs !== true) throw new Error('target root filesystem must be read-only');
if (config?.Privileged !== false) throw new Error('target must not be privileged');
if (config?.NetworkMode !== expectedNetwork) throw new Error('target network mode is not the attested run network');
if (config?.RestartPolicy?.Name !== 'no') throw new Error('target restart policy must be disabled');
if (config?.Memory !== 2147483648 || config?.MemorySwap !== 2147483648) throw new Error('target memory limit is not exactly 2 GiB with swap disabled');
if (config?.NanoCpus !== 1000000000 || config?.PidsLimit !== 256) throw new Error('target CPU/PID limits are not exact');
if (Array.isArray(config?.Devices) && config.Devices.length > 0) throw new Error('target cannot receive host devices');
if (Array.isArray(config?.DeviceRequests) && config.DeviceRequests.length > 0) throw new Error('target cannot receive requested devices');
const capDrop = (config?.CapDrop ?? []).map(String).sort();
const capAdd = (config?.CapAdd ?? []).map(String).sort();
if (capDrop.join(',') !== 'ALL') throw new Error('target must drop all ambient Linux capabilities');
if (capAdd.join(',') !== 'CHOWN,DAC_OVERRIDE,FOWNER') throw new Error('target capability allowlist is not exact');
if (!Array.isArray(config?.SecurityOpt) || !config.SecurityOpt.includes('no-new-privileges:true')) {
  throw new Error('target must enforce no-new-privileges');
}
const tmpfs = config?.Tmpfs ?? {};
for (const required of ['/run', '/tmp']) {
  const options = String(tmpfs[required] ?? '');
  if (!options.includes('rw') || !options.includes('noexec') || !options.includes('nosuid') || !options.includes('nodev')) {
    throw new Error(`target ${required} tmpfs is missing mandatory restrictions`);
  }
}
if (Object.keys(tmpfs).sort().join(',') !== '/run,/tmp') throw new Error('target tmpfs set is not exact');
if (container?.User !== 'root') throw new Error('target bootstrap user must be explicit root');
if (JSON.stringify(container?.Entrypoint) !== JSON.stringify(['/bin/bash'])) throw new Error('target entrypoint is not exact');
if (JSON.stringify(container?.Cmd) !== JSON.stringify(['-ceu', 'trap : TERM INT; while :; do sleep 3600; done'])) {
  throw new Error('target PID1 command is not the inert drill supervisor');
}
NODE
TARGET_READ_ONLY_ROOTFS=true

SOURCE_NETWORKS=$(docker inspect --format '{{json .NetworkSettings.Networks}}' "${SOURCE_CONTAINER}")
TARGET_NETWORKS=$(docker inspect --format '{{json .NetworkSettings.Networks}}' "${TARGET_CONTAINER}")
TARGET_ID=$(docker inspect --format '{{.Id}}' "${TARGET_CONTAINER}")
NETWORK_INSPECT=$(docker network inspect "${TARGET_NETWORK}" --format '{{json .}}')
node - "${SOURCE_NETWORKS}" "${TARGET_NETWORKS}" "${NETWORK_INSPECT}" "${TARGET_NETWORK}" "${TARGET_ID}" "${EVIDENCE_RUN_ID}" "${STARTED_AT}" <<'NODE'
const source = Object.keys(JSON.parse(process.argv[2]) ?? {});
const target = Object.keys(JSON.parse(process.argv[3]) ?? {});
const network = JSON.parse(process.argv[4]);
const expectedName = process.argv[5];
const targetId = process.argv[6];
const runId = process.argv[7];
const startedAt = Date.parse(process.argv[8]);
if (target.length !== 1 || target[0] !== expectedName) throw new Error('target must have exactly one run-scoped network');
if (source.includes(expectedName)) throw new Error('source and target share the restore network');
if (String(network?.Options?.['com.docker.network.bridge.enable_icc']) !== 'false') throw new Error('target network ICC must be false');
if (network?.Driver !== 'bridge' || network?.Scope !== 'local' || network?.Internal !== false || network?.Ingress !== false) throw new Error('target network driver/scope boundary is invalid');
if (network?.Labels?.['com.aqua-saas.restore.role'] !== 'isolated-drill' || network?.Labels?.['com.aqua-saas.restore.run-id'] !== runId) throw new Error('target network labels are invalid');
const createdAt = Date.parse(network?.Created ?? '');
if (!Number.isFinite(createdAt) || !Number.isFinite(startedAt) || createdAt < startedAt - 300000 || createdAt > startedAt + 60000) throw new Error('target network was not freshly created for this drill');
const members = Object.keys(network?.Containers ?? {});
if (members.length !== 1 || members[0] !== targetId) throw new Error('target network must contain only the target container');
NODE

FAILURE_STAGE='mount-isolation-attestation'
SOURCE_PGDATA=$(docker exec --user postgres "${SOURCE_CONTAINER}" bash -ceu 'printf "%s" "${PGDATA:?PGDATA required}"')
TARGET_PGDATA=$(docker exec --user postgres "${TARGET_CONTAINER}" bash -ceu 'printf "%s" "${PGDATA:?PGDATA required}"')
SOURCE_MOUNTS=$(docker inspect --format '{{json .Mounts}}' "${SOURCE_CONTAINER}")
TARGET_MOUNTS=$(docker inspect --format '{{json .Mounts}}' "${TARGET_CONTAINER}")
SOURCE_PGDATA_VOLUME=$(node -e '
  const mounts = JSON.parse(process.argv[1]);
  const pgdata = process.argv[2];
  const mount = mounts.find((item) => item.Destination === pgdata && item.RW === true);
  if (!mount || mount.Type !== "volume" || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(mount.Name ?? "")) process.exit(2);
  process.stdout.write(mount.Name);
' "${SOURCE_MOUNTS}" "${SOURCE_PGDATA}")
SOURCE_VOLUME_INSPECT=$(docker volume inspect "${SOURCE_PGDATA_VOLUME}" --format '{{json .}}')
VOLUME_INSPECT=$(docker volume inspect "${TARGET_PGDATA_VOLUME}" --format '{{json .}}')
mapfile -t TARGET_VOLUME_CONTAINERS < <(docker ps --all --no-trunc --quiet --filter "volume=${TARGET_PGDATA_VOLUME}")
if [ "${#TARGET_VOLUME_CONTAINERS[@]}" -ne 1 ] || [ "${TARGET_VOLUME_CONTAINERS[0]}" != "${TARGET_ID}" ]; then
  die 'target PGDATA volume must be attached only to the run-scoped target container.'
fi
node - \
  "${SOURCE_MOUNTS}" "${TARGET_MOUNTS}" "${SOURCE_PGDATA}" "${TARGET_PGDATA}" \
  "${SOURCE_PGDATA_VOLUME}" "${SOURCE_VOLUME_INSPECT}" \
  "${TARGET_PGDATA_VOLUME}" "${VOLUME_INSPECT}" "${EVIDENCE_RUN_ID}" \
  "${TARGET_WALG_SECRET_SOURCE}" "${STARTED_AT}" <<'NODE'
const sourceMounts = JSON.parse(process.argv[2]);
const targetMounts = JSON.parse(process.argv[3]);
const sourcePgdata = process.argv[4];
const targetPgdata = process.argv[5];
const sourceVolumeName = process.argv[6];
const sourceVolume = JSON.parse(process.argv[7]);
const targetVolume = process.argv[8];
const volume = JSON.parse(process.argv[9]);
const runId = process.argv[10];
const expectedSecretSource = process.argv[11];
const startedAt = Date.parse(process.argv[12]);
const sourceData = sourceMounts.find((m) => m.Destination === sourcePgdata && m.RW === true);
const targetData = targetMounts.find((m) => m.Destination === targetPgdata && m.RW === true);
if (!sourceData || sourceData.Type !== 'volume' || sourceData.Name !== sourceVolumeName || !targetData || targetData.Type !== 'volume' || targetData.Name !== targetVolume) throw new Error('source and target require exact named writable PGDATA volumes');
if (sourceData.Source === targetData.Source) throw new Error('source and target share a writable PGDATA mount');
for (const [label, inspected, mounted] of [['source', sourceVolume, sourceData], ['target', volume, targetData]]) {
  if (inspected?.Driver !== 'local' || inspected?.Scope !== 'local') throw new Error(`${label} PGDATA is not a local-scope Docker volume`);
  if (inspected?.Options && Object.keys(inspected.Options).length > 0) throw new Error(`${label} PGDATA volume uses alias-capable driver options`);
  if (inspected?.Mountpoint !== mounted.Source) throw new Error(`${label} PGDATA mountpoint disagrees with volume authority`);
}
if (sourceVolumeName === targetVolume || sourceVolume.Mountpoint === volume.Mountpoint) throw new Error('source and target PGDATA volume authorities are identical');
if (volume?.Labels?.['com.aqua-saas.restore.role'] !== 'isolated-drill' || volume?.Labels?.['com.aqua-saas.restore.run-id'] !== runId) throw new Error('target PGDATA volume labels are invalid');
const volumeCreatedAt = Date.parse(volume?.CreatedAt ?? '');
if (!Number.isFinite(volumeCreatedAt) || !Number.isFinite(startedAt) || volumeCreatedAt < startedAt - 300000 || volumeCreatedAt > startedAt + 60000) throw new Error('target PGDATA volume was not freshly created for this drill');
for (const mount of targetMounts) {
  if (mount === targetData) continue;
  if (mount.Type === 'tmpfs' && ['/run', '/tmp'].includes(mount.Destination)) continue;
  if (
    mount.Type === 'bind' && mount.RW === false &&
    mount.Destination === '/var/lib/postgresql/wal-g-secrets-source' &&
    mount.Source === expectedSecretSource
  ) continue;
  throw new Error(`unexpected target mount: ${mount.Type}:${mount.Destination}:rw=${mount.RW}`);
}
NODE
ISOLATED_TARGET_ATTESTED=true

FAILURE_STAGE='target-pgdata-bootstrap'
TARGET_POSTGRES_UID=$(docker exec --user root "${TARGET_CONTAINER}" id -u postgres)
TARGET_POSTGRES_GID=$(docker exec --user root "${TARGET_CONTAINER}" id -g postgres)
if [[ ! "${TARGET_POSTGRES_UID}" =~ ^[1-9][0-9]*$ ]] || \
   [[ ! "${TARGET_POSTGRES_GID}" =~ ^[1-9][0-9]*$ ]]; then
  die 'target image postgres uid/gid is invalid.'
fi
timeout --foreground --kill-after=10s "${CONTROL_TIMEOUT_SECONDS}s" \
  docker exec --user root "${TARGET_CONTAINER}" bash -ceu '
  pgdata=$1
  postgres_uid=$2
  postgres_gid=$3
  if [ ! -d "${pgdata}" ] || [ -L "${pgdata}" ]; then
    echo "FATAL: fresh target PGDATA is missing or unsafe." >&2
    exit 126
  fi
  if [ -n "$(find "${pgdata}" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo "FATAL: fresh target PGDATA must be empty before ownership bootstrap." >&2
    exit 126
  fi
  chown "${postgres_uid}:${postgres_gid}" "${pgdata}"
  chmod 0700 "${pgdata}"
  [ "$(stat -c "%u:%g:%a" "${pgdata}")" = "${postgres_uid}:${postgres_gid}:700" ]
' bash "${TARGET_PGDATA}" "${TARGET_POSTGRES_UID}" "${TARGET_POSTGRES_GID}"

FAILURE_STAGE='source-identity-attestation'
SOURCE_SYSTEM_IDENTIFIER=$(source_psql -c 'SELECT system_identifier::text FROM pg_control_system();')
if [ "${SOURCE_SYSTEM_IDENTIFIER}" != "${EXPECTED_SOURCE_SYSTEM_IDENTIFIER}" ]; then
  die 'source PostgreSQL system identifier does not match the protected production value.'
fi
if [ "$(source_psql -c "SELECT to_regclass('platform.pitr_drill_sentinels') IS NOT NULL;")" != 't' ]; then
  die 'canonical platform.pitr_drill_sentinels ledger is absent.'
fi
WALG_CONFIG_SHA256=$(container_walg_config_sha256 "${SOURCE_CONTAINER}")
SOURCE_INITIAL_WALG_ROTATION_BUNDLE_SHA256=$(container_walg_rotation_bundle_sha256 "${SOURCE_CONTAINER}")
if [[ ! "${WALG_CONFIG_SHA256}" =~ ^[0-9a-f]{64}$ ]] || \
   [[ ! "${SOURCE_INITIAL_WALG_ROTATION_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  die 'source WAL-G configuration/rotation bundle fingerprint is invalid.'
fi

insert_source_sentinel() {
  local phase=$1
  source_psql \
    -v "drill_run_id=${EVIDENCE_RUN_ID}" \
    -v "phase=${phase}" \
    -v "main_sha=${MAIN_SHA}" \
    -v "backup_name=${BACKUP_NAME}" <<'SQL'
BEGIN;
INSERT INTO platform.pitr_drill_sentinels
  (drill_run_id, phase, main_sha, backup_name)
VALUES
  (:'drill_run_id', :'phase', :'main_sha', :'backup_name');
COMMIT;
SELECT concat_ws('|',
  to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  recorded_lsn::text,
  to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  pg_current_wal_lsn()::text,
  pg_walfile_name(pg_current_wal_lsn()))
FROM platform.pitr_drill_sentinels
WHERE drill_run_id = :'drill_run_id' AND phase = :'phase';
SQL
}

FAILURE_STAGE='before-sentinel-commit'
SOURCE_BEFORE_RESULT=$(insert_source_sentinel BEFORE)
validate_sentinel_result "${SOURCE_BEFORE_RESULT}"
IFS='|' read -r \
  SOURCE_BEFORE_RECORDED_AT SOURCE_BEFORE_RECORDED_LSN \
  SOURCE_BEFORE_COMMIT_FENCE_AT SOURCE_BEFORE_COMMIT_FENCE_LSN BEFORE_WAL_FILE \
  <<< "${SOURCE_BEFORE_RESULT}"

RECOVERY_TARGET_TIME=$(source_psql -c \
  "SELECT to_char((date_trunc('second', clock_timestamp()) + interval '2 seconds') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');")
is_evidence_timestamp "${RECOVERY_TARGET_TIME}" || die 'source database returned an invalid recovery target timestamp.'
TARGET_NS=$(date -u -d "${RECOVERY_TARGET_TIME}" +%s%N)
while true; do
  SOURCE_NOW_NS=$(source_psql -c "SELECT (extract(epoch FROM clock_timestamp()) * 1000000000)::bigint;")
  if [ "${SOURCE_NOW_NS}" -gt "${TARGET_NS}" ]; then
    break
  fi
  if [ "${SECONDS}" -ge "${MAX_RTO_SECONDS}" ]; then
    die 'source clock did not cross the recovery target within the RTO.'
  fi
  sleep 0.2
done

FAILURE_STAGE='after-sentinel-commit'
SOURCE_AFTER_RESULT=$(insert_source_sentinel AFTER)
validate_sentinel_result "${SOURCE_AFTER_RESULT}"
IFS='|' read -r \
  SOURCE_AFTER_RECORDED_AT SOURCE_AFTER_RECORDED_LSN \
  SOURCE_AFTER_COMMIT_FENCE_AT SOURCE_AFTER_COMMIT_FENCE_LSN AFTER_WAL_FILE \
  <<< "${SOURCE_AFTER_RESULT}"
for timestamp_value in \
  "${SOURCE_BEFORE_RECORDED_AT}" "${SOURCE_BEFORE_COMMIT_FENCE_AT}" \
  "${RECOVERY_TARGET_TIME}" "${SOURCE_AFTER_RECORDED_AT}" \
  "${SOURCE_AFTER_COMMIT_FENCE_AT}"; do
  is_evidence_timestamp "${timestamp_value}" || die 'source sentinel protocol returned an invalid timestamp.'
done
BEFORE_NS=$(date -u -d "${SOURCE_BEFORE_RECORDED_AT}" +%s%N)
BEFORE_FENCE_NS=$(date -u -d "${SOURCE_BEFORE_COMMIT_FENCE_AT}" +%s%N)
AFTER_NS=$(date -u -d "${SOURCE_AFTER_RECORDED_AT}" +%s%N)
AFTER_FENCE_NS=$(date -u -d "${SOURCE_AFTER_COMMIT_FENCE_AT}" +%s%N)
if [ "${BEFORE_NS}" -gt "${BEFORE_FENCE_NS}" ] || \
   [ "${BEFORE_FENCE_NS}" -gt "${TARGET_NS}" ] || \
   [ "${TARGET_NS}" -ge "${AFTER_NS}" ] || \
   [ "${AFTER_NS}" -gt "${AFTER_FENCE_NS}" ]; then
  die 'source-proven chronology must be BEFORE commit fence <= target < AFTER commit fence.'
fi
node - \
  "${SOURCE_BEFORE_RECORDED_LSN}" "${SOURCE_BEFORE_COMMIT_FENCE_LSN}" \
  "${SOURCE_AFTER_RECORDED_LSN}" "${SOURCE_AFTER_COMMIT_FENCE_LSN}" <<'NODE'
const values = process.argv.slice(2).map((value) => {
  const match = value.match(/^([0-9A-F]+)\/([0-9A-F]{1,8})$/);
  if (!match) throw new Error('invalid PostgreSQL LSN');
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
});
if (!(values[0] <= values[1] && values[1] <= values[2] && values[2] <= values[3] && values[1] < values[3])) {
  throw new Error('sentinel LSNs must fall within strictly ordered commit fences');
}
NODE
FAILURE_STAGE='wal-archive-fence'
ARCHIVE_WAIT_STARTED=${SECONDS}
ARCHIVE_REQUIRED_WAL="${AFTER_WAL_FILE}"
SOURCE_TIMELINE_ID=$(source_psql -c 'SELECT timeline_id::text FROM pg_control_checkpoint();')
[[ "${SOURCE_TIMELINE_ID}" =~ ^[1-9][0-9]{0,9}$ ]] || die 'source timeline id is invalid.'
source_psql -c 'SELECT pg_switch_wal();' >/dev/null
while true; do
  IFS='|' read -r LAST_ARCHIVED_WAL LAST_FAILED_WAL LAST_FAILED_AFTER_SUCCESS <<< "$(
    source_psql -c "SELECT concat_ws('|', COALESCE(last_archived_wal,''), COALESCE(last_failed_wal,''), COALESCE(last_failed_time > last_archived_time, false)::text) FROM pg_stat_archiver;"
  )"
  if [ "${LAST_FAILED_AFTER_SUCCESS}" = 'true' ]; then
    die "PostgreSQL archiver reports a newer failure at ${LAST_FAILED_WAL}."
  fi
  if [[ "${LAST_ARCHIVED_WAL}" =~ ^[0-9A-F]{24}$ ]] && [[ "${LAST_ARCHIVED_WAL}" > "${AFTER_WAL_FILE}" || "${LAST_ARCHIVED_WAL}" = "${AFTER_WAL_FILE}" ]]; then
    ARCHIVED_THROUGH_WAL="${LAST_ARCHIVED_WAL}"
    break
  fi
  ARCHIVE_WAIT_SECONDS=$(( SECONDS - ARCHIVE_WAIT_STARTED ))
  if [ "${ARCHIVE_WAIT_SECONDS}" -ge "${MAX_RPO_SECONDS}" ]; then
    die 'AFTER sentinel WAL segment was not archived within the RPO budget.'
  fi
  sleep 1
done
ARCHIVE_WAIT_SECONDS=$(( SECONDS - ARCHIVE_WAIT_STARTED ))

# The simulated source-loss boundary is established only after the segment
# containing the AFTER sentinel is durably observable in the archive. From
# this point onward the drill performs no source-dependent operation.
FAILURE_STAGE='source-loss-fence'
WALG_ROTATION_BUNDLE_SHA256=$(container_walg_rotation_bundle_sha256 "${SOURCE_CONTAINER}")
if [ "${WALG_ROTATION_BUNDLE_SHA256}" != "${SOURCE_INITIAL_WALG_ROTATION_BUNDLE_SHA256}" ]; then
  die 'source WAL-G rotation bundle changed during the archive ceremony.'
fi
ARCHIVE_OBSERVED_AT=$(source_psql -c \
  "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"');")
is_evidence_timestamp "${ARCHIVE_OBSERVED_AT}" || die 'source returned an invalid archive observation timestamp.'
FAILURE_TIME="${ARCHIVE_OBSERVED_AT}"
FAILURE_NS=$(date -u -d "${FAILURE_TIME}" +%s%N)
if [ "${AFTER_FENCE_NS}" -gt "${FAILURE_NS}" ]; then
  die 'archive observation precedes the AFTER commit fence.'
fi
RPO_SECONDS=$(( (FAILURE_NS - BEFORE_NS + 999999999) / 1000000000 ))
if [ "${RPO_SECONDS}" -gt "${MAX_RPO_SECONDS}" ]; then
  die "source-proven PITR drill cannot meet RPO (${RPO_SECONDS}s > ${MAX_RPO_SECONDS}s)."
fi

FAILURE_STAGE='target-secret-install'
timeout --foreground --kill-after=10s "${CONTROL_TIMEOUT_SECONDS}s" \
  docker exec --user root "${TARGET_CONTAINER}" /usr/local/bin/walg-load-secrets.sh install
TARGET_WALG_CONFIG_SHA256=$(container_walg_config_sha256 "${TARGET_CONTAINER}")
TARGET_WALG_ROTATION_BUNDLE_SHA256=$(container_walg_rotation_bundle_sha256 "${TARGET_CONTAINER}")
if [ "${TARGET_WALG_CONFIG_SHA256}" != "${WALG_CONFIG_SHA256}" ] || \
   [ "${TARGET_WALG_ROTATION_BUNDLE_SHA256}" != "${WALG_ROTATION_BUNDLE_SHA256}" ]; then
  die 'isolated target WAL-G configuration/rotation bundle differs from the archived source chain.'
fi

FAILURE_STAGE='wal-verify-from-isolated-target'
REMAINING_RTO_SECONDS=$(remaining_rto_seconds)
timeout --foreground --kill-after=30s "${REMAINING_RTO_SECONDS}s" \
  docker exec --user postgres "${TARGET_CONTAINER}" \
  "${WALG_RUNTIME_COMMAND}" wal-verify-at-lsn \
    "${BACKUP_NAME}" "${SOURCE_TIMELINE_ID}" "${SOURCE_AFTER_COMMIT_FENCE_LSN}" \
    > "${TMP_DIR}/wal-verify.json"
node -e '
  const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (result?.integrity?.status !== "OK" || result?.timeline?.status !== "OK") {
    throw new Error("WAL-G wal-verify did not report integrity=OK and timeline=OK");
  }
' "${TMP_DIR}/wal-verify.json"
WAL_VERIFIED=true

FAILURE_STAGE='target-reset'
timeout --foreground --kill-after=10s "${CONTROL_TIMEOUT_SECONDS}s" \
  docker exec --user postgres "${TARGET_CONTAINER}" bash -ceu '
  : "${PGDATA:?PGDATA required}"
  if pg_ctl -D "${PGDATA}" status >/dev/null 2>&1; then
    echo "FATAL: target PostgreSQL is already running." >&2
    exit 126
  fi
  find "${PGDATA}" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  chmod 0700 "${PGDATA}"
'

FAILURE_STAGE='backup-fetch'
REMAINING_RTO_SECONDS=$(remaining_rto_seconds)
timeout --foreground --kill-after=30s "${REMAINING_RTO_SECONDS}s" \
  docker exec --user postgres "${TARGET_CONTAINER}" \
  "${WALG_RUNTIME_COMMAND}" backup-fetch "${BACKUP_NAME}"

FAILURE_STAGE='target-secret-relink'
timeout --foreground --kill-after=10s "${CONTROL_TIMEOUT_SECONDS}s" \
  docker exec --user root "${TARGET_CONTAINER}" /usr/local/bin/walg-load-secrets.sh install
TARGET_WALG_CONFIG_AFTER_FETCH_SHA256=$(container_walg_config_sha256 "${TARGET_CONTAINER}")
TARGET_WALG_ROTATION_BUNDLE_AFTER_FETCH_SHA256=$(container_walg_rotation_bundle_sha256 "${TARGET_CONTAINER}")
if [ "${TARGET_WALG_CONFIG_AFTER_FETCH_SHA256}" != "${WALG_CONFIG_SHA256}" ] || \
   [ "${TARGET_WALG_ROTATION_BUNDLE_AFTER_FETCH_SHA256}" != "${WALG_ROTATION_BUNDLE_SHA256}" ]; then
  die 'isolated target WAL-G configuration/rotation bundle changed before recovery.'
fi

FAILURE_STAGE='recovery-configuration'
timeout --foreground --kill-after=10s "${CONTROL_TIMEOUT_SECONDS}s" \
  docker exec --user postgres "${TARGET_CONTAINER}" bash -ceu '
  target_time=$1
  : "${PGDATA:?PGDATA required}"
  for unsafe_path in "${PGDATA}/standby.signal" "${PGDATA}/recovery.signal"; do
    if [ -e "${unsafe_path}" ] || [ -L "${unsafe_path}" ]; then
      echo "FATAL: fetched backup carries a pre-existing recovery signal: ${unsafe_path}" >&2
      exit 126
    fi
  done
  if [ ! -f "${PGDATA}/backup_label" ] || [ -L "${PGDATA}/backup_label" ]; then
    echo "FATAL: fetched physical backup omits a safe backup_label." >&2
    exit 126
  fi
  if [ -s "${PGDATA}/tablespace_map" ]; then
    echo "FATAL: fetched backup declares tablespaces outside the isolated PGDATA volume." >&2
    exit 126
  fi
  for parameter in \
    primary_conninfo primary_slot_name restore_command recovery_target \
    recovery_target_name recovery_target_time recovery_target_xid recovery_target_lsn; do
    configured_value=$(postgres -D "${PGDATA}" -C "${parameter}")
    if [ -n "${configured_value}" ]; then
      echo "FATAL: fetched backup carries stale ${parameter} recovery configuration." >&2
      exit 126
    fi
  done
  if [ ! -f "${PGDATA}/postgresql.auto.conf" ] || [ -L "${PGDATA}/postgresql.auto.conf" ]; then
    echo "FATAL: postgresql.auto.conf is missing or unsafe." >&2
    exit 126
  fi
  touch "${PGDATA}/recovery.signal"
  chmod 0600 "${PGDATA}/recovery.signal"
  {
    printf "\n# Aqua isolated timestamp PITR drill\n"
    printf "restore_command = '\''/usr/local/bin/walg-restore-command.sh %%f %%p'\''\n"
    printf "recovery_target_time = '\''%s'\''\n" "${target_time}"
    printf "recovery_target_inclusive = '\''true'\''\n"
    printf "recovery_target_timeline = '\''latest'\''\n"
    printf "recovery_target_action = '\''promote'\''\n"
  } >> "${PGDATA}/postgresql.auto.conf"
' bash "${RECOVERY_TARGET_TIME}"

FAILURE_STAGE='postgres-start-and-recovery'
REMAINING_RTO_SECONDS=$(remaining_rto_seconds)
TARGET_POSTGRES_STARTED=true
timeout --foreground --kill-after=30s "${REMAINING_RTO_SECONDS}s" \
  docker exec --user postgres "${TARGET_CONTAINER}" bash -ceu '
  socket_dir=$1
  port=$2
  timeout_seconds=$3
  mkdir -p "${socket_dir}"
  chmod 0700 "${socket_dir}"
  server_options="-c archive_mode=off -c ssl=off -c listen_addresses='\'''\'' -c unix_socket_directories=${socket_dir} -c port=${port}"
  pg_ctl -D "${PGDATA:?PGDATA required}" -l /tmp/aqua-pitr-postgres.log \
    -t "${timeout_seconds}" -o "${server_options}" -w start
' bash "${TARGET_SOCKET_DIR}" "${TARGET_POSTGRES_PORT}" "${REMAINING_RTO_SECONDS}"

FAILURE_STAGE='promotion-verification'
while true; do
  RECOVERY_STATE=$(target_psql -c 'SELECT pg_is_in_recovery();' 2>/dev/null || true)
  if [ "${RECOVERY_STATE}" = 'f' ]; then
    PROMOTED=true
    break
  fi
  if [ "${SECONDS}" -ge "${MAX_RTO_SECONDS}" ]; then
    die 'timestamp recovery did not promote within the RTO budget.'
  fi
  sleep 1
done

FAILURE_STAGE='sentinel-verification'
RESTORED_SYSTEM_IDENTIFIER=$(target_psql -c 'SELECT system_identifier::text FROM pg_control_system();')
if [ "${RESTORED_SYSTEM_IDENTIFIER}" != "${SOURCE_SYSTEM_IDENTIFIER}" ]; then
  die 'restored target system identifier differs from the attested source cluster.'
fi
RESTORED_BEFORE_RESULT=$(
  target_psql -v "drill_run_id=${EVIDENCE_RUN_ID}" -c \
    "SELECT concat_ws('|', to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), recorded_lsn::text) FROM platform.pitr_drill_sentinels WHERE drill_run_id = :'drill_run_id' AND phase = 'BEFORE';"
)
node -e '
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z\|[0-9A-F]+\/[0-9A-F]{1,8}$/.test(process.argv[1])) process.exit(2);
' "${RESTORED_BEFORE_RESULT}" || die 'restored BEFORE sentinel proof is not canonical.'
IFS='|' read -r RESTORED_BEFORE_RECORDED_AT RESTORED_BEFORE_RECORDED_LSN <<< "${RESTORED_BEFORE_RESULT}"
RESTORED_AFTER_COUNT=$(target_psql -v "drill_run_id=${EVIDENCE_RUN_ID}" -c \
  "SELECT count(*) FROM platform.pitr_drill_sentinels WHERE drill_run_id = :'drill_run_id' AND phase = 'AFTER';")
[[ "${RESTORED_AFTER_COUNT}" =~ ^[0-9]+$ ]] || die 'restored AFTER sentinel count is invalid.'
if [ "${RESTORED_BEFORE_RECORDED_AT}" = "${SOURCE_BEFORE_RECORDED_AT}" ] && \
   [ "${RESTORED_BEFORE_RECORDED_LSN}" = "${SOURCE_BEFORE_RECORDED_LSN}" ]; then
  BEFORE_SENTINEL_PRESENT=true
fi
if [ "${RESTORED_AFTER_COUNT}" != '0' ]; then
  AFTER_SENTINEL_PRESENT=true
fi
if [ "${BEFORE_SENTINEL_PRESENT}" != 'true' ] || [ "${AFTER_SENTINEL_PRESENT}" != 'false' ]; then
  die 'PITR sentinel boundary failed: expected before=true and after=false.'
fi

FAILURE_STAGE='canonical-database-verification'
if ! (
  printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
  sed -n '1,$p' "${DATABASE_VERIFICATION_SQL}"
  printf '\nCOMMIT;\n'
) | target_psql_with_rto_budget > "${TMP_DIR}/database-verification.raw" 2> "${TMP_DIR}/database-verification.stderr"; then
  sed 's/^/  verification| /' "${TMP_DIR}/database-verification.stderr" >&2 || true
  die 'restored target failed canonical database verification.'
fi
node - \
  "${TMP_DIR}/database-verification.raw" \
  "${TMP_DIR}/database-verification.canonical.json" \
  "${MAIN_SHA}" <<'NODE'
const fs = require('node:fs');
const [input, output, mainSha] = process.argv.slice(2);
const lines = fs.readFileSync(input, 'utf8').trim().split(/\r?\n/).filter(Boolean);
if (lines.length !== 1) throw new Error('database verification must produce exactly one JSON line');
const value = JSON.parse(lines[0]);
const canonicalSchemas = [
  'auth', 'farm', 'sensor', 'hr', 'messaging', 'hydroponics', 'alert', 'ai',
  'billing', 'notification', 'admin', 'config', 'observability', 'event_store',
  'gateway', 'shared', 'compliance',
];
if (
  !value || typeof value !== 'object' || Array.isArray(value) ||
  value.contract_version !== 1 ||
  JSON.stringify(value.canonical_schemas) !== JSON.stringify(canonicalSchemas) ||
  !Array.isArray(value.tenant_schemas) ||
  !value.release || value.release.git_sha !== mainSha ||
  !value.migration_heads || !Array.isArray(value.migration_heads.schemas) ||
  !Array.isArray(value.migration_heads.tenants) || !Array.isArray(value.sentinels)
) {
  throw new Error('database verification payload shape/release SHA is not canonical');
}
fs.writeFileSync(output, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
NODE
DATABASE_VERIFICATION_SHA256=$(sha256sum "${TMP_DIR}/database-verification.canonical.json" | awk '{print $1}')
DATABASE_VERIFIED=true

FAILURE_STAGE='target-shutdown'
stop_target_postgres
RTO_SECONDS=${SECONDS}
if [ "${RTO_SECONDS}" -gt "${MAX_RTO_SECONDS}" ]; then
  die "verified PITR exceeded RTO (${RTO_SECONDS}s > ${MAX_RTO_SECONDS}s)."
fi

FAILURE_STAGE='final-isolation-attestation'
FINAL_TARGET_ID=$(docker inspect --format '{{.Id}}' "${TARGET_CONTAINER_NAME}")
FINAL_TARGET_RUNNING=$(docker inspect --format '{{.State.Running}}' "${TARGET_CONTAINER_NAME}")
FINAL_NETWORK_INSPECT=$(docker network inspect "${TARGET_NETWORK}" --format '{{json .}}')
mapfile -t FINAL_VOLUME_CONTAINERS < <(docker ps --all --no-trunc --quiet --filter "volume=${TARGET_PGDATA_VOLUME}")
node - \
  "${FINAL_TARGET_ID}" "${TARGET_CONTAINER}" "${FINAL_TARGET_RUNNING}" \
  "${FINAL_NETWORK_INSPECT}" "${TARGET_NETWORK}" \
  "${EVIDENCE_RUN_ID}" "${TARGET_CONTAINER}" \
  "${#FINAL_VOLUME_CONTAINERS[@]}" "${FINAL_VOLUME_CONTAINERS[0]:-}" <<'NODE'
const [
  finalTarget, expectedTarget, targetRunning,
  networkRaw, expectedNetwork, runId, targetId, volumeMemberCount, volumeMember,
] = process.argv.slice(2);
if (finalTarget !== expectedTarget || targetRunning !== 'true') {
  throw new Error('target container identity changed during the drill');
}
const network = JSON.parse(networkRaw);
if (
  network?.Name !== expectedNetwork ||
  network?.Labels?.['com.aqua-saas.restore.run-id'] !== runId ||
  JSON.stringify(Object.keys(network?.Containers ?? {})) !== JSON.stringify([targetId])
) {
  throw new Error('target network isolation changed during the drill');
}
if (volumeMemberCount !== '1' || volumeMember !== targetId) {
  throw new Error('target PGDATA volume attachment changed during the drill');
}
NODE

FAILURE_STAGE='evidence-write'
write_evidence success
printf 'WALG_TIMESTAMP_PITR_VERIFIED backup_name=%s rpo_seconds=%s rto_seconds=%s database_verification_sha256=%s evidence=%s\n' \
  "${BACKUP_NAME}" "${RPO_SECONDS}" "${RTO_SECONDS}" "${DATABASE_VERIFICATION_SHA256}" "${EVIDENCE_PATH}"
