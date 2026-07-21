#!/usr/bin/env bash
# Restore one explicit WAL-G base backup into a positively attested disposable
# container. The command creates immutable, transaction-bound BEFORE/AFTER WAL
# markers without persistent database objects, derives the timestamp target
# from the source PostgreSQL clock, waits for the AFTER commit-fence segment to
# archive, and proves the full canonical database-verification contract on the
# promoted target.

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
PITR_SOURCE_VERIFICATION_LOCKS_SQL="${PITR_SOURCE_VERIFICATION_LOCKS_SQL:-tools/scripts/database/pitr-source-verification-locks.sql}"
BOUNDED_LINE_READER="${BOUNDED_LINE_READER:-tools/scripts/database/read-bounded-line.mjs}"

RESTORE_ROLE='isolated-drill'
RESTORE_LABEL='com.aqua-saas.restore.role'
RESTORE_RUN_LABEL='com.aqua-saas.restore.run-id'
EXPECTED_WALG_REVISION='f81943e64bdf97aa66f6c52fec55114703f97af7'
WAL_MARKER_PREFIX='aqua.pitr.boundary.v1'
WAL_COMMIT_FENCE_PREFIX='aqua.pitr.commit-fence.v1'
MAX_SOURCE_CAPTURE_BYTES=5242880
MAX_DATABASE_VERIFICATION_BYTES=3670016
MAX_LOCK_RELATIONS_BYTES=1048576
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
SECONDS=0
EVIDENCE_PATH=''
EVIDENCE_WRITTEN=false
FAILURE_STAGE='preflight'
TARGET_POSTGRES_STARTED=false
ISOLATED_TARGET_ATTESTED=false
WAL_VERIFIED=false
BEFORE_WAL_MARKER_REPLAYED=false
AFTER_WAL_MARKER_EXCLUDED=false
PROMOTED=false
DATABASE_VERIFIED=false
RPO_SECONDS=0
RTO_SECONDS=0
ARCHIVE_WAIT_SECONDS=0
ARCHIVE_OBSERVED_AT=''
RECOVERY_TARGET_TIME=''
RECOVERY_TARGET_POSTGRES=''
FAILURE_TIME=''
SOURCE_BEFORE_MARKER_CONTENT=''
SOURCE_BEFORE_MARKER_CONTENT_SHA256=''
SOURCE_BEFORE_MARKER_EMITTED_AT=''
SOURCE_BEFORE_MARKER_LSN=''
SOURCE_BEFORE_COMMIT_FENCE_AT=''
SOURCE_BEFORE_COMMIT_FENCE_LSN=''
SOURCE_AFTER_MARKER_CONTENT=''
SOURCE_AFTER_MARKER_CONTENT_SHA256=''
SOURCE_AFTER_MARKER_EMITTED_AT=''
SOURCE_AFTER_MARKER_LSN=''
SOURCE_AFTER_COMMIT_FENCE_AT=''
SOURCE_AFTER_COMMIT_FENCE_LSN=''
SOURCE_TIMELINE_ID=''
ARCHIVED_THROUGH_WAL=''
ARCHIVE_REQUIRED_WAL=''
SOURCE_SYSTEM_IDENTIFIER=''
RESTORED_SYSTEM_IDENTIFIER=''
SOURCE_IMAGE_ID=''
SOURCE_IMAGE_REVISION=''
SOURCE_POSTGRES_DR_CONTRACT_SHA256=''
SOURCE_WALG_REVISION=''
SOURCE_DATABASE_RELEASE_SHA=''
RESTORED_DATABASE_RELEASE_SHA=''
SOURCE_DATABASE_VERIFICATION_SHA256=''
RESTORED_DATABASE_VERIFICATION_SHA256=''
RESTORED_RECOVERY_TARGET_TIME=''
RESTORED_RECOVERY_TARGET_INCLUSIVE=''
RESTORED_RECOVERY_TARGET_TIMELINE=''
RESTORED_RECOVERY_TARGET_ACTION=''
SOURCE_VERIFICATION_SNAPSHOT_ID=''
SOURCE_VERIFICATION_SNAPSHOT_SHA256=''
SOURCE_VERIFICATION_COMPLETED_AT=''
SOURCE_VERIFICATION_FLOOR_LSN=''
SOURCE_VERIFICATION_LOCK_SET_SHA256=''
SOURCE_VERIFICATION_LOCK_COUNT=''
SOURCE_VERIFICATION_LOCK_TIMEOUT_MS=''
SOURCE_VERIFICATION_STATEMENT_TIMEOUT_MS=''
SOURCE_VERIFICATION_IDLE_TIMEOUT_MS=''
RESTORED_REPLAY_LSN=''
TARGET_READ_ONLY_ROOTFS=false
WALG_CONFIG_SHA256=''
WALG_ROTATION_BUNDLE_SHA256=''
SOURCE_INITIAL_WALG_ROTATION_BUNDLE_SHA256=''
TARGET_SOCKET_DIR="/tmp/aqua-walg-pitr-${EVIDENCE_RUN_ID}"
TMP_DIR=''
SOURCE_LOCK_KEEPER_ACTIVE=false
SOURCE_LOCK_KEEPER_PID=''
SOURCE_LOCK_KEEPER_INPUT_FD=''
SOURCE_LOCK_KEEPER_OUTPUT_FD=''

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

is_evidence_timestamp() {
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$ ]] &&
    date -u -d "$1" +%s%N >/dev/null 2>&1
}

canonical_wal_marker_content() {
  local phase=$1
  node -e '
    const [backupName, mainSha, phase, runId] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ backup_name: backupName, main_sha: mainSha, phase, run_id: runId }));
  ' "${BACKUP_NAME}" "${MAIN_SHA}" "${phase}" "${EVIDENCE_RUN_ID}"
}

validate_wal_marker_result() {
  local value=$1
  local expected_content=$2
  node -e '
    const crypto = require("node:crypto");
    const [value, expectedContent, expectedMarkerPrefix, expectedFencePrefix] = process.argv.slice(1);
    const fields = value.split("|");
    const timestamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z$/;
    const lsn = /^[0-9A-F]+\/[0-9A-F]{1,8}$/;
    const wal = /^[0-9A-F]{24}$/;
    const digest = /^[0-9a-f]{64}$/;
    if (
      fields.length !== 9 || fields[0] !== expectedMarkerPrefix ||
      fields[1] !== expectedFencePrefix || fields[2] !== expectedContent ||
      JSON.stringify(JSON.parse(fields[2])) !== fields[2] || !digest.test(fields[3]) ||
      crypto.createHash("sha256").update(fields[2]).digest("hex") !== fields[3] ||
      !timestamp.test(fields[4]) || !lsn.test(fields[5]) ||
      !timestamp.test(fields[6]) || !lsn.test(fields[7]) || !wal.test(fields[8])
    ) process.exit(2);
  ' "${value}" "${expected_content}" "${WAL_MARKER_PREFIX}" \
    "${WAL_COMMIT_FENCE_PREFIX}" || \
    die 'WAL marker protocol did not return its exact canonical record.'
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
if [ ! -f "${PITR_SOURCE_VERIFICATION_LOCKS_SQL}" ] || \
   [ -L "${PITR_SOURCE_VERIFICATION_LOCKS_SQL}" ]; then
  die 'PITR_SOURCE_VERIFICATION_LOCKS_SQL must be a regular non-symlink file.'
fi
if [ ! -f "${BOUNDED_LINE_READER}" ] || [ -L "${BOUNDED_LINE_READER}" ]; then
  die 'BOUNDED_LINE_READER must be a regular non-symlink file.'
fi
for required_command in awk date docker find node readlink sed sha256sum stat timeout; do
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

canonicalize_database_verification() {
  local input_path=$1
  local output_path=$2
  node - "${input_path}" "${output_path}" <<'NODE'
const fs = require('node:fs');
const [input, output] = process.argv.slice(2);
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
  !value.release || typeof value.release !== 'object' || Array.isArray(value.release) ||
  JSON.stringify(Object.keys(value.release).sort()) !== JSON.stringify(['git_sha', 'release_id']) ||
  typeof value.release.release_id !== 'string' || value.release.release_id.length < 1 ||
  value.release.release_id.length > 120 ||
  typeof value.release.git_sha !== 'string' || !/^[0-9a-f]{40}$/.test(value.release.git_sha) ||
  !value.migration_heads || !Array.isArray(value.migration_heads.schemas) ||
  !Array.isArray(value.migration_heads.tenants) || !Array.isArray(value.sentinels)
) {
  throw new Error('database verification payload shape/release SHA is not canonical');
}
fs.writeFileSync(output, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
process.stdout.write(value.release.git_sha);
NODE
}

abort_source_lock_keeper() {
  if [ "${SOURCE_LOCK_KEEPER_ACTIVE}" != 'true' ]; then
    return 0
  fi
  if [[ "${SOURCE_LOCK_KEEPER_INPUT_FD}" =~ ^[0-9]+$ ]]; then
    printf 'ROLLBACK;\n\\q\n' >&"${SOURCE_LOCK_KEEPER_INPUT_FD}" 2>/dev/null || true
    exec {SOURCE_LOCK_KEEPER_INPUT_FD}>&-
  fi
  if [[ "${SOURCE_LOCK_KEEPER_OUTPUT_FD}" =~ ^[0-9]+$ ]]; then
    exec {SOURCE_LOCK_KEEPER_OUTPUT_FD}<&-
  fi
  if [[ "${SOURCE_LOCK_KEEPER_PID}" =~ ^[1-9][0-9]*$ ]]; then
    kill -TERM "${SOURCE_LOCK_KEEPER_PID}" 2>/dev/null || true
    wait "${SOURCE_LOCK_KEEPER_PID}" 2>/dev/null || true
  fi
  SOURCE_LOCK_KEEPER_ACTIVE=false
}

commit_source_lock_keeper() {
  local commit_marker
  [ "${SOURCE_LOCK_KEEPER_ACTIVE}" = 'true' ] || \
    die 'source verification lock keeper is not active at commit.'
  printf 'COMMIT;\n\\echo SOURCE_VERIFICATION_COMMITTED\n\\q\n' \
    >&"${SOURCE_LOCK_KEEPER_INPUT_FD}" || \
    die 'could not commit the source verification lock keeper.'
  if ! IFS= read -r -t "$(remaining_rto_seconds)" \
    -u "${SOURCE_LOCK_KEEPER_OUTPUT_FD}" commit_marker || \
    [ "${commit_marker}" != 'SOURCE_VERIFICATION_COMMITTED' ]; then
    sed 's/^/  source-verification| /' "${TMP_DIR}/source-verification.stderr" >&2 || true
    die 'source verification lock keeper did not confirm COMMIT.'
  fi
  exec {SOURCE_LOCK_KEEPER_INPUT_FD}>&-
  exec {SOURCE_LOCK_KEEPER_OUTPUT_FD}<&-
  if ! wait "${SOURCE_LOCK_KEEPER_PID}"; then
    sed 's/^/  source-verification| /' "${TMP_DIR}/source-verification.stderr" >&2 || true
    die 'source verification lock keeper exited unsuccessfully after COMMIT.'
  fi
  SOURCE_LOCK_KEEPER_ACTIVE=false
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
    "${WAL_MARKER_PREFIX}" "${WAL_COMMIT_FENCE_PREFIX}" \
    "${SOURCE_BEFORE_MARKER_CONTENT}" "${SOURCE_BEFORE_MARKER_CONTENT_SHA256}" \
    "${SOURCE_BEFORE_MARKER_EMITTED_AT}" "${SOURCE_BEFORE_MARKER_LSN}" \
    "${SOURCE_BEFORE_COMMIT_FENCE_AT}" "${SOURCE_BEFORE_COMMIT_FENCE_LSN}" \
    "${SOURCE_AFTER_MARKER_CONTENT}" "${SOURCE_AFTER_MARKER_CONTENT_SHA256}" \
    "${SOURCE_AFTER_MARKER_EMITTED_AT}" "${SOURCE_AFTER_MARKER_LSN}" \
    "${SOURCE_AFTER_COMMIT_FENCE_AT}" "${SOURCE_AFTER_COMMIT_FENCE_LSN}" \
    "${RESTORED_RECOVERY_TARGET_TIME}" "${RESTORED_RECOVERY_TARGET_INCLUSIVE}" \
    "${RESTORED_RECOVERY_TARGET_TIMELINE}" "${RESTORED_RECOVERY_TARGET_ACTION}" \
    "${RPO_SECONDS}" "${RTO_SECONDS}" "${ARCHIVE_WAIT_SECONDS}" \
    "${ARCHIVE_OBSERVED_AT}" \
    "${ARCHIVE_REQUIRED_WAL}" "${ARCHIVED_THROUGH_WAL}" "${SOURCE_TIMELINE_ID}" \
    "${SOURCE_SYSTEM_IDENTIFIER}" "${RESTORED_SYSTEM_IDENTIFIER}" \
    "${SOURCE_IMAGE_ID}" "${SOURCE_IMAGE_REVISION}" "${SOURCE_POSTGRES_DR_CONTRACT_SHA256}" \
    "${SOURCE_WALG_REVISION}" \
    "${TARGET_PGDATA_VOLUME}" "${TARGET_NETWORK}" \
    "${ISOLATED_TARGET_ATTESTED}" "${WAL_VERIFIED}" \
    "${BEFORE_WAL_MARKER_REPLAYED}" "${AFTER_WAL_MARKER_EXCLUDED}" \
    "${PROMOTED}" "${DATABASE_VERIFIED}" \
    "${SOURCE_DATABASE_RELEASE_SHA}" "${RESTORED_DATABASE_RELEASE_SHA}" \
    "${SOURCE_DATABASE_VERIFICATION_SHA256}" \
    "${RESTORED_DATABASE_VERIFICATION_SHA256}" \
    "${SOURCE_VERIFICATION_SNAPSHOT_ID}" "${SOURCE_VERIFICATION_SNAPSHOT_SHA256}" \
    "${SOURCE_VERIFICATION_COMPLETED_AT}" "${SOURCE_VERIFICATION_FLOOR_LSN}" \
    "${SOURCE_VERIFICATION_LOCK_SET_SHA256}" "${SOURCE_VERIFICATION_LOCK_COUNT}" \
    "${SOURCE_VERIFICATION_LOCK_TIMEOUT_MS}" \
    "${SOURCE_VERIFICATION_STATEMENT_TIMEOUT_MS}" \
    "${SOURCE_VERIFICATION_IDLE_TIMEOUT_MS}" \
    "${RESTORED_REPLAY_LSN}" \
    "${TARGET_READ_ONLY_ROOTFS}" \
    "${WALG_CONFIG_SHA256}" "${WALG_ROTATION_BUNDLE_SHA256}" \
    "${FAILURE_STAGE}" \
    "${TMP_DIR}/source-verification-lock-relations.json" \
    "${TMP_DIR}/source-database-verification.canonical.json" \
    "${TMP_DIR}/restored-database-verification.canonical.json" <<'NODE'
const fs = require('node:fs');
const [
  outputPath, status, runId, mainSha, startedAt, completedAt, backupName,
  recoveryTargetTime, failureTime,
  walMarkerPrefix, walCommitFencePrefix,
  sourceBeforeMarkerContent, sourceBeforeMarkerContentSha256,
  sourceBeforeMarkerEmittedAt, sourceBeforeMarkerLsn,
  sourceBeforeCommitFenceAt, sourceBeforeCommitFenceLsn,
  sourceAfterMarkerContent, sourceAfterMarkerContentSha256,
  sourceAfterMarkerEmittedAt, sourceAfterMarkerLsn,
  sourceAfterCommitFenceAt, sourceAfterCommitFenceLsn,
  restoredRecoveryTargetTime, restoredRecoveryTargetInclusive,
  restoredRecoveryTargetTimeline, restoredRecoveryTargetAction,
  rpoSeconds, rtoSeconds, archiveWaitSeconds, archiveObservedAt,
  archiveRequiredWal, archivedThroughWal, sourceTimelineId,
  sourceSystemIdentifier, restoredSystemIdentifier,
  sourceImageId, sourceImageRevision, sourcePostgresDrContractSha256, sourceWalgRevision,
  targetPgdataVolume, targetNetwork,
  isolatedTargetAttested, walVerified, beforeWalMarkerReplayed,
  afterWalMarkerExcluded, promoted, databaseVerified,
  sourceDatabaseReleaseSha, restoredDatabaseReleaseSha,
  sourceDatabaseVerificationSha256, restoredDatabaseVerificationSha256,
  sourceVerificationSnapshotId, sourceVerificationSnapshotSha256,
  sourceVerificationCompletedAt,
  sourceVerificationFloorLsn, sourceVerificationLockSetSha256,
  sourceVerificationLockCount, sourceVerificationLockTimeoutMs,
  sourceVerificationStatementTimeoutMs, sourceVerificationIdleTimeoutMs,
  restoredReplayLsn,
  targetReadOnlyRootfs, walgConfigSha256, walgRotationBundleSha256,
  failureStage, sourceVerificationLockRelationsPath,
  sourceDatabaseVerificationPath, restoredDatabaseVerificationPath,
] = process.argv.slice(2);
const succeeded = status === 'success';
let sourceDatabaseVerification = null;
let restoredDatabaseVerification = null;
let sourceVerificationLockRelations = null;
if (succeeded) {
  sourceVerificationLockRelations = JSON.parse(
    fs.readFileSync(sourceVerificationLockRelationsPath, 'utf8'),
  );
  sourceDatabaseVerification = JSON.parse(
    fs.readFileSync(sourceDatabaseVerificationPath, 'utf8'),
  );
  restoredDatabaseVerification = JSON.parse(
    fs.readFileSync(restoredDatabaseVerificationPath, 'utf8'),
  );
  if (
    !/^[0-9a-f]{40}$/.test(sourceDatabaseReleaseSha) ||
    !/^[0-9a-f]{40}$/.test(restoredDatabaseReleaseSha) ||
    sourceDatabaseReleaseSha !== sourceDatabaseVerification?.release?.git_sha ||
    restoredDatabaseReleaseSha !== restoredDatabaseVerification?.release?.git_sha ||
    sourceDatabaseReleaseSha !== restoredDatabaseReleaseSha
  ) {
    throw new Error('database release SHA evidence is not bound to exact source/restore parity');
  }
}
const record = {
  schema_version: 2,
  evidence_type: 'timestamp_pitr',
  run_id: runId,
  status,
  main_sha: mainSha,
  started_at: startedAt,
  completed_at: completedAt,
  backup_name: backupName,
  recovery_target_time: recoveryTargetTime || null,
  failure_time: failureTime || null,
  wal_marker_prefix: walMarkerPrefix,
  wal_commit_fence_prefix: walCommitFencePrefix,
  source_before_marker_content: sourceBeforeMarkerContent || null,
  source_before_marker_content_sha256: sourceBeforeMarkerContentSha256 || null,
  source_before_marker_emitted_at: sourceBeforeMarkerEmittedAt || null,
  source_before_marker_lsn: sourceBeforeMarkerLsn || null,
  source_before_commit_fence_at: sourceBeforeCommitFenceAt || null,
  source_before_commit_fence_lsn: sourceBeforeCommitFenceLsn || null,
  source_after_marker_content: sourceAfterMarkerContent || null,
  source_after_marker_content_sha256: sourceAfterMarkerContentSha256 || null,
  source_after_marker_emitted_at: sourceAfterMarkerEmittedAt || null,
  source_after_marker_lsn: sourceAfterMarkerLsn || null,
  source_after_commit_fence_at: sourceAfterCommitFenceAt || null,
  source_after_commit_fence_lsn: sourceAfterCommitFenceLsn || null,
  restored_recovery_target_time: restoredRecoveryTargetTime || null,
  restored_recovery_target_inclusive: restoredRecoveryTargetInclusive === ''
    ? null
    : restoredRecoveryTargetInclusive === 'true',
  restored_recovery_target_timeline: restoredRecoveryTargetTimeline || null,
  restored_recovery_target_action: restoredRecoveryTargetAction || null,
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
  before_wal_marker_replayed: beforeWalMarkerReplayed === 'true',
  after_wal_marker_excluded: afterWalMarkerExcluded === 'true',
  promoted: promoted === 'true',
  database_verified: databaseVerified === 'true',
  source_database_release_sha: sourceDatabaseReleaseSha || null,
  restored_database_release_sha: restoredDatabaseReleaseSha || null,
  source_database_verification_sha256: sourceDatabaseVerificationSha256 || null,
  source_database_verification: sourceDatabaseVerification,
  restored_database_verification_sha256: restoredDatabaseVerificationSha256 || null,
  restored_database_verification: restoredDatabaseVerification,
  source_verification_snapshot_id: sourceVerificationSnapshotId || null,
  source_verification_snapshot_sha256: sourceVerificationSnapshotSha256 || null,
  source_verification_completed_at: sourceVerificationCompletedAt || null,
  source_verification_floor_lsn: sourceVerificationFloorLsn || null,
  source_verification_lock_set_sha256: sourceVerificationLockSetSha256 || null,
  source_verification_lock_count: sourceVerificationLockCount
    ? Number(sourceVerificationLockCount)
    : null,
  source_verification_lock_timeout_ms: sourceVerificationLockTimeoutMs
    ? Number(sourceVerificationLockTimeoutMs)
    : null,
  source_verification_statement_timeout_ms: sourceVerificationStatementTimeoutMs
    ? Number(sourceVerificationStatementTimeoutMs)
    : null,
  source_verification_idle_timeout_ms: sourceVerificationIdleTimeoutMs
    ? Number(sourceVerificationIdleTimeoutMs)
    : null,
  source_verification_lock_relations: sourceVerificationLockRelations,
  restored_replay_lsn: restoredReplayLsn || null,
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
  abort_source_lock_keeper || true
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
WALG_CONFIG_SHA256=$(container_walg_config_sha256 "${SOURCE_CONTAINER}")
SOURCE_INITIAL_WALG_ROTATION_BUNDLE_SHA256=$(container_walg_rotation_bundle_sha256 "${SOURCE_CONTAINER}")
if [[ ! "${WALG_CONFIG_SHA256}" =~ ^[0-9a-f]{64}$ ]] || \
   [[ ! "${SOURCE_INITIAL_WALG_ROTATION_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  die 'source WAL-G configuration/rotation bundle fingerprint is invalid.'
fi

emit_source_wal_marker() {
  local phase=$1
  local marker_content=$2
  source_psql \
    -v "marker_phase=${phase}" \
    -v "marker_content=${marker_content}" \
    -v "marker_prefix=${WAL_MARKER_PREFIX}" \
    -v "commit_fence_prefix=${WAL_COMMIT_FENCE_PREFIX}" <<'SQL'
BEGIN;
SET LOCAL synchronous_commit = on;
WITH marker AS MATERIALIZED (
  SELECT
    :'marker_content'::text AS content,
    pg_catalog.clock_timestamp() AS emitted_clock
), emitted AS MATERIALIZED (
  SELECT
    marker.content,
    marker.emitted_clock,
    pg_catalog.pg_logical_emit_message(
      true,
      :'marker_prefix',
      marker.content
    ) AS marker_lsn
  FROM marker
)
SELECT
  content,
  encode(public.digest(convert_to(content, 'UTF8'), 'sha256'), 'hex') AS content_sha256,
  to_char(
    emitted_clock AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ) AS emitted_at,
  marker_lsn::text AS marker_lsn
FROM emitted
\gset boundary_
COMMIT;
WITH fence AS MATERIALIZED (
  SELECT
    pg_catalog.clock_timestamp() AS emitted_clock,
    pg_catalog.pg_logical_emit_message(
      false,
      :'commit_fence_prefix',
      :'marker_content'
    ) AS fence_lsn
)
SELECT concat_ws('|',
  :'marker_prefix',
  :'commit_fence_prefix',
  :'boundary_content',
  :'boundary_content_sha256',
  :'boundary_emitted_at',
  :'boundary_marker_lsn',
  to_char(
    fence.emitted_clock AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  ),
  fence.fence_lsn::text,
  pg_catalog.pg_walfile_name(fence.fence_lsn))
FROM fence;
SQL
}

FAILURE_STAGE='before-wal-marker-commit'
SOURCE_BEFORE_MARKER_CONTENT=$(canonical_wal_marker_content BEFORE)
SOURCE_BEFORE_RESULT=$(emit_source_wal_marker BEFORE "${SOURCE_BEFORE_MARKER_CONTENT}")
validate_wal_marker_result "${SOURCE_BEFORE_RESULT}" "${SOURCE_BEFORE_MARKER_CONTENT}"
IFS='|' read -r \
  SOURCE_BEFORE_MARKER_PREFIX SOURCE_BEFORE_COMMIT_FENCE_PREFIX \
  SOURCE_BEFORE_MARKER_CONTENT SOURCE_BEFORE_MARKER_CONTENT_SHA256 \
  SOURCE_BEFORE_MARKER_EMITTED_AT SOURCE_BEFORE_MARKER_LSN \
  SOURCE_BEFORE_COMMIT_FENCE_AT SOURCE_BEFORE_COMMIT_FENCE_LSN BEFORE_WAL_FILE \
  <<< "${SOURCE_BEFORE_RESULT}"
if [ "${SOURCE_BEFORE_MARKER_PREFIX}" != "${WAL_MARKER_PREFIX}" ] || \
   [ "${SOURCE_BEFORE_COMMIT_FENCE_PREFIX}" != "${WAL_COMMIT_FENCE_PREFIX}" ]; then
  die 'BEFORE WAL marker prefixes changed after protocol validation.'
fi

FAILURE_STAGE='source-canonical-verification'
SOURCE_LOCK_KEEPER_TIMEOUT_SECONDS=$(remaining_rto_seconds)
coproc SOURCE_LOCK_KEEPER_PROCESS {
  timeout --foreground --kill-after=30s "${SOURCE_LOCK_KEEPER_TIMEOUT_SECONDS}s" \
    docker exec --user postgres -i "${SOURCE_CONTAINER}" \
    /usr/bin/env -i \
      PATH=/usr/local/bin:/usr/bin:/bin \
      HOME=/nonexistent \
      LC_ALL=C \
      PGHOST=/var/run/postgresql \
      PGUSER="${SOURCE_POSTGRES_USER}" \
      PGDATABASE="${SOURCE_POSTGRES_DB}" \
      PGCONNECT_TIMEOUT="${PSQL_TIMEOUT_SECONDS}" \
      /usr/bin/stdbuf -oL -eL /usr/bin/psql \
        -X -qAt -v ON_ERROR_STOP=1
} 2> "${TMP_DIR}/source-verification.stderr"
SOURCE_LOCK_KEEPER_PID=${SOURCE_LOCK_KEEPER_PROCESS_PID}
SOURCE_LOCK_KEEPER_OUTPUT_FD=${SOURCE_LOCK_KEEPER_PROCESS[0]}
SOURCE_LOCK_KEEPER_INPUT_FD=${SOURCE_LOCK_KEEPER_PROCESS[1]}
SOURCE_LOCK_KEEPER_ACTIVE=true

if ! {
  printf 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY;\n'
  sed -n '1,$p' "${PITR_SOURCE_VERIFICATION_LOCKS_SQL}"
  printf '\n'
} >&"${SOURCE_LOCK_KEEPER_INPUT_FD}"; then
  die 'could not send the canonical source verification protocol.'
fi
if ! IFS= read -r -t "$(remaining_rto_seconds)" \
  -u "${SOURCE_LOCK_KEEPER_OUTPUT_FD}" SOURCE_ROOT_LOCK_RESULT || \
  [ "${SOURCE_ROOT_LOCK_RESULT}" != 'ROOTS_LOCKED' ]; then
  sed 's/^/  source-verification| /' "${TMP_DIR}/source-verification.stderr" >&2 || true
  die 'source verification did not attest the registry root locks.'
fi
if ! IFS= read -r -t "$(remaining_rto_seconds)" \
  -u "${SOURCE_LOCK_KEEPER_OUTPUT_FD}" SOURCE_LOCK_RESULT; then
  sed 's/^/  source-verification| /' "${TMP_DIR}/source-verification.stderr" >&2 || true
  die 'source verification did not return its canonical relation lock set.'
fi
if ! node "${BOUNDED_LINE_READER}" \
  --output "${TMP_DIR}/source-verification.capture" \
  --max-bytes "${MAX_SOURCE_CAPTURE_BYTES}" \
  --expected-marker SOURCE_VERIFICATION_CAPTURED \
  <&"${SOURCE_LOCK_KEEPER_OUTPUT_FD}"; then
  sed 's/^/  source-verification| /' "${TMP_DIR}/source-verification.stderr" >&2 || true
  die 'source verification capture/terminal-marker frame protocol is not canonical.'
fi
SOURCE_CAPTURE_BYTES=$(stat -c '%s' "${TMP_DIR}/source-verification.capture")
if [[ ! "${SOURCE_CAPTURE_BYTES}" =~ ^[1-9][0-9]*$ ]] || \
   [ "${SOURCE_CAPTURE_BYTES}" -gt "${MAX_SOURCE_CAPTURE_BYTES}" ]; then
  die 'source verification capture post-write bound is invalid.'
fi

if [[ ! "${SOURCE_LOCK_RESULT}" =~ ^[0-9a-f]{64}\|[1-9][0-9]*\|5000\|120000\|30000$ ]]; then
  die 'source lock result is not canonical.'
fi
IFS='|' read -r \
  SOURCE_VERIFICATION_LOCK_SET_SHA256 SOURCE_VERIFICATION_LOCK_COUNT \
  SOURCE_VERIFICATION_LOCK_TIMEOUT_MS SOURCE_VERIFICATION_STATEMENT_TIMEOUT_MS \
  SOURCE_VERIFICATION_IDLE_TIMEOUT_MS \
  <<< "${SOURCE_LOCK_RESULT}"
SOURCE_CAPTURE_METADATA=$(node - \
  "${TMP_DIR}/source-verification.capture" \
  "${TMP_DIR}/source-verification-lock-relations.raw" \
  "${TMP_DIR}/source-database-verification.raw" \
  "${MAX_LOCK_RELATIONS_BYTES}" "${MAX_DATABASE_VERIFICATION_BYTES}" <<'NODE'
const fs = require('node:fs');
const [capturePath, relationsPath, payloadPath, maxRelationsRaw, maxPayloadRaw] =
  process.argv.slice(2);
const fields = fs.readFileSync(capturePath, 'utf8').split('|');
const digest = /^[0-9a-f]{64}$/;
const snapshot = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[1-9][0-9]*$/;
const timestamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/;
const lsn = /^[0-9A-F]+\/[0-9A-F]{1,8}$/;
const positive = /^[1-9][0-9]*$/;
const canonicalBase64 = (encoded) => {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('capture contains non-canonical base64');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw new Error('capture base64 round-trip changed');
  }
  return decoded;
};
if (
  fields.length !== 9 || !snapshot.test(fields[0]) || !digest.test(fields[1]) ||
  !digest.test(fields[2]) || !positive.test(fields[3]) ||
  !timestamp.test(fields[5]) || !lsn.test(fields[6]) || !timestamp.test(fields[7])
) {
  throw new Error('source capture metadata is not canonical');
}
const relations = canonicalBase64(fields[4]);
const payload = canonicalBase64(fields[8]);
if (relations.length > Number(maxRelationsRaw) || payload.length > Number(maxPayloadRaw)) {
  throw new Error('decoded source capture payload exceeds its evidence bound');
}
fs.writeFileSync(relationsPath, relations, { flag: 'wx', mode: 0o600 });
fs.writeFileSync(payloadPath, payload, { flag: 'wx', mode: 0o600 });
process.stdout.write([
  fields[0], fields[1], fields[2], fields[3], fields[5], fields[6], fields[7],
].join('|'));
NODE
)
IFS='|' read -r \
  SOURCE_VERIFICATION_SNAPSHOT_ID SOURCE_VERIFICATION_SNAPSHOT_SHA256 \
  SOURCE_CAPTURE_LOCK_SET_SHA256 SOURCE_CAPTURE_LOCK_COUNT \
  SOURCE_VERIFICATION_COMPLETED_AT SOURCE_VERIFICATION_FLOOR_LSN \
  RECOVERY_TARGET_TIME \
  <<< "${SOURCE_CAPTURE_METADATA}"
if [ "${SOURCE_CAPTURE_LOCK_SET_SHA256}" != "${SOURCE_VERIFICATION_LOCK_SET_SHA256}" ] || \
   [ "${SOURCE_CAPTURE_LOCK_COUNT}" != "${SOURCE_VERIFICATION_LOCK_COUNT}" ]; then
  die 'source capture lock attestation changed between lock and collection phases.'
fi
COMPUTED_SNAPSHOT_SHA256=$(printf '%s' "${SOURCE_VERIFICATION_SNAPSHOT_ID}" | \
  sha256sum | awk '{print $1}')
if [ "${COMPUTED_SNAPSHOT_SHA256}" != "${SOURCE_VERIFICATION_SNAPSHOT_SHA256}" ]; then
  die 'source verification snapshot digest does not match its captured identifier.'
fi
node - \
  "${TMP_DIR}/source-verification-lock-relations.raw" \
  "${TMP_DIR}/source-verification-lock-relations.json" \
  "${SOURCE_VERIFICATION_LOCK_SET_SHA256}" \
  "${SOURCE_VERIFICATION_LOCK_COUNT}" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const [input, output, expectedHash, expectedCount] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(input, 'utf8'));
if (
  !Array.isArray(value) || value.length !== Number(expectedCount) ||
  value.some((item) => typeof item !== 'string') ||
  JSON.stringify(value) !== JSON.stringify([...value].sort()) ||
  new Set(value).size !== value.length
) {
  throw new Error('source verification relation preimage is not a canonical sorted set');
}
const actualHash = crypto.createHash('sha256').update(value.join('\n')).digest('hex');
if (actualHash !== expectedHash) {
  throw new Error('source verification relation preimage does not match its digest');
}
fs.writeFileSync(output, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
NODE
SOURCE_DATABASE_RELEASE_SHA=$(canonicalize_database_verification \
  "${TMP_DIR}/source-database-verification.raw" \
  "${TMP_DIR}/source-database-verification.canonical.json")
EXPECTED_SOURCE_LOCK_COUNT=$(node -e '
  const value = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(19 + (14 * value.tenant_schemas.length)));
' "${TMP_DIR}/source-database-verification.canonical.json")
if [ "${SOURCE_VERIFICATION_LOCK_COUNT}" != "${EXPECTED_SOURCE_LOCK_COUNT}" ]; then
  die 'source verification lock count does not cover every canonical tenant relation.'
fi
SOURCE_DATABASE_VERIFICATION_SHA256=$(sha256sum \
  "${TMP_DIR}/source-database-verification.canonical.json" | awk '{print $1}')
unset SOURCE_CAPTURE_METADATA

is_evidence_timestamp "${SOURCE_VERIFICATION_COMPLETED_AT}" || \
  die 'source verification completion timestamp is invalid.'
is_evidence_timestamp "${RECOVERY_TARGET_TIME}" || \
  die 'source verification returned an invalid recovery target timestamp.'
if [[ "${RECOVERY_TARGET_TIME}" =~ ^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6})Z$ ]]; then
  RECOVERY_TARGET_POSTGRES="${BASH_REMATCH[1]} ${BASH_REMATCH[2]}+00"
else
  die 'source verification recovery target cannot be represented by PostgreSQL exactly.'
fi
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

FAILURE_STAGE='after-wal-marker-commit'
SOURCE_AFTER_MARKER_CONTENT=$(canonical_wal_marker_content AFTER)
SOURCE_AFTER_RESULT=$(emit_source_wal_marker AFTER "${SOURCE_AFTER_MARKER_CONTENT}")
validate_wal_marker_result "${SOURCE_AFTER_RESULT}" "${SOURCE_AFTER_MARKER_CONTENT}"
IFS='|' read -r \
  SOURCE_AFTER_MARKER_PREFIX SOURCE_AFTER_COMMIT_FENCE_PREFIX \
  SOURCE_AFTER_MARKER_CONTENT SOURCE_AFTER_MARKER_CONTENT_SHA256 \
  SOURCE_AFTER_MARKER_EMITTED_AT SOURCE_AFTER_MARKER_LSN \
  SOURCE_AFTER_COMMIT_FENCE_AT SOURCE_AFTER_COMMIT_FENCE_LSN AFTER_WAL_FILE \
  <<< "${SOURCE_AFTER_RESULT}"
if [ "${SOURCE_AFTER_MARKER_PREFIX}" != "${WAL_MARKER_PREFIX}" ] || \
   [ "${SOURCE_AFTER_COMMIT_FENCE_PREFIX}" != "${WAL_COMMIT_FENCE_PREFIX}" ]; then
  die 'AFTER WAL marker prefixes changed after protocol validation.'
fi
for timestamp_value in \
  "${SOURCE_BEFORE_MARKER_EMITTED_AT}" "${SOURCE_BEFORE_COMMIT_FENCE_AT}" \
  "${SOURCE_VERIFICATION_COMPLETED_AT}" \
  "${RECOVERY_TARGET_TIME}" "${SOURCE_AFTER_MARKER_EMITTED_AT}" \
  "${SOURCE_AFTER_COMMIT_FENCE_AT}"; do
  is_evidence_timestamp "${timestamp_value}" || die 'source WAL marker protocol returned an invalid timestamp.'
done
BEFORE_NS=$(date -u -d "${SOURCE_BEFORE_MARKER_EMITTED_AT}" +%s%N)
BEFORE_FENCE_NS=$(date -u -d "${SOURCE_BEFORE_COMMIT_FENCE_AT}" +%s%N)
SOURCE_VERIFICATION_COMPLETED_NS=$(date -u -d "${SOURCE_VERIFICATION_COMPLETED_AT}" +%s%N)
AFTER_NS=$(date -u -d "${SOURCE_AFTER_MARKER_EMITTED_AT}" +%s%N)
AFTER_FENCE_NS=$(date -u -d "${SOURCE_AFTER_COMMIT_FENCE_AT}" +%s%N)
if [ "${BEFORE_NS}" -gt "${BEFORE_FENCE_NS}" ] || \
   [ "${BEFORE_FENCE_NS}" -gt "${SOURCE_VERIFICATION_COMPLETED_NS}" ] || \
   [ $(( SOURCE_VERIFICATION_COMPLETED_NS + 2000000000 )) -ne "${TARGET_NS}" ] || \
   [ "${TARGET_NS}" -ge "${AFTER_NS}" ] || \
   [ "${AFTER_NS}" -gt "${AFTER_FENCE_NS}" ]; then
  die 'source chronology must bracket the locked capture and target between WAL markers.'
fi
node - \
  "${SOURCE_BEFORE_MARKER_LSN}" "${SOURCE_BEFORE_COMMIT_FENCE_LSN}" \
  "${SOURCE_VERIFICATION_FLOOR_LSN}" \
  "${SOURCE_AFTER_MARKER_LSN}" "${SOURCE_AFTER_COMMIT_FENCE_LSN}" <<'NODE'
const values = process.argv.slice(2).map((value) => {
  const match = value.match(/^([0-9A-F]+)\/([0-9A-F]{1,8})$/);
  if (!match) throw new Error('invalid PostgreSQL LSN');
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
});
if (!(values[0] < values[1] && values[1] <= values[2] && values[2] <= values[3] && values[3] < values[4])) {
  throw new Error('source capture and WAL marker LSNs must fall within exact commit fences');
}
NODE
commit_source_lock_keeper
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
    die 'AFTER commit-fence WAL segment was not archived within the RPO budget.'
  fi
  sleep 1
done
ARCHIVE_WAIT_SECONDS=$(( SECONDS - ARCHIVE_WAIT_STARTED ))

# The simulated source-loss boundary is established only after the segment
# containing the AFTER commit fence is durably observable in the archive. From
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
    printf "recovery_target_inclusive = '\''false'\''\n"
    printf "recovery_target_timeline = '\''latest'\''\n"
    printf "recovery_target_action = '\''promote'\''\n"
  } >> "${PGDATA}/postgresql.auto.conf"
' bash "${RECOVERY_TARGET_POSTGRES}"

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

FAILURE_STAGE='wal-marker-verification'
RESTORED_SYSTEM_IDENTIFIER=$(target_psql -c 'SELECT system_identifier::text FROM pg_control_system();')
if [ "${RESTORED_SYSTEM_IDENTIFIER}" != "${SOURCE_SYSTEM_IDENTIFIER}" ]; then
  die 'restored target system identifier differs from the attested source cluster.'
fi
RESTORED_RECOVERY_SETTINGS=$(target_psql -c \
  "SELECT concat_ws('|', to_char(current_setting('recovery_target_time')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'), current_setting('recovery_target_inclusive'), current_setting('recovery_target_timeline'), current_setting('recovery_target_action'));")
IFS='|' read -r \
  RESTORED_RECOVERY_TARGET_TIME RESTORED_RECOVERY_TARGET_INCLUSIVE_SETTING \
  RESTORED_RECOVERY_TARGET_TIMELINE RESTORED_RECOVERY_TARGET_ACTION \
  <<< "${RESTORED_RECOVERY_SETTINGS}"
if [ "${RESTORED_RECOVERY_TARGET_TIME}" != "${RECOVERY_TARGET_TIME}" ] || \
   [ "${RESTORED_RECOVERY_TARGET_INCLUSIVE_SETTING}" != 'off' ] || \
   [ "${RESTORED_RECOVERY_TARGET_TIMELINE}" != 'latest' ] || \
   [ "${RESTORED_RECOVERY_TARGET_ACTION}" != 'promote' ]; then
  die 'restored PostgreSQL recovery settings differ from the protected timestamp target contract.'
fi
RESTORED_RECOVERY_TARGET_INCLUSIVE=false
RESTORED_REPLAY_LSN=$(target_psql -c 'SELECT pg_last_wal_replay_lsn()::text;')
[[ "${RESTORED_REPLAY_LSN}" =~ ^[0-9A-F]+/[0-9A-F]{1,8}$ ]] || \
  die 'restored target did not expose a canonical replay LSN.'

FAILURE_STAGE='canonical-database-verification'
if ! (
  printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
  sed -n '1,$p' "${DATABASE_VERIFICATION_SQL}"
  printf '\nCOMMIT;\n'
) | target_psql_with_rto_budget \
  2> "${TMP_DIR}/restored-database-verification.stderr" | \
  node "${BOUNDED_LINE_READER}" \
    --output "${TMP_DIR}/restored-database-verification.raw" \
    --max-bytes "${MAX_DATABASE_VERIFICATION_BYTES}"; then
  sed 's/^/  verification| /' "${TMP_DIR}/restored-database-verification.stderr" >&2 || true
  die 'restored target failed canonical database verification.'
fi
RESTORED_DATABASE_RELEASE_SHA=$(canonicalize_database_verification \
  "${TMP_DIR}/restored-database-verification.raw" \
  "${TMP_DIR}/restored-database-verification.canonical.json")
RESTORED_DATABASE_VERIFICATION_SHA256=$(sha256sum \
  "${TMP_DIR}/restored-database-verification.canonical.json" | awk '{print $1}')
if [ "${SOURCE_DATABASE_RELEASE_SHA}" != "${RESTORED_DATABASE_RELEASE_SHA}" ] || \
   [ "${SOURCE_DATABASE_VERIFICATION_SHA256}" != \
     "${RESTORED_DATABASE_VERIFICATION_SHA256}" ] || \
   ! cmp -s "${TMP_DIR}/source-database-verification.canonical.json" \
     "${TMP_DIR}/restored-database-verification.canonical.json"; then
  die 'source and restored canonical database verification payloads differ.'
fi
node - \
  "${SOURCE_BEFORE_MARKER_LSN}" "${SOURCE_BEFORE_COMMIT_FENCE_LSN}" \
  "${SOURCE_VERIFICATION_FLOOR_LSN}" "${RESTORED_REPLAY_LSN}" \
  "${SOURCE_AFTER_COMMIT_FENCE_LSN}" <<'NODE'
const values = process.argv.slice(2).map((value) => {
  const match = value.match(/^([0-9A-F]+)\/([0-9A-F]{1,8})$/);
  if (!match) throw new Error('invalid PostgreSQL LSN');
  return (BigInt(`0x${match[1]}`) << 32n) + BigInt(`0x${match[2]}`);
});
if (!(values[0] < values[1] && values[1] <= values[2] && values[2] <= values[3] && values[3] < values[4])) {
  throw new Error('restored replay LSN does not prove the exact transactional WAL marker boundary');
}
NODE
BEFORE_WAL_MARKER_REPLAYED=true
AFTER_WAL_MARKER_EXCLUDED=true
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
printf 'WALG_TIMESTAMP_PITR_VERIFIED backup_name=%s rpo_seconds=%s rto_seconds=%s source_database_verification_sha256=%s restored_database_verification_sha256=%s evidence=%s\n' \
  "${BACKUP_NAME}" "${RPO_SECONDS}" "${RTO_SECONDS}" \
  "${SOURCE_DATABASE_VERIFICATION_SHA256}" \
  "${RESTORED_DATABASE_VERIFICATION_SHA256}" "${EVIDENCE_PATH}"
