#!/usr/bin/env bash
# Execute one explicit full WAL-G base backup, verify its WAL chain, and emit a
# single machine-readable evidence record. The workflow must upload the record
# even when this command exits non-zero so interrupted runs break consecutivity.

set +x
set -euo pipefail
umask 077

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-aqua-postgres}"
WALG_RUNTIME_COMMAND="${WALG_RUNTIME_COMMAND:-/usr/local/bin/walg-runtime-command.sh}"
WALG_EVIDENCE_DIR="${WALG_EVIDENCE_DIR:?WALG_EVIDENCE_DIR required}"
EVIDENCE_RUN_ID="${EVIDENCE_RUN_ID:?EVIDENCE_RUN_ID required}"
MAIN_SHA="${MAIN_SHA:?MAIN_SHA required}"
EXPECTED_POSTGRES_DR_CONTRACT_SHA256="${EXPECTED_POSTGRES_DR_CONTRACT_SHA256:?EXPECTED_POSTGRES_DR_CONTRACT_SHA256 required}"
EXPECTED_WALG_REVISION='f81943e64bdf97aa66f6c52fec55114703f97af7'
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STARTED_EPOCH=$(date -u +%s)
EVIDENCE_PATH=''
EVIDENCE_WRITTEN=false
BACKUP_NAME=''
BACKUP_METADATA_PATH=''
SOURCE_SYSTEM_IDENTIFIER=''
SOURCE_IMAGE_ID=''
SOURCE_IMAGE_REVISION=''
SOURCE_POSTGRES_DR_CONTRACT_SHA256=''
SOURCE_WALG_REVISION=''
WALG_CONFIG_SHA256=''
WALG_ROTATION_BUNDLE_SHA256=''
FAILURE_STAGE='preflight'
TMP_DIR=''

die() {
  printf 'FATAL: %s\n' "$*" >&2
  exit 2
}

if [[ ! "${POSTGRES_CONTAINER}" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
  die 'POSTGRES_CONTAINER contains unsafe characters.'
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
if [ "${WALG_EVIDENCE_DIR}" != "${WALG_EVIDENCE_DIR//$'\n'/}" ]; then
  die 'WALG_EVIDENCE_DIR cannot contain line terminators.'
fi
command -v node >/dev/null 2>&1 || die 'node is required.'

mkdir -p "${WALG_EVIDENCE_DIR}"
EVIDENCE_PATH="${WALG_EVIDENCE_DIR}/base-backup-${EVIDENCE_RUN_ID}.json"
if [ -e "${EVIDENCE_PATH}" ]; then
  die "refusing to overwrite evidence: ${EVIDENCE_PATH}"
fi
TMP_DIR=$(mktemp -d -t walg-base-backup-XXXXXX)

write_evidence() {
  local status=$1
  local completed_at
  local elapsed_seconds
  local temp_evidence

  completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  elapsed_seconds=$(( $(date -u +%s) - STARTED_EPOCH ))
  temp_evidence="${EVIDENCE_PATH}.next.$$"
  node - \
    "${temp_evidence}" \
    "${status}" \
    "${EVIDENCE_RUN_ID}" \
    "${MAIN_SHA}" \
    "${STARTED_AT}" \
    "${completed_at}" \
    "${elapsed_seconds}" \
    "${BACKUP_NAME}" \
    "${FAILURE_STAGE}" \
    "${BACKUP_METADATA_PATH}" \
    "${SOURCE_IMAGE_ID}" \
    "${SOURCE_IMAGE_REVISION}" \
    "${SOURCE_POSTGRES_DR_CONTRACT_SHA256}" \
    "${SOURCE_WALG_REVISION}" \
    "${WALG_CONFIG_SHA256}" \
    "${WALG_ROTATION_BUNDLE_SHA256}" <<'NODE'
const fs = require('node:fs');
const [
  outputPath,
  status,
  runId,
  mainSha,
  startedAt,
  completedAt,
  elapsedSeconds,
  backupName,
  failureStage,
  backupMetadataPath,
  sourceImageId,
  sourceImageRevision,
  sourcePostgresDrContractSha256,
  sourceWalgRevision,
  walgConfigSha256,
  walgRotationBundleSha256,
] = process.argv.slice(2);
const succeeded = status === 'success';
let backupMetadata = null;
if (backupMetadataPath && fs.existsSync(backupMetadataPath)) {
  backupMetadata = JSON.parse(fs.readFileSync(backupMetadataPath, 'utf8'));
}
const record = {
  schema_version: 1,
  evidence_type: 'base_backup',
  run_id: runId,
  status,
  main_sha: mainSha,
  started_at: startedAt,
  completed_at: completedAt,
  elapsed_seconds: Number(elapsedSeconds),
  backup_name: backupName || null,
  backup_type: backupMetadata?.backup_type ?? null,
  backup_user_data: backupMetadata?.backup_user_data ?? null,
  backup_wal_file_name: backupMetadata?.backup_wal_file_name ?? null,
  backup_storage_name: backupMetadata?.backup_storage_name ?? null,
  backup_start_time: backupMetadata?.backup_start_time ?? null,
  backup_finish_time: backupMetadata?.backup_finish_time ?? null,
  backup_start_lsn: backupMetadata?.backup_start_lsn ?? null,
  backup_finish_lsn: backupMetadata?.backup_finish_lsn ?? null,
  backup_pg_version: backupMetadata?.backup_pg_version ?? null,
  source_system_identifier: backupMetadata?.source_system_identifier ?? null,
  source_image_id: sourceImageId || null,
  source_image_revision: sourceImageRevision || null,
  source_postgres_dr_contract_sha256: sourcePostgresDrContractSha256 || null,
  source_wal_g_revision: sourceWalgRevision || null,
  walg_config_sha256: walgConfigSha256 || null,
  walg_rotation_bundle_sha256: walgRotationBundleSha256 || null,
  full: succeeded,
  verified: succeeded,
  wal_verified: succeeded,
  failure_stage: succeeded ? null : failureStage,
};
fs.writeFileSync(outputPath, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
NODE
  mv "${temp_evidence}" "${EVIDENCE_PATH}"
  EVIDENCE_WRITTEN=true
}

cleanup() {
  local status=$?
  trap - EXIT
  if [ "${EVIDENCE_WRITTEN}" != 'true' ] && [ -n "${EVIDENCE_PATH}" ] && [ ! -e "${EVIDENCE_PATH}" ]; then
    write_evidence failure || true
  fi
  if [ -n "${TMP_DIR}" ] && [ -d "${TMP_DIR}" ]; then
    rm -rf "${TMP_DIR}"
  fi
  exit "${status}"
}
trap cleanup EXIT

container_walg_config_sha256() {
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

container_system_identifier() {
  docker exec --user postgres "$1" bash -ceu '
    psql -X -qAt \
      -U "${POSTGRES_USER:?POSTGRES_USER required}" \
      -d "${POSTGRES_DB:-${POSTGRES_USER}}" \
      -v ON_ERROR_STOP=1 \
      -c "SELECT system_identifier::text FROM pg_control_system();"
  '
}

# Establish the evidence trap before any external operational preflight. This
# makes a stopped container or missing Docker daemon a failed scheduled attempt
# instead of an invisible gap in the evidence sequence.
command -v docker >/dev/null 2>&1 || die 'docker is required.'
if [ "$(docker inspect --format '{{.State.Running}}' "${POSTGRES_CONTAINER}" 2>/dev/null || true)" != 'true' ]; then
  die "PostgreSQL container is not running: ${POSTGRES_CONTAINER}"
fi
POSTGRES_CONTAINER_NAME="${POSTGRES_CONTAINER}"
POSTGRES_CONTAINER=$(docker inspect --format '{{.Id}}' "${POSTGRES_CONTAINER_NAME}")
if [[ ! "${POSTGRES_CONTAINER}" =~ ^[0-9a-f]{64}$ ]]; then
  die 'PostgreSQL immutable container ID is invalid.'
fi

FAILURE_STAGE='chain-identity-attestation'
SOURCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' "${POSTGRES_CONTAINER}")
SOURCE_IMAGE_REVISION=$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "${SOURCE_IMAGE_ID}")
SOURCE_POSTGRES_DR_CONTRACT_SHA256=$(docker image inspect --format '{{ index .Config.Labels "io.aquaculture.postgres.dr-contract-sha256" }}' "${SOURCE_IMAGE_ID}")
SOURCE_WALG_REVISION=$(docker image inspect --format '{{ index .Config.Labels "io.aquaculture.wal-g.revision" }}' "${SOURCE_IMAGE_ID}")
if [[ ! "${SOURCE_IMAGE_ID}" =~ ^sha256:[0-9a-f]{64}$ ]] || \
   [[ ! "${SOURCE_IMAGE_REVISION}" =~ ^[0-9a-f]{40}$ ]] || \
   [ "${SOURCE_IMAGE_REVISION}" = '0000000000000000000000000000000000000000' ] || \
   [ "${SOURCE_POSTGRES_DR_CONTRACT_SHA256}" != "${EXPECTED_POSTGRES_DR_CONTRACT_SHA256}" ] || \
   [ "${SOURCE_WALG_REVISION}" != "${EXPECTED_WALG_REVISION}" ]; then
  die 'source image provenance, DR contract, or WAL-G revision does not match the protected workflow authority.'
fi

BEFORE_LIST="${TMP_DIR}/before.json"
AFTER_LIST="${TMP_DIR}/after.json"
WAL_VERIFY="${TMP_DIR}/wal-verify.json"

FAILURE_STAGE='runtime-secret-verification'
docker exec --user postgres "${POSTGRES_CONTAINER}" \
  "${WALG_RUNTIME_COMMAND}" assert-runtime
WALG_CONFIG_SHA256=$(container_walg_config_sha256 "${POSTGRES_CONTAINER}")
WALG_ROTATION_BUNDLE_SHA256=$(container_walg_rotation_bundle_sha256 "${POSTGRES_CONTAINER}")
if [[ ! "${WALG_CONFIG_SHA256}" =~ ^[0-9a-f]{64}$ ]] || \
   [[ ! "${WALG_ROTATION_BUNDLE_SHA256}" =~ ^[0-9a-f]{64}$ ]]; then
  die 'WAL-G configuration or rotation bundle hash is invalid.'
fi

FAILURE_STAGE='backup-list-before'
docker exec --user postgres "${POSTGRES_CONTAINER}" \
  "${WALG_RUNTIME_COMMAND}" backup-list-json > "${BEFORE_LIST}"
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' "${BEFORE_LIST}"

FAILURE_STAGE='backup-push-full'
docker exec --user postgres "${POSTGRES_CONTAINER}" \
  "${WALG_RUNTIME_COMMAND}" backup-push-full "${EVIDENCE_RUN_ID}" "${MAIN_SHA}"

FAILURE_STAGE='backup-list-after'
docker exec --user postgres "${POSTGRES_CONTAINER}" \
  "${WALG_RUNTIME_COMMAND}" backup-list-json > "${AFTER_LIST}"
BACKUP_METADATA_PATH="${TMP_DIR}/created-backup.json"
node - \
  "${BEFORE_LIST}" "${AFTER_LIST}" "${BACKUP_METADATA_PATH}" \
  "${EVIDENCE_RUN_ID}" "${MAIN_SHA}" <<'NODE'
const fs = require('node:fs');
const [beforePath, afterPath, outputPath, expectedRunId, expectedMainSha] = process.argv.slice(2);
const parseBackupList = (path) => {
  // WAL-G v3.0.8 serializes uint64 system identifiers and LSNs as JSON
  // numbers. Quote those tokens before JSON.parse so V8 cannot round them.
  const losslessJson = fs.readFileSync(path, 'utf8').replace(
    /("(?:system_identifier|start_lsn|finish_lsn)"\s*:\s*)([0-9]+)/g,
    '$1"$2"',
  );
  const value = JSON.parse(losslessJson);
  if (!Array.isArray(value)) throw new Error('WAL-G backup-list JSON is not an array');
  return value;
};
const keyOf = (entry) => `${entry.storage_name}\0${entry.backup_name}`;
const before = new Set(
  parseBackupList(beforePath)
    .filter((entry) => entry?.storage_name === 'default' && typeof entry?.backup_name === 'string')
    .map(keyOf),
);
const created = parseBackupList(afterPath).filter(
  (entry) => entry?.storage_name === 'default' && !before.has(keyOf(entry)),
);
if (created.length !== 1) {
  throw new Error(`expected exactly one newly created explicit backup, found ${created.length}`);
}
const [record] = created;
const isCanonicalTimestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
const expectedUserData = {
  aqua_run_id: expectedRunId,
  backup_kind: 'full',
  main_sha: expectedMainSha,
};
const userDataKeys = Object.keys(record.user_data ?? {}).sort();
if (
  userDataKeys.join('\n') !== Object.keys(expectedUserData).sort().join('\n') ||
  userDataKeys.some((key) => record.user_data[key] !== expectedUserData[key])
) {
  throw new Error('created backup user_data does not match the run/main/full authority');
}
if (
  typeof record.backup_name !== 'string' ||
  !/^base_[0-9A-F]{24}$/.test(record.backup_name) ||
  typeof record.wal_file_name !== 'string' ||
  !/^[0-9A-F]{24}$/.test(record.wal_file_name) ||
  BigInt(`0x${record.wal_file_name.slice(0, 8)}`) === 0n ||
  record.backup_name !== `base_${record.wal_file_name}`
) {
  throw new Error('created backup is not one canonical full WAL-G base backup');
}
if (
  typeof record.system_identifier !== 'string' ||
  !/^[0-9]{10,20}$/.test(record.system_identifier) ||
  typeof record.start_lsn !== 'string' ||
  !/^[0-9]{1,20}$/.test(record.start_lsn) ||
  typeof record.finish_lsn !== 'string' ||
  !/^[0-9]{1,20}$/.test(record.finish_lsn) ||
  BigInt(record.system_identifier) > 18446744073709551615n ||
  BigInt(record.start_lsn) >= BigInt(record.finish_lsn) ||
  BigInt(record.finish_lsn) > 18446744073709551615n
) {
  throw new Error('created backup has invalid lossless system identifier or WAL coordinates');
}
if (
  !isCanonicalTimestamp(record.start_time) ||
  !isCanonicalTimestamp(record.finish_time) ||
  Date.parse(record.start_time) > Date.parse(record.finish_time) ||
  !Number.isSafeInteger(record.pg_version) ||
  record.pg_version < 90000 ||
  record.pg_version > 999999 ||
  record.is_permanent !== false
) {
  throw new Error('created backup detail record is incomplete or inconsistent');
}
const metadata = {
  backup_type: 'full',
  backup_user_data: expectedUserData,
  backup_wal_file_name: record.wal_file_name,
  backup_storage_name: record.storage_name,
  backup_start_time: record.start_time,
  backup_finish_time: record.finish_time,
  backup_start_lsn: record.start_lsn,
  backup_finish_lsn: record.finish_lsn,
  backup_pg_version: record.pg_version,
  source_system_identifier: record.system_identifier,
};
fs.writeFileSync(outputPath, `${JSON.stringify(metadata)}\n`, { flag: 'wx', mode: 0o600 });
NODE
BACKUP_NAME=$(node -e '
  const metadata = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(`base_${metadata.backup_wal_file_name}`);
' "${BACKUP_METADATA_PATH}")
SOURCE_SYSTEM_IDENTIFIER=$(node -e '
  const metadata = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(metadata.source_system_identifier);
' "${BACKUP_METADATA_PATH}")
case "${BACKUP_NAME}" in
  LATEST|latest|'') die 'WAL-G did not return an explicit backup name.' ;;
esac

FAILURE_STAGE='source-system-identifier-verification'
LIVE_SOURCE_SYSTEM_IDENTIFIER=$(container_system_identifier "${POSTGRES_CONTAINER}")
if [ "${LIVE_SOURCE_SYSTEM_IDENTIFIER}" != "${SOURCE_SYSTEM_IDENTIFIER}" ]; then
  die 'created backup system identifier differs from the live source cluster.'
fi

FAILURE_STAGE='wal-verify'
docker exec --user postgres "${POSTGRES_CONTAINER}" \
  "${WALG_RUNTIME_COMMAND}" wal-verify "${BACKUP_NAME}" > "${WAL_VERIFY}"
node -e '
  const result = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (result?.integrity?.status !== "OK" || result?.timeline?.status !== "OK") {
    throw new Error("WAL-G wal-verify did not report integrity=OK and timeline=OK");
  }
' "${WAL_VERIFY}"

FAILURE_STAGE='chain-identity-reverification'
CURRENT_CONTAINER_ID=$(docker inspect --format '{{.Id}}' "${POSTGRES_CONTAINER_NAME}")
CURRENT_SOURCE_IMAGE_ID=$(docker inspect --format '{{.Image}}' "${POSTGRES_CONTAINER}")
CURRENT_WALG_CONFIG_SHA256=$(container_walg_config_sha256 "${POSTGRES_CONTAINER}")
CURRENT_WALG_ROTATION_BUNDLE_SHA256=$(container_walg_rotation_bundle_sha256 "${POSTGRES_CONTAINER}")
CURRENT_SOURCE_SYSTEM_IDENTIFIER=$(container_system_identifier "${POSTGRES_CONTAINER}")
if [ "${CURRENT_CONTAINER_ID}" != "${POSTGRES_CONTAINER}" ] || \
   [ "${CURRENT_SOURCE_IMAGE_ID}" != "${SOURCE_IMAGE_ID}" ] || \
   [ "${CURRENT_WALG_CONFIG_SHA256}" != "${WALG_CONFIG_SHA256}" ] || \
   [ "${CURRENT_WALG_ROTATION_BUNDLE_SHA256}" != "${WALG_ROTATION_BUNDLE_SHA256}" ] || \
   [ "${CURRENT_SOURCE_SYSTEM_IDENTIFIER}" != "${SOURCE_SYSTEM_IDENTIFIER}" ]; then
  die 'source container, image, cluster, WAL-G configuration, or rotation bundle changed during backup.'
fi

FAILURE_STAGE='evidence-write'
write_evidence success
printf 'WALG_BASE_BACKUP_VERIFIED backup_name=%s evidence=%s\n' "${BACKUP_NAME}" "${EVIDENCE_PATH}"
