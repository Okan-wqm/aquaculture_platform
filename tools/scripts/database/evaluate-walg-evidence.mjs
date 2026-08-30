#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULTS = Object.freeze({
  minConsecutiveBackups: 3,
  maxRpoSeconds: 300,
  maxRtoSeconds: 3600,
  expectedMainSha: null,
  expectedPostgresDrContractSha256: null,
});

const CANONICAL_SCHEMAS = Object.freeze([
  'auth',
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'alert',
  'ai',
  'billing',
  'notification',
  'admin',
  'config',
  'observability',
  'event_store',
  'gateway',
  'shared',
  'compliance',
]);

const SOURCE_SCHEMAS = Object.freeze([
  'auth',
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'alert',
  'ai',
  'billing',
  'notification',
  'admin',
  'config',
  'observability',
  'event_store',
]);

const TENANT_AWARE_SCHEMAS = Object.freeze([
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'alert',
  'ai',
]);

const GLOBAL_SENTINELS = Object.freeze([
  Object.freeze({ schema: 'auth', table: 'tenants' }),
  Object.freeze({ schema: 'auth', table: 'users' }),
  Object.freeze({ schema: 'billing', table: 'subscriptions' }),
]);

const TENANT_SENTINELS = Object.freeze([
  'farms',
  'sensors',
  'employees',
  'channels',
  'hydroponics_config',
  'alert_rules',
  'agent_conversations',
]);

const EXPECTED_WALG_REVISION = 'f81943e64bdf97aa66f6c52fec55114703f97af7';

const isTimestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const isEvidenceTimestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

const evidenceTimestampNanoseconds = (value) => {
  if (!isEvidenceTimestamp(value)) return null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/);
  if (!match) return null;
  const wholeSeconds = Date.parse(`${match[1]}Z`);
  if (!Number.isFinite(wholeSeconds)) return null;
  const fraction = (match[2] ?? '').padEnd(9, '0');
  return BigInt(wholeSeconds) * 1_000_000n + BigInt(fraction || '0');
};

const isSafeToken = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]+$/.test(value);

const isWalFileName = (value) =>
  typeof value === 'string' &&
  /^[0-9A-F]{24}$/.test(value) &&
  BigInt(`0x${value.slice(0, 8)}`) > 0n;

const isBackupName = (value) =>
  typeof value === 'string' && value.startsWith('base_') && isWalFileName(value.slice(5));

const isMainSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

const UINT64_MAX = 18_446_744_073_709_551_615n;

const unsigned64 = (value) => {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return null;
  const parsed = BigInt(value);
  return parsed <= UINT64_MAX ? parsed : null;
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const hasExactKeys = (value, expectedKeys) =>
  isRecord(value) && Object.keys(value).sort().join('\n') === [...expectedKeys].sort().join('\n');

const hasExactStringArray = (value, expected) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((item, index) => item === expected[index]);

const isMigrationHead = (value, expectedIdentityKey, expectedIdentity) =>
  hasExactKeys(value, [expectedIdentityKey, 'timestamp', 'name']) &&
  value[expectedIdentityKey] === expectedIdentity &&
  typeof value.timestamp === 'string' &&
  /^[1-9][0-9]*$/.test(value.timestamp) &&
  isSafeToken(value.name);

const isSentinelProof = (value, expected) =>
  hasExactKeys(value, ['scope', 'schema', 'table', 'row_count', 'checksum']) &&
  value.scope === expected.scope &&
  value.schema === expected.schema &&
  value.table === expected.table &&
  Number.isSafeInteger(value.row_count) &&
  value.row_count >= 0 &&
  typeof value.checksum === 'string' &&
  /^[0-9a-f]{32}$/.test(value.checksum);

const isCanonicalDatabaseVerification = (payload, mainSha) => {
  if (
    !hasExactKeys(payload, [
      'contract_version',
      'canonical_schemas',
      'tenant_schemas',
      'release',
      'migration_heads',
      'sentinels',
    ]) ||
    payload.contract_version !== 1 ||
    !hasExactStringArray(payload.canonical_schemas, CANONICAL_SCHEMAS) ||
    !Array.isArray(payload.tenant_schemas)
  ) {
    return false;
  }

  const tenantSchemas = payload.tenant_schemas;
  if (
    tenantSchemas.some(
      (schema, index) =>
        typeof schema !== 'string' ||
        !/^tenant_[a-f0-9]{16}$/.test(schema) ||
        (index > 0 && tenantSchemas[index - 1] >= schema),
    )
  ) {
    return false;
  }

  if (
    !hasExactKeys(payload.release, ['release_id', 'git_sha']) ||
    typeof payload.release.release_id !== 'string' ||
    payload.release.release_id.length < 1 ||
    payload.release.release_id.length > 120 ||
    payload.release.git_sha !== mainSha ||
    !hasExactKeys(payload.migration_heads, ['schemas', 'tenants']) ||
    !Array.isArray(payload.migration_heads.schemas) ||
    !Array.isArray(payload.migration_heads.tenants) ||
    !Array.isArray(payload.sentinels)
  ) {
    return false;
  }

  const sourceHeads = payload.migration_heads.schemas;
  if (
    sourceHeads.length !== SOURCE_SCHEMAS.length ||
    sourceHeads.some((head, index) => !isMigrationHead(head, 'schema', SOURCE_SCHEMAS[index]))
  ) {
    return false;
  }

  const expectedTenantHeads = tenantSchemas.flatMap((tenantSchema) =>
    TENANT_AWARE_SCHEMAS.map((sourceSchema) => ({ tenantSchema, sourceSchema })),
  );
  const tenantHeads = payload.migration_heads.tenants;
  if (
    tenantHeads.length !== expectedTenantHeads.length ||
    tenantHeads.some((head, index) => {
      const expected = expectedTenantHeads[index];
      return (
        !hasExactKeys(head, ['tenant_schema', 'source_schema', 'timestamp', 'name']) ||
        head.tenant_schema !== expected.tenantSchema ||
        head.source_schema !== expected.sourceSchema ||
        typeof head.timestamp !== 'string' ||
        !/^[1-9][0-9]*$/.test(head.timestamp) ||
        !isSafeToken(head.name)
      );
    })
  ) {
    return false;
  }

  const expectedSentinels = [
    ...GLOBAL_SENTINELS.map(({ schema, table }) => ({ scope: 'global', schema, table })),
    ...tenantSchemas.flatMap((tenantSchema) =>
      TENANT_SENTINELS.map((table) => ({
        scope: 'tenant',
        schema: tenantSchema,
        table,
      })),
    ),
  ];
  return (
    payload.sentinels.length === expectedSentinels.length &&
    payload.sentinels.every((proof, index) => isSentinelProof(proof, expectedSentinels[index]))
  );
};

const postgresLsn = (value) => {
  if (typeof value !== 'string' || !/^[0-9A-F]+\/[0-9A-F]{1,8}$/.test(value)) {
    return null;
  }
  const [high, low] = value.split('/');
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
};

const CHAIN_AUTHORITY_FIELDS = Object.freeze([
  'main_sha',
  'source_system_identifier',
  'source_image_id',
  'source_image_revision',
  'source_postgres_dr_contract_sha256',
  'source_wal_g_revision',
  'walg_config_sha256',
  'walg_rotation_bundle_sha256',
]);

const hasSameChainAuthority = (left, right) =>
  CHAIN_AUTHORITY_FIELDS.every((field) => left[field] === right[field]);

const isSuccessfulBackup = (record, options) => {
  const startLsn = unsigned64(record.backup_start_lsn);
  const finishLsn = unsigned64(record.backup_finish_lsn);
  if (
    record.status !== 'success' ||
    record.full !== true ||
    record.verified !== true ||
    record.wal_verified !== true ||
    record.failure_stage !== null ||
    record.backup_type !== 'full' ||
    !isBackupName(record.backup_name) ||
    !isWalFileName(record.backup_wal_file_name) ||
    record.backup_name !== `base_${record.backup_wal_file_name}` ||
    record.backup_storage_name !== 'default' ||
    !hasExactKeys(record.backup_user_data, ['aqua_run_id', 'backup_kind', 'main_sha']) ||
    record.backup_user_data.aqua_run_id !== record.run_id ||
    record.backup_user_data.backup_kind !== 'full' ||
    record.backup_user_data.main_sha !== record.main_sha ||
    !isEvidenceTimestamp(record.backup_start_time) ||
    !isEvidenceTimestamp(record.backup_finish_time) ||
    Date.parse(record.started_at) > Date.parse(record.backup_start_time) ||
    Date.parse(record.backup_start_time) > Date.parse(record.backup_finish_time) ||
    Date.parse(record.backup_finish_time) > Date.parse(record.completed_at) ||
    startLsn === null ||
    finishLsn === null ||
    startLsn >= finishLsn ||
    !Number.isSafeInteger(record.backup_pg_version) ||
    record.backup_pg_version < 90000 ||
    record.backup_pg_version > 999999 ||
    unsigned64(record.source_system_identifier) === null ||
    record.source_system_identifier.length < 10 ||
    typeof record.source_image_id !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record.source_image_id) ||
    typeof record.source_image_revision !== 'string' ||
    !/^[0-9a-f]{40}$/.test(record.source_image_revision) ||
    record.source_image_revision === '0000000000000000000000000000000000000000' ||
    !isSha256(record.source_postgres_dr_contract_sha256) ||
    (options.expectedPostgresDrContractSha256 !== null &&
      record.source_postgres_dr_contract_sha256 !== options.expectedPostgresDrContractSha256) ||
    record.source_wal_g_revision !== EXPECTED_WALG_REVISION ||
    !isSha256(record.walg_config_sha256) ||
    !isSha256(record.walg_rotation_bundle_sha256) ||
    !Number.isInteger(record.elapsed_seconds) ||
    record.elapsed_seconds < 0
  ) {
    return false;
  }

  const elapsedSeconds = (Date.parse(record.completed_at) - Date.parse(record.started_at)) / 1000;
  return Math.abs(record.elapsed_seconds - elapsedSeconds) <= 1;
};

const isEarlierBackupInSameWalChain = (earlier, later) => {
  const earlierStart = unsigned64(earlier.backup_start_lsn);
  const earlierFinish = unsigned64(earlier.backup_finish_lsn);
  const laterStart = unsigned64(later.backup_start_lsn);
  if (earlierStart === null || earlierFinish === null || laterStart === null) return false;
  return (
    earlierStart < laterStart &&
    earlierFinish <= laterStart &&
    earlier.backup_wal_file_name < later.backup_wal_file_name
  );
};

const isSuccessfulPitr = (record, options) => {
  if (
    record.status !== 'success' ||
    record.isolated_target_attested !== true ||
    record.timestamp_recovery !== true ||
    record.wal_verified !== true ||
    record.before_sentinel_present !== true ||
    record.after_sentinel_present !== false ||
    record.promoted !== true ||
    record.database_verified !== true ||
    record.failure_stage !== null ||
    !isBackupName(record.backup_name) ||
    !isEvidenceTimestamp(record.recovery_target_time) ||
    !isEvidenceTimestamp(record.failure_time) ||
    !isEvidenceTimestamp(record.archive_observed_at) ||
    !isEvidenceTimestamp(record.source_before_sentinel_recorded_at) ||
    !isEvidenceTimestamp(record.source_after_sentinel_recorded_at) ||
    !isEvidenceTimestamp(record.source_before_commit_fence_at) ||
    !isEvidenceTimestamp(record.source_after_commit_fence_at) ||
    record.restored_before_sentinel_recorded_at !== record.source_before_sentinel_recorded_at ||
    record.restored_before_sentinel_recorded_lsn !== record.source_before_sentinel_recorded_lsn ||
    !Number.isSafeInteger(record.archive_wait_seconds) ||
    record.archive_wait_seconds < 0 ||
    record.archive_wait_seconds > options.maxRpoSeconds ||
    typeof record.archive_required_wal !== 'string' ||
    !isWalFileName(record.archive_required_wal) ||
    typeof record.archived_through_wal !== 'string' ||
    !isWalFileName(record.archived_through_wal) ||
    record.archive_required_wal > record.archived_through_wal ||
    typeof record.source_system_identifier !== 'string' ||
    !/^[0-9]{10,24}$/.test(record.source_system_identifier) ||
    record.restored_system_identifier !== record.source_system_identifier ||
    typeof record.source_image_id !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(record.source_image_id) ||
    typeof record.source_image_revision !== 'string' ||
    !/^[0-9a-f]{40}$/.test(record.source_image_revision) ||
    record.source_image_revision === '0000000000000000000000000000000000000000' ||
    !isSha256(record.source_postgres_dr_contract_sha256) ||
    (options.expectedPostgresDrContractSha256 !== null &&
      record.source_postgres_dr_contract_sha256 !== options.expectedPostgresDrContractSha256) ||
    record.source_wal_g_revision !== EXPECTED_WALG_REVISION ||
    !isSha256(record.walg_config_sha256) ||
    !isSha256(record.walg_rotation_bundle_sha256) ||
    !isSafeToken(record.target_pgdata_volume) ||
    !isSafeToken(record.target_network) ||
    record.target_read_only_rootfs !== true ||
    !isSha256(record.database_verification_sha256) ||
    !isCanonicalDatabaseVerification(record.database_verification, record.main_sha) ||
    !Number.isSafeInteger(record.rpo_seconds) ||
    record.rpo_seconds < 0 ||
    record.rpo_seconds > options.maxRpoSeconds ||
    !Number.isSafeInteger(record.rto_seconds) ||
    record.rto_seconds < 0 ||
    record.rto_seconds > options.maxRtoSeconds
  ) {
    return false;
  }

  const expectedDatabaseVerificationSha256 = createHash('sha256')
    .update(`${JSON.stringify(record.database_verification)}\n`)
    .digest('hex');
  if (record.database_verification_sha256 !== expectedDatabaseVerificationSha256) {
    return false;
  }

  const started = BigInt(Date.parse(record.started_at)) * 1_000_000n;
  const completed = BigInt(Date.parse(record.completed_at)) * 1_000_000n;
  const before = evidenceTimestampNanoseconds(record.source_before_sentinel_recorded_at);
  const beforeFence = evidenceTimestampNanoseconds(record.source_before_commit_fence_at);
  const target = evidenceTimestampNanoseconds(record.recovery_target_time);
  const after = evidenceTimestampNanoseconds(record.source_after_sentinel_recorded_at);
  const afterFence = evidenceTimestampNanoseconds(record.source_after_commit_fence_at);
  const archiveObserved = evidenceTimestampNanoseconds(record.archive_observed_at);
  const failure = evidenceTimestampNanoseconds(record.failure_time);
  const sourceBeforeLsn = postgresLsn(record.source_before_sentinel_recorded_lsn);
  const beforeFenceLsn = postgresLsn(record.source_before_commit_fence_lsn);
  const sourceAfterLsn = postgresLsn(record.source_after_sentinel_recorded_lsn);
  const afterFenceLsn = postgresLsn(record.source_after_commit_fence_lsn);
  if (
    before === null ||
    beforeFence === null ||
    target === null ||
    after === null ||
    afterFence === null ||
    archiveObserved === null ||
    failure === null ||
    sourceBeforeLsn === null ||
    beforeFenceLsn === null ||
    sourceAfterLsn === null ||
    afterFenceLsn === null
  ) {
    return false;
  }
  const derivedRpoSeconds = Number((failure - before + 999_999_999n) / 1_000_000_000n);
  const elapsedSeconds = Number((completed - started) / 1_000_000_000n);
  return (
    started <= before &&
    before <= beforeFence &&
    beforeFence <= target &&
    target < after &&
    after <= afterFence &&
    afterFence <= archiveObserved &&
    archiveObserved === failure &&
    failure <= completed &&
    sourceBeforeLsn <= beforeFenceLsn &&
    beforeFenceLsn < sourceAfterLsn &&
    sourceAfterLsn <= afterFenceLsn &&
    record.rpo_seconds === derivedRpoSeconds &&
    Math.abs(record.rto_seconds - elapsedSeconds) <= 1
  );
};

/**
 * Evaluate WAL-G closure evidence without network or filesystem access.
 *
 * @param {Array<Record<string, unknown>>} records parsed evidence records
 * @param {{minConsecutiveBackups?: number, maxRpoSeconds?: number, maxRtoSeconds?: number, expectedMainSha?: string | null, expectedPostgresDrContractSha256?: string | null}} [overrides]
 * @returns {{ok: boolean, errors: string[], qualifyingBackupRunIds: string[], pitrRunId: string | null}}
 */
export function evaluateWalgEvidence(records, overrides = {}) {
  const options = { ...DEFAULTS, ...overrides };
  const errors = [];

  if (!Array.isArray(records)) {
    return {
      ok: false,
      errors: ['evidence input must be an array'],
      qualifyingBackupRunIds: [],
      pitrRunId: null,
    };
  }
  if (
    !Number.isInteger(options.minConsecutiveBackups) ||
    options.minConsecutiveBackups < 1 ||
    !Number.isInteger(options.maxRpoSeconds) ||
    options.maxRpoSeconds < 1 ||
    !Number.isInteger(options.maxRtoSeconds) ||
    options.maxRtoSeconds < 1 ||
    (options.expectedMainSha !== null && !isMainSha(options.expectedMainSha)) ||
    (options.expectedPostgresDrContractSha256 !== null &&
      !isSha256(options.expectedPostgresDrContractSha256))
  ) {
    return {
      ok: false,
      errors: [
        'evidence thresholds must be positive integers and expected authority digests must be exact',
      ],
      qualifyingBackupRunIds: [],
      pitrRunId: null,
    };
  }

  const seenRunIds = new Set();
  const structurallyValid = [];
  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(`record ${index} is not an object`);
      return;
    }
    if (record.schema_version !== 1) {
      errors.push(`record ${index} has unsupported schema_version`);
      return;
    }
    if (!isSafeToken(record.run_id)) {
      errors.push(`record ${index} has invalid run_id`);
      return;
    }
    if (!isMainSha(record.main_sha)) {
      errors.push(`record ${index} has invalid main_sha`);
      return;
    }
    if (options.expectedMainSha !== null && record.main_sha !== options.expectedMainSha) {
      errors.push(`record ${index} main_sha does not match required current main`);
      return;
    }
    if (seenRunIds.has(record.run_id)) {
      errors.push(`duplicate run_id: ${record.run_id}`);
      return;
    }
    seenRunIds.add(record.run_id);
    if (!isTimestamp(record.started_at) || !isTimestamp(record.completed_at)) {
      errors.push(`record ${index} has invalid timestamps`);
      return;
    }
    if (Date.parse(record.completed_at) < Date.parse(record.started_at)) {
      errors.push(`record ${index} completes before it starts`);
      return;
    }
    if (record.evidence_type !== 'base_backup' && record.evidence_type !== 'timestamp_pitr') {
      errors.push(`record ${index} has unknown evidence_type`);
      return;
    }
    if (record.status !== 'success' && record.status !== 'failure') {
      errors.push(`record ${index} has invalid status`);
      return;
    }
    structurallyValid.push(record);
  });

  const backupRecords = structurallyValid
    .filter((record) => record.evidence_type === 'base_backup')
    .sort((left, right) => Date.parse(left.started_at) - Date.parse(right.started_at));
  const consecutive = [];
  const consecutiveNames = new Set();
  let latestChainAuthority = null;
  let laterBackup = null;
  for (let index = backupRecords.length - 1; index >= 0; index -= 1) {
    const record = backupRecords[index];
    if (
      !isSuccessfulBackup(record, options) ||
      consecutiveNames.has(record.backup_name) ||
      (latestChainAuthority !== null && !hasSameChainAuthority(record, latestChainAuthority)) ||
      (laterBackup !== null && !isEarlierBackupInSameWalChain(record, laterBackup))
    ) {
      break;
    }
    latestChainAuthority ??= record;
    laterBackup = record;
    consecutiveNames.add(record.backup_name);
    consecutive.unshift(record);
  }
  if (consecutive.length < options.minConsecutiveBackups) {
    errors.push(
      `requires ${options.minConsecutiveBackups} consecutive full, verified backups on one exact system/config/key/image/main WAL chain; found ${consecutive.length}`,
    );
  }

  const qualifyingBackups = consecutive.slice(-options.minConsecutiveBackups);
  const qualifyingByName = new Map(qualifyingBackups.map((record) => [record.backup_name, record]));
  const qualifyingPitr = structurallyValid
    .filter((record) => {
      if (record.evidence_type !== 'timestamp_pitr') return false;
      const matchingBackup = qualifyingByName.get(record.backup_name);
      return (
        matchingBackup !== undefined &&
        Date.parse(record.completed_at) >= Date.parse(matchingBackup.completed_at) &&
        isSuccessfulPitr(record, options) &&
        hasSameChainAuthority(record, matchingBackup) &&
        record.archive_required_wal >= matchingBackup.backup_wal_file_name
      );
    })
    .sort((left, right) => Date.parse(right.completed_at) - Date.parse(left.completed_at))[0];

  if (!qualifyingPitr) {
    errors.push(
      `requires one isolated timestamp PITR with RPO <= ${options.maxRpoSeconds}s and RTO <= ${options.maxRtoSeconds}s tied to the qualifying backup set`,
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    qualifyingBackupRunIds: qualifyingBackups.map((record) => record.run_id),
    pitrRunId: qualifyingPitr?.run_id ?? null,
  };
}

async function readEvidenceDirectory(evidenceDirectory) {
  const entries = (await readdir(evidenceDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
  if (entries.length === 0) {
    throw new Error('evidence directory contains no JSON records');
  }

  return Promise.all(
    entries.map(async (entry) => {
      const contents = await readFile(resolve(evidenceDirectory, entry), 'utf8');
      return JSON.parse(contents);
    }),
  );
}

async function main(argv) {
  if (
    argv.length !== 6 ||
    argv[0] !== '--evidence-dir' ||
    argv[2] !== '--expected-main-sha' ||
    argv[4] !== '--expected-postgres-dr-contract-sha256'
  ) {
    throw new Error(
      'usage: evaluate-walg-evidence.mjs --evidence-dir DIR --expected-main-sha SHA --expected-postgres-dr-contract-sha256 SHA256',
    );
  }
  const records = await readEvidenceDirectory(resolve(argv[1]));
  const result = evaluateWalgEvidence(records, {
    expectedMainSha: argv[3],
    expectedPostgresDrContractSha256: argv[5],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`FATAL: ${error.message}\n`);
    process.exitCode = 2;
  });
}
