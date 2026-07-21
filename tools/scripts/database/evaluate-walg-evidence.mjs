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

const PITR_SOURCE_BASE_RELATIONS = Object.freeze(
  [
    'admin.tenant_schemas',
    'auth.tenants',
    'platform.release_ledger',
    ...SOURCE_SCHEMAS.map((schema) => `${schema}.migrations`),
    ...GLOBAL_SENTINELS.map(({ schema, table }) => `${schema}.${table}`),
  ]
    .filter((relation, index, relations) => relations.indexOf(relation) === index)
    .sort(),
);

const PITR_SOURCE_TENANT_TABLES = Object.freeze(
  [...TENANT_AWARE_SCHEMAS.map((schema) => `migrations_${schema}`), ...TENANT_SENTINELS].sort(),
);

const EXPECTED_WALG_REVISION = 'f81943e64bdf97aa66f6c52fec55114703f97af7';
const WAL_MARKER_PREFIX = 'aqua.pitr.boundary.v1';
const WAL_COMMIT_FENCE_PREFIX = 'aqua.pitr.commit-fence.v1';
const MAX_RAW_EVIDENCE_BYTES = 8 * 1024 * 1024;
const BASE_EVIDENCE_KEYS = Object.freeze([
  'schema_version',
  'evidence_type',
  'run_id',
  'status',
  'main_sha',
  'started_at',
  'completed_at',
  'elapsed_seconds',
  'backup_name',
  'backup_type',
  'backup_user_data',
  'backup_wal_file_name',
  'backup_storage_name',
  'backup_start_time',
  'backup_finish_time',
  'backup_start_lsn',
  'backup_finish_lsn',
  'backup_pg_version',
  'source_system_identifier',
  'source_image_id',
  'source_image_revision',
  'source_postgres_dr_contract_sha256',
  'source_wal_g_revision',
  'walg_config_sha256',
  'walg_rotation_bundle_sha256',
  'full',
  'verified',
  'wal_verified',
  'failure_stage',
]);
const PITR_EVIDENCE_KEYS = Object.freeze([
  'schema_version',
  'evidence_type',
  'run_id',
  'status',
  'main_sha',
  'started_at',
  'completed_at',
  'backup_name',
  'recovery_target_time',
  'restored_recovery_target_time',
  'restored_recovery_target_inclusive',
  'restored_recovery_target_timeline',
  'restored_recovery_target_action',
  'failure_time',
  'wal_marker_prefix',
  'wal_commit_fence_prefix',
  'source_before_marker_content',
  'source_before_marker_content_sha256',
  'source_before_marker_emitted_at',
  'source_before_marker_lsn',
  'source_after_marker_content',
  'source_after_marker_content_sha256',
  'source_after_marker_emitted_at',
  'source_after_marker_lsn',
  'source_before_commit_fence_at',
  'source_before_commit_fence_lsn',
  'source_after_commit_fence_at',
  'source_after_commit_fence_lsn',
  'timestamp_recovery',
  'rpo_seconds',
  'rto_seconds',
  'archive_wait_seconds',
  'archive_observed_at',
  'archive_required_wal',
  'archived_through_wal',
  'source_timeline_id',
  'source_system_identifier',
  'restored_system_identifier',
  'source_image_id',
  'source_image_revision',
  'source_postgres_dr_contract_sha256',
  'source_wal_g_revision',
  'target_pgdata_volume',
  'target_network',
  'isolated_target_attested',
  'wal_verified',
  'before_wal_marker_replayed',
  'after_wal_marker_excluded',
  'promoted',
  'database_verified',
  'source_database_release_sha',
  'source_database_verification_sha256',
  'source_database_verification',
  'restored_database_release_sha',
  'restored_database_verification_sha256',
  'restored_database_verification',
  'source_verification_snapshot_id',
  'source_verification_snapshot_sha256',
  'source_verification_completed_at',
  'source_verification_floor_lsn',
  'source_verification_lock_set_sha256',
  'source_verification_lock_count',
  'source_verification_lock_relations',
  'source_verification_lock_timeout_ms',
  'source_verification_statement_timeout_ms',
  'source_verification_idle_timeout_ms',
  'restored_replay_lsn',
  'target_read_only_rootfs',
  'walg_config_sha256',
  'walg_rotation_bundle_sha256',
  'failure_stage',
]);

const isTimestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === `${value.slice(0, -1)}.000Z`;

const isEvidenceTimestamp = (value) => {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,6})?Z$/);
  return match !== null && isTimestamp(`${match[1]}Z`);
};

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

const isCanonicalDatabaseVerification = (payload) => {
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
    !isMainSha(payload.release.git_sha) ||
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

const expectedPitrSourceLockRelations = (tenantSchemas) =>
  [
    ...PITR_SOURCE_BASE_RELATIONS,
    ...tenantSchemas.flatMap((tenantSchema) =>
      PITR_SOURCE_TENANT_TABLES.map((table) => `${tenantSchema}.${table}`),
    ),
  ].sort();

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
    earlier.backup_wal_file_name.slice(0, 8) === later.backup_wal_file_name.slice(0, 8) &&
    earlierStart < laterStart &&
    earlierFinish <= laterStart &&
    earlier.backup_wal_file_name < later.backup_wal_file_name
  );
};

const isSuccessfulPitr = (record, options) => {
  const sourceSystemIdentifier = unsigned64(record.source_system_identifier);
  const sourceTimelineId = record.source_timeline_id;
  if (
    record.status !== 'success' ||
    record.isolated_target_attested !== true ||
    record.timestamp_recovery !== true ||
    record.wal_verified !== true ||
    record.before_wal_marker_replayed !== true ||
    record.after_wal_marker_excluded !== true ||
    record.promoted !== true ||
    record.database_verified !== true ||
    record.failure_stage !== null ||
    !isBackupName(record.backup_name) ||
    !isEvidenceTimestamp(record.recovery_target_time) ||
    record.restored_recovery_target_time !== record.recovery_target_time ||
    record.restored_recovery_target_inclusive !== false ||
    record.restored_recovery_target_timeline !== 'latest' ||
    record.restored_recovery_target_action !== 'promote' ||
    !isEvidenceTimestamp(record.failure_time) ||
    !isEvidenceTimestamp(record.archive_observed_at) ||
    record.wal_marker_prefix !== WAL_MARKER_PREFIX ||
    record.wal_commit_fence_prefix !== WAL_COMMIT_FENCE_PREFIX ||
    typeof record.source_before_marker_content !== 'string' ||
    !isSha256(record.source_before_marker_content_sha256) ||
    !isEvidenceTimestamp(record.source_before_marker_emitted_at) ||
    typeof record.source_after_marker_content !== 'string' ||
    !isSha256(record.source_after_marker_content_sha256) ||
    !isEvidenceTimestamp(record.source_after_marker_emitted_at) ||
    !isEvidenceTimestamp(record.source_before_commit_fence_at) ||
    !isEvidenceTimestamp(record.source_after_commit_fence_at) ||
    !Number.isSafeInteger(record.archive_wait_seconds) ||
    record.archive_wait_seconds < 0 ||
    record.archive_wait_seconds > options.maxRpoSeconds ||
    typeof record.archive_required_wal !== 'string' ||
    !isWalFileName(record.archive_required_wal) ||
    typeof record.archived_through_wal !== 'string' ||
    !isWalFileName(record.archived_through_wal) ||
    record.archive_required_wal > record.archived_through_wal ||
    sourceSystemIdentifier === null ||
    record.source_system_identifier.length < 10 ||
    record.restored_system_identifier !== record.source_system_identifier ||
    !Number.isSafeInteger(sourceTimelineId) ||
    sourceTimelineId < 1 ||
    sourceTimelineId > 0xffffffff ||
    Number.parseInt(record.archive_required_wal.slice(0, 8), 16) !== sourceTimelineId ||
    Number.parseInt(record.archived_through_wal.slice(0, 8), 16) !== sourceTimelineId ||
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
    !isMainSha(record.source_database_release_sha) ||
    !isSha256(record.source_database_verification_sha256) ||
    !isCanonicalDatabaseVerification(record.source_database_verification) ||
    !isMainSha(record.restored_database_release_sha) ||
    !isSha256(record.restored_database_verification_sha256) ||
    !isCanonicalDatabaseVerification(record.restored_database_verification) ||
    typeof record.source_verification_snapshot_id !== 'string' ||
    !/^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{8}-[1-9][0-9]*$/.test(record.source_verification_snapshot_id) ||
    !isSha256(record.source_verification_snapshot_sha256) ||
    !isEvidenceTimestamp(record.source_verification_completed_at) ||
    !isSha256(record.source_verification_lock_set_sha256) ||
    !Number.isSafeInteger(record.source_verification_lock_count) ||
    record.source_verification_lock_count < 0 ||
    !Array.isArray(record.source_verification_lock_relations) ||
    record.source_verification_lock_timeout_ms !== 5000 ||
    record.source_verification_statement_timeout_ms !== 120000 ||
    record.source_verification_idle_timeout_ms !== 30000 ||
    !Number.isSafeInteger(record.rpo_seconds) ||
    record.rpo_seconds < 0 ||
    record.rpo_seconds > options.maxRpoSeconds ||
    !Number.isSafeInteger(record.rto_seconds) ||
    record.rto_seconds < 0 ||
    record.rto_seconds > options.maxRtoSeconds
  ) {
    return false;
  }

  const sourceDatabaseVerificationBytes = `${JSON.stringify(
    record.source_database_verification,
  )}\n`;
  const restoredDatabaseVerificationBytes = `${JSON.stringify(
    record.restored_database_verification,
  )}\n`;
  const expectedSourceDatabaseVerificationSha256 = createHash('sha256')
    .update(sourceDatabaseVerificationBytes)
    .digest('hex');
  const expectedRestoredDatabaseVerificationSha256 = createHash('sha256')
    .update(restoredDatabaseVerificationBytes)
    .digest('hex');
  const expectedSnapshotSha256 = createHash('sha256')
    .update(record.source_verification_snapshot_id)
    .digest('hex');
  const expectedLockRelations = expectedPitrSourceLockRelations(
    record.source_database_verification.tenant_schemas,
  );
  const expectedLockSetSha256 = createHash('sha256')
    .update(expectedLockRelations.join('\n'))
    .digest('hex');
  const expectedLockCount = expectedLockRelations.length;
  const expectedBeforeMarkerContent = JSON.stringify({
    backup_name: record.backup_name,
    main_sha: record.main_sha,
    phase: 'BEFORE',
    run_id: record.run_id,
  });
  const expectedAfterMarkerContent = JSON.stringify({
    backup_name: record.backup_name,
    main_sha: record.main_sha,
    phase: 'AFTER',
    run_id: record.run_id,
  });
  const expectedBeforeMarkerSha256 = createHash('sha256')
    .update(expectedBeforeMarkerContent)
    .digest('hex');
  const expectedAfterMarkerSha256 = createHash('sha256')
    .update(expectedAfterMarkerContent)
    .digest('hex');
  if (
    sourceDatabaseVerificationBytes !== restoredDatabaseVerificationBytes ||
    record.source_database_verification_sha256 !== expectedSourceDatabaseVerificationSha256 ||
    record.restored_database_verification_sha256 !== expectedRestoredDatabaseVerificationSha256 ||
    record.source_database_verification_sha256 !== record.restored_database_verification_sha256 ||
    record.source_database_release_sha !== record.source_database_verification.release.git_sha ||
    record.restored_database_release_sha !==
      record.restored_database_verification.release.git_sha ||
    record.source_database_release_sha !== record.restored_database_release_sha ||
    record.source_verification_snapshot_sha256 !== expectedSnapshotSha256 ||
    !hasExactStringArray(record.source_verification_lock_relations, expectedLockRelations) ||
    record.source_verification_lock_count !== record.source_verification_lock_relations.length ||
    record.source_verification_lock_count !== expectedLockCount ||
    record.source_verification_lock_set_sha256 !== expectedLockSetSha256 ||
    record.source_before_marker_content !== expectedBeforeMarkerContent ||
    record.source_before_marker_content_sha256 !== expectedBeforeMarkerSha256 ||
    record.source_after_marker_content !== expectedAfterMarkerContent ||
    record.source_after_marker_content_sha256 !== expectedAfterMarkerSha256
  ) {
    return false;
  }

  const started = BigInt(Date.parse(record.started_at)) * 1_000_000n;
  const completed = BigInt(Date.parse(record.completed_at)) * 1_000_000n;
  const before = evidenceTimestampNanoseconds(record.source_before_marker_emitted_at);
  const beforeFence = evidenceTimestampNanoseconds(record.source_before_commit_fence_at);
  const sourceVerificationCompleted = evidenceTimestampNanoseconds(
    record.source_verification_completed_at,
  );
  const target = evidenceTimestampNanoseconds(record.recovery_target_time);
  const after = evidenceTimestampNanoseconds(record.source_after_marker_emitted_at);
  const afterFence = evidenceTimestampNanoseconds(record.source_after_commit_fence_at);
  const archiveObserved = evidenceTimestampNanoseconds(record.archive_observed_at);
  const failure = evidenceTimestampNanoseconds(record.failure_time);
  const sourceBeforeLsn = postgresLsn(record.source_before_marker_lsn);
  const beforeFenceLsn = postgresLsn(record.source_before_commit_fence_lsn);
  const sourceVerificationFloorLsn = postgresLsn(record.source_verification_floor_lsn);
  const restoredReplayLsn = postgresLsn(record.restored_replay_lsn);
  const sourceAfterLsn = postgresLsn(record.source_after_marker_lsn);
  const afterFenceLsn = postgresLsn(record.source_after_commit_fence_lsn);
  if (
    before === null ||
    beforeFence === null ||
    sourceVerificationCompleted === null ||
    target === null ||
    after === null ||
    afterFence === null ||
    archiveObserved === null ||
    failure === null ||
    sourceBeforeLsn === null ||
    beforeFenceLsn === null ||
    sourceVerificationFloorLsn === null ||
    restoredReplayLsn === null ||
    sourceAfterLsn === null ||
    afterFenceLsn === null
  ) {
    return false;
  }
  const derivedRpoSeconds = Number((failure - before + 999_999_999n) / 1_000_000_000n);
  const elapsedSeconds = Number((completed - started) / 1_000_000_000n);
  // The AFTER logical-message record may be physically replayed before PostgreSQL
  // stops ahead of its COMMIT. The exclusive timestamp target plus the exact
  // post-COMMIT fence proves transaction exclusion; it does not claim that the
  // raw logical-message record was absent from physical replay.
  return (
    started <= before &&
    before <= beforeFence &&
    beforeFence <= sourceVerificationCompleted &&
    sourceVerificationCompleted + 2_000_000_000n === target &&
    target < after &&
    after <= afterFence &&
    afterFence <= archiveObserved &&
    archiveObserved === failure &&
    failure <= completed &&
    sourceBeforeLsn < beforeFenceLsn &&
    beforeFenceLsn <= sourceVerificationFloorLsn &&
    sourceVerificationFloorLsn <= sourceAfterLsn &&
    sourceAfterLsn < afterFenceLsn &&
    sourceVerificationFloorLsn <= restoredReplayLsn &&
    restoredReplayLsn < afterFenceLsn &&
    record.rpo_seconds === derivedRpoSeconds &&
    Math.abs(record.rto_seconds - elapsedSeconds) <= 1
  );
};

const isNullableString = (value) => value === null || typeof value === 'string';

function evidenceSchemaError(message) {
  throw new Error(`closed raw evidence schema: ${message}`);
}

function requireEvidenceShape(condition, message) {
  if (!condition) evidenceSchemaError(message);
}

function validateBaseEvidenceShape(record) {
  requireEvidenceShape(
    hasExactKeys(record, BASE_EVIDENCE_KEYS),
    'base_backup has an unexpected key set',
  );
  requireEvidenceShape(
    Number.isSafeInteger(record.elapsed_seconds) && record.elapsed_seconds >= 0,
    'base_backup elapsed_seconds must be a nonnegative safe integer',
  );
  for (const key of [
    'backup_name',
    'backup_type',
    'backup_wal_file_name',
    'backup_storage_name',
    'backup_start_time',
    'backup_finish_time',
    'backup_start_lsn',
    'backup_finish_lsn',
    'source_system_identifier',
    'source_image_id',
    'source_image_revision',
    'source_postgres_dr_contract_sha256',
    'source_wal_g_revision',
    'walg_config_sha256',
    'walg_rotation_bundle_sha256',
  ]) {
    requireEvidenceShape(isNullableString(record[key]), `base_backup ${key} has invalid type`);
  }
  requireEvidenceShape(
    record.backup_pg_version === null || Number.isSafeInteger(record.backup_pg_version),
    'base_backup backup_pg_version has invalid type',
  );
  requireEvidenceShape(
    record.backup_user_data === null ||
      (hasExactKeys(record.backup_user_data, ['aqua_run_id', 'backup_kind', 'main_sha']) &&
        Object.values(record.backup_user_data).every((value) => typeof value === 'string')),
    'base_backup backup_user_data is not a closed string record',
  );
  for (const key of ['full', 'verified', 'wal_verified']) {
    requireEvidenceShape(typeof record[key] === 'boolean', `base_backup ${key} must be boolean`);
  }
}

function validatePitrEvidenceShape(record) {
  requireEvidenceShape(
    hasExactKeys(record, PITR_EVIDENCE_KEYS),
    'timestamp_pitr has an unexpected key set',
  );
  requireEvidenceShape(
    typeof record.backup_name === 'string',
    'timestamp_pitr backup_name invalid',
  );
  for (const key of [
    'recovery_target_time',
    'restored_recovery_target_time',
    'restored_recovery_target_timeline',
    'restored_recovery_target_action',
    'failure_time',
    'source_before_marker_content',
    'source_before_marker_content_sha256',
    'source_before_marker_emitted_at',
    'source_before_marker_lsn',
    'source_after_marker_content',
    'source_after_marker_content_sha256',
    'source_after_marker_emitted_at',
    'source_after_marker_lsn',
    'source_before_commit_fence_at',
    'source_before_commit_fence_lsn',
    'source_after_commit_fence_at',
    'source_after_commit_fence_lsn',
    'archive_observed_at',
    'archive_required_wal',
    'archived_through_wal',
    'source_system_identifier',
    'restored_system_identifier',
    'source_image_id',
    'source_image_revision',
    'source_postgres_dr_contract_sha256',
    'source_wal_g_revision',
    'source_database_release_sha',
    'source_database_verification_sha256',
    'restored_database_release_sha',
    'restored_database_verification_sha256',
    'source_verification_snapshot_id',
    'source_verification_snapshot_sha256',
    'source_verification_completed_at',
    'source_verification_floor_lsn',
    'source_verification_lock_set_sha256',
    'restored_replay_lsn',
    'walg_config_sha256',
    'walg_rotation_bundle_sha256',
  ]) {
    requireEvidenceShape(isNullableString(record[key]), `timestamp_pitr ${key} has invalid type`);
  }
  requireEvidenceShape(
    record.wal_marker_prefix === WAL_MARKER_PREFIX,
    'timestamp_pitr wal_marker_prefix is invalid',
  );
  requireEvidenceShape(
    record.wal_commit_fence_prefix === WAL_COMMIT_FENCE_PREFIX,
    'timestamp_pitr wal_commit_fence_prefix is invalid',
  );
  requireEvidenceShape(
    record.restored_recovery_target_inclusive === null ||
      typeof record.restored_recovery_target_inclusive === 'boolean',
    'timestamp_pitr restored_recovery_target_inclusive has invalid type',
  );
  for (const key of ['target_pgdata_volume', 'target_network']) {
    requireEvidenceShape(typeof record[key] === 'string', `timestamp_pitr ${key} must be string`);
  }
  for (const key of ['rpo_seconds', 'rto_seconds', 'archive_wait_seconds']) {
    requireEvidenceShape(
      Number.isSafeInteger(record[key]),
      `timestamp_pitr ${key} must be integer`,
    );
  }
  requireEvidenceShape(
    record.source_timeline_id === null || Number.isSafeInteger(record.source_timeline_id),
    'timestamp_pitr source_timeline_id has invalid type',
  );
  requireEvidenceShape(
    record.source_verification_lock_relations === null ||
      (Array.isArray(record.source_verification_lock_relations) &&
        record.source_verification_lock_relations.every(
          (relation) => typeof relation === 'string',
        )),
    'timestamp_pitr source_verification_lock_relations has invalid type',
  );
  requireEvidenceShape(
    record.source_verification_lock_count === null ||
      (Number.isSafeInteger(record.source_verification_lock_count) &&
        record.source_verification_lock_count >= 0),
    'timestamp_pitr source_verification_lock_count has invalid type',
  );
  for (const key of [
    'source_verification_lock_timeout_ms',
    'source_verification_statement_timeout_ms',
    'source_verification_idle_timeout_ms',
  ]) {
    requireEvidenceShape(
      record[key] === null || (Number.isSafeInteger(record[key]) && record[key] > 0),
      `timestamp_pitr ${key} has invalid type`,
    );
  }
  for (const key of [
    'timestamp_recovery',
    'isolated_target_attested',
    'wal_verified',
    'before_wal_marker_replayed',
    'after_wal_marker_excluded',
    'promoted',
    'database_verified',
    'target_read_only_rootfs',
  ]) {
    requireEvidenceShape(typeof record[key] === 'boolean', `timestamp_pitr ${key} must be boolean`);
  }
  requireEvidenceShape(
    record.source_database_verification === null ||
      isCanonicalDatabaseVerification(record.source_database_verification),
    'timestamp_pitr source_database_verification is not canonical',
  );
  requireEvidenceShape(
    record.restored_database_verification === null ||
      isCanonicalDatabaseVerification(record.restored_database_verification),
    'timestamp_pitr restored_database_verification is not canonical',
  );
  if (record.status === 'failure') {
    requireEvidenceShape(
      record.source_database_release_sha === null && record.restored_database_release_sha === null,
      'failed timestamp_pitr database release SHAs must be null',
    );
  }
}

/**
 * Validate one exact producer record, including all single-record success
 * semantics. Cross-record backup-chain and PITR-selection rules remain in the
 * closure evaluator below.
 *
 * @param {Record<string, unknown>} record
 * @param {{maxRpoSeconds?: number, maxRtoSeconds?: number, expectedMainSha?: string | null, expectedPostgresDrContractSha256?: string | null}} [overrides]
 * @returns {Record<string, unknown>}
 */
export function validateWalgEvidenceRecord(record, overrides = {}) {
  const options = { ...DEFAULTS, ...overrides };
  requireEvidenceShape(isRecord(record), 'record must be an object');
  requireEvidenceShape(
    record.evidence_type === 'base_backup' || record.evidence_type === 'timestamp_pitr',
    'evidence_type is unsupported',
  );
  const expectedSchemaVersion = record.evidence_type === 'base_backup' ? 1 : 2;
  requireEvidenceShape(
    record.schema_version === expectedSchemaVersion,
    `${record.evidence_type} schema_version must be ${expectedSchemaVersion}`,
  );
  requireEvidenceShape(isSafeToken(record.run_id), 'run_id is invalid');
  requireEvidenceShape(isMainSha(record.main_sha), 'main_sha is invalid');
  requireEvidenceShape(
    record.status === 'success' || record.status === 'failure',
    'status is invalid',
  );
  requireEvidenceShape(isTimestamp(record.started_at), 'started_at is not exact UTC');
  requireEvidenceShape(isTimestamp(record.completed_at), 'completed_at is not exact UTC');
  requireEvidenceShape(
    Date.parse(record.started_at) <= Date.parse(record.completed_at),
    'completed_at precedes started_at',
  );
  requireEvidenceShape(
    record.failure_stage === null ||
      (typeof record.failure_stage === 'string' &&
        record.failure_stage.length > 0 &&
        record.failure_stage.length <= 120),
    'failure_stage has invalid type or length',
  );

  if (record.evidence_type === 'base_backup') validateBaseEvidenceShape(record);
  else validatePitrEvidenceShape(record);

  if (record.status === 'success') {
    requireEvidenceShape(record.failure_stage === null, 'successful evidence has failure_stage');
    const valid =
      record.evidence_type === 'base_backup'
        ? isSuccessfulBackup(record, options)
        : isSuccessfulPitr(record, options);
    requireEvidenceShape(valid, `${record.evidence_type} success semantics are invalid`);
  } else {
    requireEvidenceShape(
      typeof record.failure_stage === 'string' && record.failure_stage.length > 0,
      'failed evidence requires failure_stage',
    );
  }
  return record;
}

/**
 * Parse the byte-exact raw artifact form. Parse/serialize equality rejects
 * duplicate keys at every nesting level as well as noncompact encodings.
 *
 * @param {Uint8Array} input
 * @param {string} [field]
 * @param {Parameters<typeof validateWalgEvidenceRecord>[1]} [overrides]
 * @returns {Record<string, unknown>}
 */
export function parseCanonicalWalgEvidenceBytes(input, field = 'evidence', overrides = {}) {
  const bytes = Buffer.from(input);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_RAW_EVIDENCE_BYTES) {
    throw new Error(`${field} must contain between 1 and ${MAX_RAW_EVIDENCE_BYTES} bytes`);
  }
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  requireEvidenceShape(isRecord(record), `${field} must contain one object`);
  if (!bytes.equals(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))) {
    throw new Error(`${field} must be canonical one-line JSON with one trailing newline`);
  }
  return validateWalgEvidenceRecord(record, overrides);
}

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
    try {
      validateWalgEvidenceRecord(record, options);
    } catch (error) {
      errors.push(
        `record ${index} violates the closed raw evidence schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
      const recoveryTarget = evidenceTimestampNanoseconds(record.recovery_target_time);
      const backupFinish = evidenceTimestampNanoseconds(matchingBackup?.backup_finish_time);
      return (
        matchingBackup !== undefined &&
        recoveryTarget !== null &&
        backupFinish !== null &&
        Date.parse(record.started_at) >= Date.parse(matchingBackup.completed_at) &&
        Date.parse(record.completed_at) >= Date.parse(matchingBackup.completed_at) &&
        recoveryTarget >= backupFinish &&
        isSuccessfulPitr(record, options) &&
        hasSameChainAuthority(record, matchingBackup) &&
        Number.parseInt(matchingBackup.backup_wal_file_name.slice(0, 8), 16) ===
          record.source_timeline_id &&
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
      const bytes = await readFile(resolve(evidenceDirectory, entry));
      return parseCanonicalWalgEvidenceBytes(bytes, entry);
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
