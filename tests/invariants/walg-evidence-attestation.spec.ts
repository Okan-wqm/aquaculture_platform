import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TOOL = join(REPO_ROOT, 'tools/scripts/database/walg-evidence-attestation.mjs');
const EVALUATOR = join(REPO_ROOT, 'tools/scripts/database/evaluate-walg-evidence.mjs');
const MAIN_SHA = 'a'.repeat(40);
const DATABASE_RELEASE_SHA = '7'.repeat(40);
const SOURCE_IMAGE_REVISION = '9'.repeat(40);
const POSTGRES_DR_CONTRACT_SHA256 = 'f'.repeat(64);
const RAW_ARTIFACT_ID = '456';
const RAW_ARTIFACT_NAME = 'walg-raw-evidence-v1-backup-production.yml-123-2';
const RAW_ARTIFACT_DIGEST = `sha256:${'d'.repeat(64)}`;
const RAW_ARTIFACT_CREATED_AT = '2026-07-16T03:20:00Z';
const WALG_REVISION = 'f81943e64bdf97aa66f6c52fec55114703f97af7';
const CANONICAL_SCHEMAS = [
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
] as const;
const SOURCE_SCHEMAS = CANONICAL_SCHEMAS.slice(0, 14);
const TENANT_AWARE_SCHEMAS = [
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'alert',
  'ai',
] as const;
const TENANT_SENTINELS = [
  'farms',
  'sensors',
  'employees',
  'channels',
  'hydroponics_config',
  'alert_rules',
  'agent_conversations',
] as const;
const PITR_BASE_RELATIONS = [
  'admin.migrations',
  'admin.tenant_schemas',
  'ai.migrations',
  'alert.migrations',
  'auth.migrations',
  'auth.tenants',
  'auth.users',
  'billing.migrations',
  'billing.subscriptions',
  'config.migrations',
  'event_store.migrations',
  'farm.migrations',
  'hr.migrations',
  'hydroponics.migrations',
  'messaging.migrations',
  'notification.migrations',
  'observability.migrations',
  'platform.release_ledger',
  'sensor.migrations',
] as const;
const PITR_TENANT_TABLES = [
  'agent_conversations',
  'alert_rules',
  'channels',
  'employees',
  'farms',
  'hydroponics_config',
  'migrations_ai',
  'migrations_alert',
  'migrations_farm',
  'migrations_hr',
  'migrations_hydroponics',
  'migrations_messaging',
  'migrations_sensor',
  'sensors',
] as const;

const rawArtifactArgs = [
  '--artifact-id',
  RAW_ARTIFACT_ID,
  '--artifact-name',
  RAW_ARTIFACT_NAME,
  '--artifact-digest',
  RAW_ARTIFACT_DIGEST,
  '--artifact-created-at',
  RAW_ARTIFACT_CREATED_AT,
] as const;
const pitrRawArtifactArgs = [
  '--artifact-id',
  RAW_ARTIFACT_ID,
  '--artifact-name',
  'walg-raw-evidence-v1-pitr-restore-production.yml-123-2',
  '--artifact-digest',
  RAW_ARTIFACT_DIGEST,
  '--artifact-created-at',
  RAW_ARTIFACT_CREATED_AT,
] as const;

function baseEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const walFileName = '000000010000000000000001';
  return {
    schema_version: 1,
    evidence_type: 'base_backup',
    run_id: 'gha-123-2',
    status: 'success',
    main_sha: MAIN_SHA,
    started_at: '2026-07-16T03:00:00Z',
    completed_at: '2026-07-16T03:01:00Z',
    elapsed_seconds: 60,
    backup_name: `base_${walFileName}`,
    backup_type: 'full',
    backup_user_data: {
      aqua_run_id: 'gha-123-2',
      backup_kind: 'full',
      main_sha: MAIN_SHA,
    },
    backup_wal_file_name: walFileName,
    backup_storage_name: 'default',
    backup_start_time: '2026-07-16T03:00:10.000000Z',
    backup_finish_time: '2026-07-16T03:00:50.000000Z',
    backup_start_lsn: '16777216',
    backup_finish_lsn: '16777432',
    backup_pg_version: 160013,
    source_system_identifier: '7500000000000000000',
    source_image_id: `sha256:${'8'.repeat(64)}`,
    source_image_revision: SOURCE_IMAGE_REVISION,
    source_postgres_dr_contract_sha256: POSTGRES_DR_CONTRACT_SHA256,
    source_wal_g_revision: WALG_REVISION,
    walg_config_sha256: '1'.repeat(64),
    walg_rotation_bundle_sha256: '2'.repeat(64),
    full: true,
    verified: true,
    wal_verified: true,
    failure_stage: null,
    ...overrides,
  };
}

function databaseVerification(tenantCount: number): Record<string, unknown> {
  const tenants = Array.from(
    { length: tenantCount },
    (_, index) => `tenant_${index.toString(16).padStart(16, '0')}`,
  );
  const migrationHead = (identity: Record<string, string>): Record<string, string> => ({
    ...identity,
    timestamp: '1760000000000',
    name: 'CanonicalHead1760000000000',
  });
  const sentinel = (
    scope: 'global' | 'tenant',
    schema: string,
    table: string,
  ): Record<string, unknown> => ({
    scope,
    schema,
    table,
    row_count: 1,
    checksum: 'c'.repeat(32),
  });
  return {
    contract_version: 1,
    canonical_schemas: [...CANONICAL_SCHEMAS],
    tenant_schemas: tenants,
    release: { release_id: 'release-fra1-20260716', git_sha: DATABASE_RELEASE_SHA },
    migration_heads: {
      schemas: SOURCE_SCHEMAS.map((schema) => migrationHead({ schema })),
      tenants: tenants.flatMap((tenantSchema) =>
        TENANT_AWARE_SCHEMAS.map((sourceSchema) =>
          migrationHead({ tenant_schema: tenantSchema, source_schema: sourceSchema }),
        ),
      ),
    },
    sentinels: [
      sentinel('global', 'auth', 'tenants'),
      sentinel('global', 'auth', 'users'),
      sentinel('global', 'billing', 'subscriptions'),
      ...tenants.flatMap((tenantSchema) =>
        TENANT_SENTINELS.map((table) => sentinel('tenant', tenantSchema, table)),
      ),
    ],
  };
}

function pitrSourceLockRelations(tenantSchemas: readonly string[]): string[] {
  return [
    ...PITR_BASE_RELATIONS,
    ...tenantSchemas.flatMap((tenantSchema) =>
      PITR_TENANT_TABLES.map((table) => `${tenantSchema}.${table}`),
    ),
  ].sort();
}

function walMarkerContent(
  backupName: string,
  mainSha: string,
  phase: 'BEFORE' | 'AFTER',
  runId: string,
): string {
  return JSON.stringify({ backup_name: backupName, main_sha: mainSha, phase, run_id: runId });
}

function pitrEvidence(tenantCount: number, overrides: Record<string, unknown> = {}) {
  const sourceVerification = databaseVerification(tenantCount);
  const restoredVerification = databaseVerification(tenantCount);
  const tenantSchemas = Array.from(
    { length: tenantCount },
    (_, index) => `tenant_${index.toString(16).padStart(16, '0')}`,
  );
  const snapshotId = '00000001-00000001-1';
  const lockRelations = pitrSourceLockRelations(tenantSchemas);
  const runId = 'gha-123-2';
  const backupName = 'base_000000010000000000000001';
  const beforeMarkerContent = walMarkerContent(backupName, MAIN_SHA, 'BEFORE', runId);
  const afterMarkerContent = walMarkerContent(backupName, MAIN_SHA, 'AFTER', runId);
  return {
    schema_version: 2,
    evidence_type: 'timestamp_pitr',
    run_id: runId,
    status: 'success',
    main_sha: MAIN_SHA,
    started_at: '2026-07-16T03:00:00Z',
    completed_at: '2026-07-16T03:16:00Z',
    backup_name: backupName,
    recovery_target_time: '2026-07-16T03:07:00Z',
    restored_recovery_target_time: '2026-07-16T03:07:00Z',
    restored_recovery_target_inclusive: false,
    restored_recovery_target_timeline: 'latest',
    restored_recovery_target_action: 'promote',
    failure_time: '2026-07-16T03:10:00Z',
    wal_marker_prefix: 'aqua.pitr.boundary.v1',
    wal_commit_fence_prefix: 'aqua.pitr.commit-fence.v1',
    source_before_marker_content: beforeMarkerContent,
    source_before_marker_content_sha256: createHash('sha256')
      .update(beforeMarkerContent)
      .digest('hex'),
    source_before_marker_emitted_at: '2026-07-16T03:05:00.000000Z',
    source_before_marker_lsn: '0/1000000',
    source_after_marker_content: afterMarkerContent,
    source_after_marker_content_sha256: createHash('sha256')
      .update(afterMarkerContent)
      .digest('hex'),
    source_after_marker_emitted_at: '2026-07-16T03:08:00.000000Z',
    source_after_marker_lsn: '0/2000000',
    source_before_commit_fence_at: '2026-07-16T03:06:00.000000Z',
    source_before_commit_fence_lsn: '0/1000100',
    source_after_commit_fence_at: '2026-07-16T03:08:01.000000Z',
    source_after_commit_fence_lsn: '0/2000100',
    timestamp_recovery: true,
    rpo_seconds: 300,
    rto_seconds: 960,
    archive_wait_seconds: 120,
    archive_observed_at: '2026-07-16T03:10:00Z',
    archive_required_wal: '000000010000000000000001',
    archived_through_wal: '000000010000000000000001',
    source_timeline_id: 1,
    source_system_identifier: '7500000000000000000',
    restored_system_identifier: '7500000000000000000',
    source_image_id: `sha256:${'8'.repeat(64)}`,
    source_image_revision: SOURCE_IMAGE_REVISION,
    source_postgres_dr_contract_sha256: POSTGRES_DR_CONTRACT_SHA256,
    source_wal_g_revision: WALG_REVISION,
    target_pgdata_volume: 'aqua-pitr-gha-123-2',
    target_network: 'aqua-pitr-gha-123-2',
    isolated_target_attested: true,
    wal_verified: true,
    before_wal_marker_replayed: true,
    after_wal_marker_excluded: true,
    promoted: true,
    database_verified: true,
    source_database_release_sha: DATABASE_RELEASE_SHA,
    source_database_verification_sha256: createHash('sha256')
      .update(`${JSON.stringify(sourceVerification)}\n`)
      .digest('hex'),
    source_database_verification: sourceVerification,
    restored_database_release_sha: DATABASE_RELEASE_SHA,
    restored_database_verification_sha256: createHash('sha256')
      .update(`${JSON.stringify(restoredVerification)}\n`)
      .digest('hex'),
    restored_database_verification: restoredVerification,
    source_verification_snapshot_id: snapshotId,
    source_verification_snapshot_sha256: createHash('sha256').update(snapshotId).digest('hex'),
    source_verification_completed_at: '2026-07-16T03:06:58.000000Z',
    source_verification_floor_lsn: '0/1000200',
    source_verification_lock_set_sha256: createHash('sha256')
      .update(lockRelations.join('\n'))
      .digest('hex'),
    source_verification_lock_count: lockRelations.length,
    source_verification_lock_relations: lockRelations,
    source_verification_lock_timeout_ms: 5000,
    source_verification_statement_timeout_ms: 120000,
    source_verification_idle_timeout_ms: 30000,
    restored_replay_lsn: '0/2000050',
    target_read_only_rootfs: true,
    walg_config_sha256: '1'.repeat(64),
    walg_rotation_bundle_sha256: '2'.repeat(64),
    failure_stage: null,
    ...overrides,
  };
}

function run(args: string[]) {
  return spawnSync(process.execPath, [TOOL, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
}

function runEvaluator(evidenceDirectory: string) {
  return spawnSync(
    process.execPath,
    [
      EVALUATOR,
      '--evidence-dir',
      evidenceDirectory,
      '--expected-main-sha',
      MAIN_SHA,
      '--expected-postgres-dr-contract-sha256',
      POSTGRES_DR_CONTRACT_SHA256,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
}

describe('WAL-G GitHub OIDC/Rekor evidence attestation contract', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'aqua-walg-attestation-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function createSuccessfulRun(): string {
    const output = join(directory, 'run.json');
    const result = run([
      'create-run',
      '--output',
      output,
      '--workflow',
      'backup-production.yml',
      '--workflow-name',
      'Backup - Production Postgres',
      '--repository',
      'Okan-wqm/aquaculture_platform',
      '--ref',
      'refs/heads/main',
      '--sha',
      MAIN_SHA,
      '--run-id',
      '123',
      '--run-attempt',
      '2',
      '--event-name',
      'schedule',
      '--job-result',
      'success',
      '--mode',
      'full_backup',
      '--issued-at',
      '2026-07-16T03:30:00Z',
    ]);
    expect(result.status).toBe(0);
    return output;
  }

  function createSuccessfulPitrRun(): string {
    const output = join(directory, 'pitr-run.json');
    const result = run([
      'create-run',
      '--output',
      output,
      '--workflow',
      'pitr-restore-production.yml',
      '--workflow-name',
      'PITR Restore - Production Postgres',
      '--repository',
      'Okan-wqm/aquaculture_platform',
      '--ref',
      'refs/heads/main',
      '--sha',
      MAIN_SHA,
      '--run-id',
      '123',
      '--run-attempt',
      '2',
      '--event-name',
      'workflow_dispatch',
      '--job-result',
      'success',
      '--mode',
      'timestamp_pitr',
      '--issued-at',
      '2026-07-16T03:30:00Z',
    ]);
    expect(result.status).toBe(0);
    return output;
  }

  function writeApiRun(overrides: Record<string, unknown> = {}): string {
    const path = join(directory, 'api-run.json');
    writeFileSync(
      path,
      `${JSON.stringify({
        id: 123,
        run_attempt: 2,
        head_sha: MAIN_SHA,
        head_branch: 'main',
        event: 'schedule',
        path: '.github/workflows/backup-production.yml',
        name: 'Backup - Production Postgres',
        workflow_id: 261067403,
        repository: {
          id: 1132698735,
          full_name: 'Okan-wqm/aquaculture_platform',
        },
        status: 'completed',
        conclusion: 'success',
        run_started_at: '2026-07-16T03:00:00Z',
        updated_at: '2026-07-16T03:31:00Z',
        ...overrides,
      })}\n`,
    );
    return path;
  }

  function writeApiWorkflow(): string {
    const path = join(directory, 'api-workflow.json');
    writeFileSync(
      path,
      `${JSON.stringify({
        id: 261067403,
        name: 'Backup - Production Postgres',
        path: '.github/workflows/backup-production.yml',
        state: 'active',
      })}\n`,
    );
    return path;
  }

  function writePitrApiRun(overrides: Record<string, unknown> = {}): string {
    const path = join(directory, 'pitr-api-run.json');
    writeFileSync(
      path,
      `${JSON.stringify({
        id: 123,
        run_attempt: 2,
        head_sha: MAIN_SHA,
        head_branch: 'main',
        event: 'workflow_dispatch',
        path: '.github/workflows/pitr-restore-production.yml',
        name: 'PITR Restore - Production Postgres',
        workflow_id: 300000001,
        repository: {
          id: 1132698735,
          full_name: 'Okan-wqm/aquaculture_platform',
        },
        status: 'completed',
        conclusion: 'success',
        run_started_at: '2026-07-16T03:00:00Z',
        updated_at: '2026-07-16T03:31:00Z',
        ...overrides,
      })}\n`,
    );
    return path;
  }

  function writePitrApiWorkflow(): string {
    const path = join(directory, 'pitr-api-workflow.json');
    writeFileSync(
      path,
      `${JSON.stringify({
        id: 300000001,
        name: 'PITR Restore - Production Postgres',
        path: '.github/workflows/pitr-restore-production.yml',
        state: 'active',
      })}\n`,
    );
    return path;
  }

  it('binds a promoted base backup to the exact successful main workflow run', () => {
    const runRecord = createSuccessfulRun();
    const evidence = join(directory, 'base.json');
    const attestation = join(directory, 'attestation.json');
    const extracted = join(directory, 'extracted.json');
    writeFileSync(evidence, `${JSON.stringify(baseEvidence())}\n`);

    const created = run([
      'create-evidence',
      '--output',
      attestation,
      '--run-record',
      runRecord,
      '--evidence',
      evidence,
      ...rawArtifactArgs,
      '--artifact-path',
      'base-backup.json',
    ]);
    expect(created.status).toBe(0);
    expect(JSON.parse(readFileSync(attestation, 'utf8'))).toMatchObject({
      source_transport: {
        type: 'native_openssh_stdout',
        client: 'system_openssh',
        host_key_verification: 'protected_sha256_fingerprint_exact_match',
        artifact: {
          id: 456,
          name: RAW_ARTIFACT_NAME,
          digest: RAW_ARTIFACT_DIGEST,
          path: 'base-backup.json',
          workflow_run_id: 123,
          workflow_run_attempt: 2,
          head_sha: MAIN_SHA,
          artifact_created_at: RAW_ARTIFACT_CREATED_AT,
        },
      },
      evidence_gate: {
        evidence_type: 'base_backup',
        status: 'success',
      },
    });
    expect(readFileSync(attestation, 'utf8')).not.toContain('"evidence":');
    expect(readFileSync(attestation, 'utf8')).not.toMatch(/appleboy|ssh-action/);

    const apiRun = writeApiRun();
    const apiWorkflow = writeApiWorkflow();
    expect(
      run([
        'verify-local-run',
        '--run-record',
        runRecord,
        '--workflow',
        'backup-production.yml',
        '--workflow-name',
        'Backup - Production Postgres',
        '--repository',
        'Okan-wqm/aquaculture_platform',
        '--ref',
        'refs/heads/main',
        '--sha',
        MAIN_SHA,
        '--run-id',
        '123',
        '--run-attempt',
        '2',
        '--event-name',
        'schedule',
        '--job-result',
        'success',
        '--mode',
        'full_backup',
      ]).status,
    ).toBe(0);
    expect(
      run([
        'verify-run',
        '--run-record',
        runRecord,
        '--api-run',
        apiRun,
        '--api-workflow',
        apiWorkflow,
      ]).status,
    ).toBe(0);
    expect(
      run([
        'extract-evidence',
        '--attestation',
        attestation,
        '--run-record',
        runRecord,
        '--api-run',
        apiRun,
        '--api-workflow',
        apiWorkflow,
        '--evidence',
        evidence,
        ...rawArtifactArgs,
        '--output',
        extracted,
      ]).status,
    ).toBe(0);
    expect(JSON.parse(readFileSync(extracted, 'utf8'))).toMatchObject({
      run_id: 'gha-123-2',
      main_sha: MAIN_SHA,
      status: 'success',
    });

    const tamperedAttestation = join(directory, 'tampered-attestation.json');
    const tampered = JSON.parse(readFileSync(attestation, 'utf8')) as Record<string, unknown>;
    tampered.source_transport = {
      type: 'native_openssh_stdout',
      client: 'system_openssh',
      host_key_verification: 'accept_new',
      sha256: 'b'.repeat(64),
      bytes: 1,
    };
    writeFileSync(tamperedAttestation, `${JSON.stringify(tampered)}\n`);
    expect(
      run([
        'extract-evidence',
        '--attestation',
        tamperedAttestation,
        '--run-record',
        runRecord,
        '--api-run',
        apiRun,
        '--api-workflow',
        apiWorkflow,
        '--evidence',
        evidence,
        ...rawArtifactArgs,
        '--output',
        join(directory, 'tampered-extracted.json'),
      ]).status,
    ).not.toBe(0);

    expect(
      run([
        'verify-binding',
        '--attestation',
        attestation,
        '--run-record',
        runRecord,
        '--evidence',
        evidence,
        '--artifact-id',
        RAW_ARTIFACT_ID,
        '--artifact-name',
        RAW_ARTIFACT_NAME,
        '--artifact-digest',
        RAW_ARTIFACT_DIGEST,
        '--artifact-created-at',
        '2026-07-16T03:20:01Z',
      ]).status,
    ).not.toBe(0);

    expect(
      run([
        'extract-evidence',
        '--attestation',
        attestation,
        '--run-record',
        runRecord,
        '--api-run',
        writeApiRun({ run_started_at: '2026-07-16T03:20:01Z' }),
        '--api-workflow',
        apiWorkflow,
        '--evidence',
        evidence,
        ...rawArtifactArgs,
        '--output',
        join(directory, 'out-of-interval.json'),
      ]).status,
    ).not.toBe(0);

    const replayApiRun = writeApiRun();
    const replayedEvidence = join(directory, 'replayed-base.json');
    const replayedAttestation = join(directory, 'replayed-attestation.json');
    writeFileSync(
      replayedEvidence,
      `${JSON.stringify(
        baseEvidence({
          started_at: '2026-07-15T03:00:00Z',
          completed_at: '2026-07-15T03:01:00Z',
          backup_start_time: '2026-07-15T03:00:10.000000Z',
          backup_finish_time: '2026-07-15T03:00:50.000000Z',
        }),
      )}\n`,
    );
    expect(
      run([
        'create-evidence',
        '--output',
        replayedAttestation,
        '--run-record',
        runRecord,
        '--evidence',
        replayedEvidence,
        ...rawArtifactArgs,
        '--artifact-path',
        'base-backup.json',
      ]).status,
    ).toBe(0);
    const replayResult = run([
      'extract-evidence',
      '--attestation',
      replayedAttestation,
      '--run-record',
      runRecord,
      '--api-run',
      replayApiRun,
      '--api-workflow',
      apiWorkflow,
      '--evidence',
      replayedEvidence,
      ...rawArtifactArgs,
      '--output',
      join(directory, 'replayed-output.json'),
    ]);
    expect(replayResult.status).not.toBe(0);
    expect(replayResult.stderr).toContain(
      'signed evidence lifecycle is outside the exact GitHub run interval',
    );

    const postArtifactEvidence = join(directory, 'post-artifact-base.json');
    writeFileSync(
      postArtifactEvidence,
      `${JSON.stringify(
        baseEvidence({
          started_at: '2026-07-16T03:20:01Z',
          completed_at: '2026-07-16T03:21:01Z',
          backup_start_time: '2026-07-16T03:20:11.000000Z',
          backup_finish_time: '2026-07-16T03:20:51.000000Z',
        }),
      )}\n`,
    );
    const postArtifactResult = run([
      'create-evidence',
      '--output',
      join(directory, 'post-artifact-attestation.json'),
      '--run-record',
      runRecord,
      '--evidence',
      postArtifactEvidence,
      ...rawArtifactArgs,
      '--artifact-path',
      'base-backup.json',
    ]);
    expect(postArtifactResult.status).not.toBe(0);
    expect(postArtifactResult.stderr).toContain(
      'evidence lifecycle must complete before artifact creation and signing',
    );
  });

  it('binds every byte of tenant-scale proof containing a configured-secret-like substring', () => {
    const runRecord = createSuccessfulPitrRun();
    const evidence = join(directory, 'tenant-scale-pitr.json');
    const attestation = join(directory, 'tenant-scale-attestation.json');
    const extracted = join(directory, 'tenant-scale-extracted.json');
    const configuredSecretLikeSubstring = 'fra1';
    writeFileSync(evidence, `${JSON.stringify(pitrEvidence(1100))}\n`);
    expect(readFileSync(evidence).byteLength).toBeGreaterThan(262144);
    expect(readFileSync(evidence, 'utf8')).toContain(configuredSecretLikeSubstring);

    expect(
      run([
        'create-evidence',
        '--output',
        attestation,
        '--run-record',
        runRecord,
        '--evidence',
        evidence,
        ...pitrRawArtifactArgs,
        '--artifact-path',
        'timestamp-pitr.json',
      ]).status,
    ).toBe(0);
    const signedRecord = readFileSync(attestation, 'utf8');
    expect(JSON.parse(signedRecord)).toMatchObject({
      evidence_gate: {
        schema_version: 2,
        database_verified: true,
        recovery_target_time: '2026-07-16T03:07:00Z',
        restored_recovery_target_time: '2026-07-16T03:07:00Z',
        restored_recovery_target_inclusive: false,
        restored_recovery_target_timeline: 'latest',
        restored_recovery_target_action: 'promote',
        wal_marker_prefix: 'aqua.pitr.boundary.v1',
        wal_commit_fence_prefix: 'aqua.pitr.commit-fence.v1',
        source_before_marker_content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        source_after_marker_content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        before_wal_marker_replayed: true,
        after_wal_marker_excluded: true,
        source_database_release_sha: DATABASE_RELEASE_SHA,
        source_database_verification_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        restored_database_release_sha: DATABASE_RELEASE_SHA,
        restored_database_verification_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        source_verification_snapshot_id: '00000001-00000001-1',
        source_verification_snapshot_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        source_verification_completed_at: '2026-07-16T03:06:58.000000Z',
        source_verification_floor_lsn: '0/1000200',
        source_verification_lock_set_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        source_verification_lock_count: 15419,
        source_verification_lock_timeout_ms: 5000,
        source_verification_statement_timeout_ms: 120000,
        source_verification_idle_timeout_ms: 30000,
        restored_replay_lsn: '0/2000050',
      },
    });
    expect(Buffer.byteLength(signedRecord)).toBeLessThan(262144);
    expect(signedRecord).not.toContain(configuredSecretLikeSubstring);
    expect(
      run([
        'verify-binding',
        '--attestation',
        attestation,
        '--run-record',
        runRecord,
        '--evidence',
        evidence,
        ...pitrRawArtifactArgs,
      ]).status,
    ).toBe(0);
    expect(
      run([
        'extract-evidence',
        '--attestation',
        attestation,
        '--run-record',
        runRecord,
        '--api-run',
        writePitrApiRun(),
        '--api-workflow',
        writePitrApiWorkflow(),
        '--evidence',
        evidence,
        ...pitrRawArtifactArgs,
        '--output',
        extracted,
      ]).status,
    ).toBe(0);
    expect(readFileSync(extracted).equals(readFileSync(evidence))).toBe(true);

    const tamperedEvidence = join(directory, 'tampered-tenant-scale-pitr.json');
    const tampered = JSON.parse(readFileSync(evidence, 'utf8')) as Record<string, unknown>;
    tampered.source_database_verification_sha256 = 'e'.repeat(64);
    writeFileSync(tamperedEvidence, `${JSON.stringify(tampered)}\n`);
    expect(
      run([
        'verify-binding',
        '--attestation',
        attestation,
        '--run-record',
        runRecord,
        '--evidence',
        tamperedEvidence,
        ...pitrRawArtifactArgs,
      ]).status,
    ).not.toBe(0);
    expect(
      run([
        'verify-binding',
        '--attestation',
        attestation,
        '--run-record',
        runRecord,
        '--evidence',
        evidence,
        '--artifact-id',
        RAW_ARTIFACT_ID,
        '--artifact-name',
        'walg-raw-evidence-v1-pitr-restore-production.yml-999-1',
        '--artifact-digest',
        RAW_ARTIFACT_DIGEST,
        '--artifact-created-at',
        RAW_ARTIFACT_CREATED_AT,
      ]).status,
    ).not.toBe(0);
  });

  it('rejects noncanonical or extended signed records before the signer can use them', () => {
    const runRecord = createSuccessfulRun();
    const originalRun = JSON.parse(readFileSync(runRecord, 'utf8')) as Record<string, unknown>;
    const localVerificationArgs = [
      'verify-local-run',
      '--workflow',
      'backup-production.yml',
      '--workflow-name',
      'Backup - Production Postgres',
      '--repository',
      'Okan-wqm/aquaculture_platform',
      '--ref',
      'refs/heads/main',
      '--sha',
      MAIN_SHA,
      '--run-id',
      '123',
      '--run-attempt',
      '2',
      '--event-name',
      'schedule',
      '--job-result',
      'success',
      '--mode',
      'full_backup',
    ];

    const extendedRun = join(directory, 'extended-run.json');
    writeFileSync(
      extendedRun,
      `${JSON.stringify({ ...originalRun, unsigned_payload: 'forbidden' })}\n`,
    );
    expect(run([...localVerificationArgs, '--run-record', extendedRun]).status).not.toBe(0);

    const prettyRun = join(directory, 'pretty-run.json');
    writeFileSync(prettyRun, `{\n${JSON.stringify(originalRun).slice(1)}\n`);
    expect(run([...localVerificationArgs, '--run-record', prettyRun]).status).not.toBe(0);

    const duplicateRun = join(directory, 'duplicate-run.json');
    const duplicateBytes = readFileSync(runRecord, 'utf8')
      .trimEnd()
      .replace(/\}$/u, ',"mode":"full_backup"}');
    writeFileSync(duplicateRun, `${duplicateBytes}\n`);
    expect(run([...localVerificationArgs, '--run-record', duplicateRun]).status).not.toBe(0);

    const evidence = join(directory, 'strict-base.json');
    const attestation = join(directory, 'strict-attestation.json');
    writeFileSync(evidence, `${JSON.stringify(baseEvidence())}\n`);
    expect(
      run([
        'create-evidence',
        '--output',
        attestation,
        '--run-record',
        runRecord,
        '--evidence',
        evidence,
        ...rawArtifactArgs,
        '--artifact-path',
        'base-backup.json',
      ]).status,
    ).toBe(0);
    const extendedAttestation = join(directory, 'extended-attestation.json');
    const attestationValue = JSON.parse(readFileSync(attestation, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(
      extendedAttestation,
      `${JSON.stringify({ ...attestationValue, unsigned_payload: 'forbidden' })}\n`,
    );
    expect(
      run([
        'verify-binding',
        '--attestation',
        extendedAttestation,
        '--run-record',
        runRecord,
        '--evidence',
        evidence,
        ...rawArtifactArgs,
      ]).status,
    ).not.toBe(0);
  });

  it('uses one closed raw schema before signing and during final evaluation', () => {
    const runRecord = createSuccessfulRun();
    const cases: Array<{ name: string; bytes: string }> = [];

    cases.push({
      name: 'unknown-top',
      bytes: `${JSON.stringify(baseEvidence({ extra: true }))}\n`,
    });

    const missing = baseEvidence();
    delete missing.backup_storage_name;
    cases.push({ name: 'missing-top', bytes: `${JSON.stringify(missing)}\n` });

    const unknownNested = baseEvidence();
    unknownNested.backup_user_data = {
      ...((unknownNested.backup_user_data as Record<string, unknown>) ?? {}),
      extra: true,
    };
    cases.push({ name: 'unknown-nested', bytes: `${JSON.stringify(unknownNested)}\n` });

    const malformedNested = pitrEvidence(1);
    const malformedVerification = malformedNested.source_database_verification as Record<
      string,
      unknown
    >;
    const malformedSentinels = malformedVerification.sentinels as Array<Record<string, unknown>>;
    malformedSentinels[0] = { ...malformedSentinels[0], row_count: '1' };
    malformedNested.source_database_verification_sha256 = createHash('sha256')
      .update(`${JSON.stringify(malformedVerification)}\n`)
      .digest('hex');
    cases.push({ name: 'malformed-nested', bytes: `${JSON.stringify(malformedNested)}\n` });

    const duplicate = `${JSON.stringify(baseEvidence()).replace(/^\{/u, '{"schema_version":1,')}\n`;
    cases.push({ name: 'duplicate-key', bytes: duplicate });

    const duplicateNested = `${JSON.stringify(baseEvidence()).replace(
      '"backup_user_data":{"aqua_run_id":"gha-123-2",',
      '"backup_user_data":{"aqua_run_id":"gha-123-2","aqua_run_id":"gha-123-2",',
    )}\n`;
    cases.push({ name: 'duplicate-nested-key', bytes: duplicateNested });

    cases.push({
      name: 'invalid-calendar-time',
      bytes: `${JSON.stringify(baseEvidence({ started_at: '2026-02-30T03:00:00Z' }))}\n`,
    });

    for (const testCase of cases) {
      const evidence = join(directory, `${testCase.name}.json`);
      writeFileSync(evidence, testCase.bytes);
      expect(
        run([
          'create-evidence',
          '--output',
          join(directory, `${testCase.name}.attestation.json`),
          '--run-record',
          runRecord,
          '--evidence',
          evidence,
          ...rawArtifactArgs,
          '--artifact-path',
          'base-backup.json',
        ]).status,
      ).not.toBe(0);

      const finalDirectory = join(directory, `${testCase.name}-final`);
      mkdirSync(finalDirectory);
      writeFileSync(join(finalDirectory, 'evidence.json'), testCase.bytes);
      expect(runEvaluator(finalDirectory).status).not.toBe(0);
    }
  });

  it('rejects type-correct forged PITR semantics through the shared validator', () => {
    const runRecord = createSuccessfulPitrRun();
    const mutations: Array<{ name: string; mutate: (value: Record<string, unknown>) => void }> = [
      {
        name: 'database-head-order',
        mutate: (value) => {
          const verification = value.source_database_verification as Record<string, unknown>;
          const heads = (verification.migration_heads as Record<string, unknown>).schemas as Array<
            Record<string, unknown>
          >;
          [heads[0], heads[1]] = [heads[1]!, heads[0]!];
          value.source_database_verification_sha256 = createHash('sha256')
            .update(`${JSON.stringify(verification)}\n`)
            .digest('hex');
        },
      },
      {
        name: 'restored-database-divergence',
        mutate: (value) => {
          const verification = value.restored_database_verification as Record<string, unknown>;
          const sentinels = verification.sentinels as Array<Record<string, unknown>>;
          sentinels[0] = { ...sentinels[0], checksum: 'd'.repeat(32) };
          value.restored_database_verification_sha256 = createHash('sha256')
            .update(`${JSON.stringify(verification)}\n`)
            .digest('hex');
        },
      },
      {
        name: 'legacy-target-only-database-proof',
        mutate: (value) => {
          const verification = value.restored_database_verification;
          const verificationSha256 = value.restored_database_verification_sha256;
          for (const field of [
            'source_database_verification_sha256',
            'source_database_verification',
            'source_database_release_sha',
            'restored_database_verification_sha256',
            'restored_database_verification',
            'restored_database_release_sha',
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
          ]) {
            delete value[field];
          }
          value.database_verification_sha256 = verificationSha256;
          value.database_verification = verification;
        },
      },
      {
        name: 'legacy-sentinel-boundary-proof',
        mutate: (value) => {
          for (const field of [
            'restored_recovery_target_time',
            'restored_recovery_target_inclusive',
            'restored_recovery_target_timeline',
            'restored_recovery_target_action',
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
            'before_wal_marker_replayed',
            'after_wal_marker_excluded',
          ]) {
            delete value[field];
          }
          value.source_before_sentinel_recorded_at = '2026-07-16T03:05:00.000000Z';
          value.source_after_sentinel_recorded_at = '2026-07-16T03:08:00.000000Z';
          value.restored_before_sentinel_recorded_at = '2026-07-16T03:05:00.000000Z';
          value.source_before_sentinel_recorded_lsn = '0/1000000';
          value.source_after_sentinel_recorded_lsn = '0/2000000';
          value.restored_before_sentinel_recorded_lsn = '0/1000000';
          value.before_sentinel_present = true;
          value.after_sentinel_present = false;
        },
      },
      {
        name: 'source-database-release-preimage',
        mutate: (value) => void (value.source_database_release_sha = '6'.repeat(40)),
      },
      {
        name: 'restored-database-release-preimage',
        mutate: (value) => void (value.restored_database_release_sha = '6'.repeat(40)),
      },
      {
        name: 'database-release-format',
        mutate: (value) => void (value.source_database_release_sha = 'not-a-git-sha'),
      },
      { name: 'database-verified', mutate: (value) => void (value.database_verified = false) },
      {
        name: 'restored-target-time',
        mutate: (value) => void (value.restored_recovery_target_time = '2026-07-16T03:07:01Z'),
      },
      {
        name: 'restored-target-inclusive',
        mutate: (value) => void (value.restored_recovery_target_inclusive = true),
      },
      {
        name: 'restored-target-timeline',
        mutate: (value) => void (value.restored_recovery_target_timeline = 'current'),
      },
      {
        name: 'restored-target-action',
        mutate: (value) => void (value.restored_recovery_target_action = 'pause'),
      },
      {
        name: 'marker-prefix',
        mutate: (value) => void (value.wal_marker_prefix = 'aqua.pitr.boundary.v2'),
      },
      {
        name: 'commit-fence-prefix',
        mutate: (value) => void (value.wal_commit_fence_prefix = 'aqua.pitr.commit-fence.v2'),
      },
      {
        name: 'before-marker-phase-replay',
        mutate: (value) => {
          const content = walMarkerContent(
            String(value.backup_name),
            String(value.main_sha),
            'AFTER',
            String(value.run_id),
          );
          value.source_before_marker_content = content;
          value.source_before_marker_content_sha256 = createHash('sha256')
            .update(content)
            .digest('hex');
        },
      },
      {
        name: 'before-marker-key-reorder',
        mutate: (value) => {
          const content = JSON.stringify({
            run_id: value.run_id,
            phase: 'BEFORE',
            main_sha: value.main_sha,
            backup_name: value.backup_name,
          });
          value.source_before_marker_content = content;
          value.source_before_marker_content_sha256 = createHash('sha256')
            .update(content)
            .digest('hex');
        },
      },
      {
        name: 'after-marker-content-replay',
        mutate: (value) => {
          value.source_after_marker_content = value.source_before_marker_content;
          value.source_after_marker_content_sha256 = value.source_before_marker_content_sha256;
        },
      },
      {
        name: 'before-marker-at-commit-fence',
        mutate: (value) => void (value.source_before_marker_lsn = '0/1000100'),
      },
      {
        name: 'after-marker-at-commit-fence',
        mutate: (value) => void (value.source_after_marker_lsn = '0/2000100'),
      },
      {
        name: 'replay-at-after-commit-fence',
        mutate: (value) => void (value.restored_replay_lsn = '0/2000100'),
      },
      {
        name: 'target-at-after-marker',
        mutate: (value) =>
          void (value.source_after_marker_emitted_at = '2026-07-16T03:07:00.000000Z'),
      },
      {
        name: 'before-marker-derived-flag',
        mutate: (value) => void (value.before_wal_marker_replayed = false),
      },
      {
        name: 'after-marker-derived-flag',
        mutate: (value) => void (value.after_wal_marker_excluded = false),
      },
      {
        name: 'source-lock-count',
        mutate: (value) => void (value.source_verification_lock_count = 32),
      },
      {
        name: 'source-lock-timeout',
        mutate: (value) => void (value.source_verification_lock_timeout_ms = 4999),
      },
      {
        name: 'source-statement-timeout',
        mutate: (value) => void (value.source_verification_statement_timeout_ms = 119999),
      },
      {
        name: 'source-idle-timeout',
        mutate: (value) => void (value.source_verification_idle_timeout_ms = 29999),
      },
      {
        name: 'source-snapshot-preimage',
        mutate: (value) => void (value.source_verification_snapshot_id = '00000001-00000002-1'),
      },
      {
        name: 'source-lock-topology-preimage',
        mutate: (value) => {
          const relations = [...(value.source_verification_lock_relations as string[])];
          relations[0] = 'admin.not_migrations';
          relations.sort();
          value.source_verification_lock_relations = relations;
          value.source_verification_lock_set_sha256 = createHash('sha256')
            .update(relations.join('\n'))
            .digest('hex');
        },
      },
      {
        name: 'source-completion-separation',
        mutate: (value) =>
          void (value.source_verification_completed_at = '2026-07-16T03:06:59.000001Z'),
      },
      {
        name: 'source-completion-excess-separation',
        mutate: (value) =>
          void (value.source_verification_completed_at = '2026-07-16T03:06:57.999999Z'),
      },
      {
        name: 'replay-before-source-floor',
        mutate: (value) => void (value.restored_replay_lsn = '0/1000100'),
      },
      { name: 'schema-v1', mutate: (value) => void (value.schema_version = 1) },
      { name: 'readonly-rootfs', mutate: (value) => void (value.target_read_only_rootfs = false) },
      { name: 'success-failure-stage', mutate: (value) => void (value.failure_stage = 'forged') },
      { name: 'timeline-zero', mutate: (value) => void (value.source_timeline_id = 0) },
      { name: 'timeline-wal-mismatch', mutate: (value) => void (value.source_timeline_id = 2) },
    ];

    for (const mutation of mutations) {
      const value = pitrEvidence(1);
      mutation.mutate(value);
      const bytes = `${JSON.stringify(value)}\n`;
      const evidence = join(directory, `${mutation.name}.json`);
      writeFileSync(evidence, bytes);
      expect(
        run([
          'create-evidence',
          '--output',
          join(directory, `${mutation.name}.attestation.json`),
          '--run-record',
          runRecord,
          '--evidence',
          evidence,
          ...pitrRawArtifactArgs,
          '--artifact-path',
          'timestamp-pitr.json',
        ]).status,
      ).not.toBe(0);

      const finalDirectory = join(directory, `${mutation.name}-final`);
      mkdirSync(finalDirectory);
      writeFileSync(join(finalDirectory, 'evidence.json'), bytes);
      const finalResult = runEvaluator(finalDirectory);
      expect(finalResult.status).toBe(2);
      expect(finalResult.stderr).toContain('closed raw evidence schema');
    }
  });

  it('rejects successful evidence without nonzero image and DR-contract provenance', () => {
    const runRecord = createSuccessfulRun();
    const invalidAuthorities = [
      {
        source_image_revision: '0'.repeat(40),
        source_postgres_dr_contract_sha256: POSTGRES_DR_CONTRACT_SHA256,
      },
      {
        source_image_revision: SOURCE_IMAGE_REVISION,
        source_postgres_dr_contract_sha256: 'not-a-sha256',
      },
      {
        source_image_revision: SOURCE_IMAGE_REVISION,
        source_dr_contract_sha256: POSTGRES_DR_CONTRACT_SHA256,
      },
    ];
    invalidAuthorities.forEach((authority, index) => {
      const evidence = join(directory, `invalid-authority-${index}.json`);
      writeFileSync(evidence, `${JSON.stringify(baseEvidence(authority))}\n`);
      expect(
        run([
          'create-evidence',
          '--output',
          join(directory, `invalid-attestation-${index}.json`),
          '--run-record',
          runRecord,
          '--evidence',
          evidence,
          ...rawArtifactArgs,
          '--artifact-path',
          'base-backup.json',
        ]).status,
      ).not.toBe(0);
    });
  });

  it('rejects non-main authority, GitHub API drift, and failed evidence promotion', () => {
    const branchRecord = join(directory, 'branch.json');
    const branch = run([
      'create-run',
      '--output',
      branchRecord,
      '--workflow',
      'backup-production.yml',
      '--workflow-name',
      'Backup - Production Postgres',
      '--repository',
      'Okan-wqm/aquaculture_platform',
      '--ref',
      'refs/heads/feature',
      '--sha',
      MAIN_SHA,
      '--run-id',
      '123',
      '--run-attempt',
      '1',
      '--event-name',
      'workflow_dispatch',
      '--job-result',
      'success',
      '--mode',
      'full_backup',
      '--issued-at',
      '2026-07-16T03:30:00Z',
    ]);
    expect(branch.status).not.toBe(0);
    expect(branch.stderr).toContain('refs/heads/main');

    const runRecord = createSuccessfulRun();
    expect(
      run([
        'verify-run',
        '--run-record',
        runRecord,
        '--api-run',
        writeApiRun({ head_sha: 'b'.repeat(40) }),
        '--api-workflow',
        writeApiWorkflow(),
      ]).status,
    ).not.toBe(0);

    const failedRecord = join(directory, 'failed.json');
    expect(
      run([
        'create-run',
        '--output',
        failedRecord,
        '--workflow',
        'backup-production.yml',
        '--workflow-name',
        'Backup - Production Postgres',
        '--repository',
        'Okan-wqm/aquaculture_platform',
        '--ref',
        'refs/heads/main',
        '--sha',
        MAIN_SHA,
        '--run-id',
        '124',
        '--run-attempt',
        '1',
        '--event-name',
        'schedule',
        '--job-result',
        'failure',
        '--mode',
        'full_backup',
        '--issued-at',
        '2026-07-16T03:30:00Z',
      ]).status,
    ).toBe(0);

    const evidence = join(directory, 'base.json');
    writeFileSync(evidence, `${JSON.stringify(baseEvidence({ run_id: 'gha-124-1' }))}\n`);
    expect(
      run([
        'create-evidence',
        '--output',
        join(directory, 'forged.json'),
        '--run-record',
        failedRecord,
        '--evidence',
        evidence,
        '--artifact-id',
        '457',
        '--artifact-name',
        'walg-raw-evidence-v1-backup-production.yml-124-1',
        '--artifact-digest',
        RAW_ARTIFACT_DIGEST,
        '--artifact-created-at',
        RAW_ARTIFACT_CREATED_AT,
        '--artifact-path',
        'base-backup.json',
      ]).status,
    ).not.toBe(0);
  });
});
