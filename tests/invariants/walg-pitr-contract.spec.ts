import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

const UPSTREAM_IMAGE =
  'timescale/timescaledb-ha:pg16@sha256:b3d038d0a0757df8a5ec0a94ba68d9ad57b0e16100a024cf4b370c77ad5645f7';
const PRODUCTION_IMAGE = 'ghcr.io/okan-wqm/aquaculture_platform/postgres:${TAG:?TAG required}';
const WALG_VERSION = 'v3.0.8';
const WALG_REVISION = 'f81943e64bdf97aa66f6c52fec55114703f97af7';
const WALG_ASSET = 'wal-g-pg-22.04-amd64';
const WALG_SHA256 = 'f30544c5ce93cf83b87578e3c4a2e9c0e0ffc3d160ef89ecddaf75f397d98deb';
const EVIDENCE_MAIN_SHA = 'a'.repeat(40);
const EVIDENCE_IMAGE_REVISION = '9'.repeat(40);
const EVIDENCE_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const EVIDENCE_SYSTEM_IDENTIFIER = '7500000000000000000';
const EVIDENCE_WALG_CONFIG_SHA256 = 'd'.repeat(64);
const EVIDENCE_ROTATION_BUNDLE_SHA256 = 'e'.repeat(64);
const EVIDENCE_DR_CONTRACT_SHA256 = 'f'.repeat(64);
const TEST_WALG_BACKUP_EPOCH = 'epoch-20260716-001';
const TEST_WALG_PREFIX = `s3://test-bucket/postgres/wal-g/${TEST_WALG_BACKUP_EPOCH}`;
const TEST_WALG_KEY = Buffer.alloc(32, 0).toString('base64');
const TEST_WALG_NEXT_KEY = Buffer.alloc(32, 1).toString('base64');
const EVIDENCE_TENANT_SCHEMA = `tenant_${'1'.repeat(16)}`;
const EVIDENCE_CANONICAL_SCHEMAS = [
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
const EVIDENCE_SOURCE_SCHEMAS = EVIDENCE_CANONICAL_SCHEMAS.slice(0, 14);
const EVIDENCE_TENANT_SOURCES = [
  'farm',
  'sensor',
  'hr',
  'messaging',
  'hydroponics',
  'alert',
  'ai',
] as const;
const EVIDENCE_TENANT_SENTINELS = [
  'farms',
  'sensors',
  'employees',
  'channels',
  'hydroponics_config',
  'alert_rules',
  'agent_conversations',
] as const;

const COMPOSE_PATH = join(REPO_ROOT, 'docker-compose.droplet.yml');
const POSTGRES_MANIFEST_PATH = join(REPO_ROOT, '.github/manifests/postgres-image.json');
const DOCKERIGNORE_PATH = join(REPO_ROOT, '.dockerignore');
const POSTGRES_DR_CONTRACT_PATH = join(REPO_ROOT, '.github/manifests/postgres-dr-contract.sha256');
const BACKUP_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/backup-production.yml');
const PITR_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/pitr-restore-production.yml');
const DEPLOY_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/deploy-digitalocean.yml');
const BACKUP_HASH_MANIFEST_PATH = join(REPO_ROOT, '.github/manifests/backup-script.sha256');
const BACKUP_HASH_WORKFLOW_PATH = join(
  REPO_ROOT,
  '.github/workflows/backup-manifest-invariant.yml',
);
const MATERIALIZER_PATH = join(REPO_ROOT, 'tools/scripts/database/materialize-walg-secrets.sh');
const POSTGRES_SSL_ENTRYPOINT_PATH = join(
  REPO_ROOT,
  'infrastructure/docker/scripts/postgres-ssl-entrypoint.sh',
);
const INTERNAL_CERT_GENERATOR_PATH = join(
  REPO_ROOT,
  'infrastructure/docker/scripts/generate-internal-certs.sh',
);
const POSTGRES_WALG_HEALTHCHECK_PATH = join(
  REPO_ROOT,
  'infrastructure/docker/scripts/postgres-walg-healthcheck.sh',
);
const SECRET_LOADER_PATH = join(REPO_ROOT, 'infrastructure/docker/scripts/walg-load-secrets.sh');
const RUNTIME_WRAPPER_PATH = join(
  REPO_ROOT,
  'infrastructure/docker/scripts/walg-runtime-command.sh',
);
const ARCHIVE_WRAPPER_PATH = join(
  REPO_ROOT,
  'infrastructure/docker/scripts/walg-archive-command.sh',
);
const RESTORE_WRAPPER_PATH = join(
  REPO_ROOT,
  'infrastructure/docker/scripts/walg-restore-command.sh',
);
const BASE_BACKUP_PATH = join(REPO_ROOT, 'tools/scripts/database/walg-base-backup.sh');
const PITR_RESTORE_PATH = join(REPO_ROOT, 'tools/scripts/database/walg-pitr-restore.sh');
const EVIDENCE_EVALUATOR_PATH = join(
  REPO_ROOT,
  'tools/scripts/database/evaluate-walg-evidence.mjs',
);

const TRUSTED_BACKUP_BUNDLE = [
  '.github/manifests/postgres-dr-contract.sha256',
  'tools/scripts/database/backup-databases.sh',
  'tools/scripts/database/database-verification.sql',
  'tools/scripts/database/evaluate-walg-evidence.mjs',
  'tools/scripts/database/materialize-walg-secrets.sh',
  'tools/scripts/database/walg-base-backup.sh',
  'tools/scripts/database/walg-pitr-restore.sh',
] as const;

interface ComposeService {
  command?: unknown;
  environment?: unknown;
  image?: unknown;
  networks?: unknown;
  ports?: unknown;
  tmpfs?: unknown;
  volumes?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function hashManifestEntries(manifest: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s{2}([^\s].*)$/);
    if (match?.[1] && match[2]) entries.set(match[2], match[1]);
  }
  return entries;
}

function productionCompose(): Record<string, unknown> {
  const compose: unknown = yaml.load(read(COMPOSE_PATH));
  if (!isRecord(compose)) {
    throw new Error('docker-compose.droplet.yml must be an object');
  }
  return compose;
}

function postgresService(): ComposeService {
  const services = productionCompose().services;
  if (!isRecord(services)) {
    throw new Error('docker-compose.droplet.yml must define services');
  }
  const postgres = services.postgres;
  if (!isRecord(postgres)) {
    throw new Error('docker-compose.droplet.yml must define services.postgres');
  }
  return postgres;
}

function postgresManifest(): Record<string, unknown> {
  const manifest: unknown = JSON.parse(read(POSTGRES_MANIFEST_PATH));
  if (!isRecord(manifest)) {
    throw new Error('.github/manifests/postgres-image.json must be an object');
  }
  return manifest;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function networkNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  return isRecord(value) ? Object.keys(value) : [];
}

function environmentRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error('services.postgres.environment must use mapping syntax');
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
}

function composeDefaultPositiveSeconds(value: string, variableName: string): number {
  const match = new RegExp(`^\\$\\{${variableName}:-([1-9][0-9]*)\\}$`).exec(value);
  if (!match?.[1]) {
    throw new Error(`${variableName} must use one positive Compose default`);
  }
  return Number(match[1]);
}

function composeDurationSeconds(value: unknown, fieldName: string): number {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a Compose duration string`);
  }
  const match = /^([1-9][0-9]*)(ms|s|m)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error(`${fieldName} must use one positive duration unit`);
  }
  const amount = Number(match[1]);
  if (match[2] === 'ms') return amount / 1_000;
  if (match[2] === 'm') return amount * 60;
  return amount;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o700 });
  chmodSync(path, 0o700);
}

function shellCommand(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(' ');
  }
  throw new Error('services.postgres.command must be a string or string array');
}

function executableShellLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function expectStrictShell(path: string): string {
  const content = read(path);
  const lines = executableShellLines(content);

  expect(lines).toContain('set -euo pipefail');
  expect(content).not.toMatch(/(?:^|\s)set\s+-[^\n]*x/m);
  expect(content).not.toMatch(/\bset\s+-o\s+xtrace\b/);
  expect(content).not.toMatch(/\bset\s+-x\b/);

  return content;
}

function runMaterializer(
  hostSecretDirectory: string,
  overrides: Readonly<Record<string, string>> = {},
): SpawnSyncReturns<string> {
  return spawnSync('bash', [MATERIALIZER_PATH], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      WALG_HOST_SECRET_DIR: hostSecretDirectory,
      WALG_INSTALL_RUNNING_CONTAINER: 'false',
      WALG_S3_ACCESS_KEY_ID: 'test-access-key',
      WALG_S3_SECRET_ACCESS_KEY: 'test-secret-key',
      WALG_LIBSODIUM_KEY_B64: TEST_WALG_KEY,
      WALG_BACKUP_EPOCH: TEST_WALG_BACKUP_EPOCH,
      WALG_S3_PREFIX: TEST_WALG_PREFIX,
      ...overrides,
    },
  });
}

function runSourceBundleValidation(
  hostSecretDirectory: string,
  backupEpoch = TEST_WALG_BACKUP_EPOCH,
  s3Prefix = TEST_WALG_PREFIX,
): SpawnSyncReturns<string> {
  return spawnSync(
    'bash',
    [
      '-ceu',
      'source "$1"; _walg_validate_bundle "$2" source',
      'walg-loader-test',
      SECRET_LOADER_PATH,
      hostSecretDirectory,
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        WALG_BACKUP_EPOCH: backupEpoch,
        WALG_S3_PREFIX: s3Prefix,
      },
    },
  );
}

function findWalgDockerfile(): string {
  const dockerDir = join(REPO_ROOT, 'infrastructure', 'docker');
  const candidates = readdirSync(dockerDir)
    .filter((name) => name.startsWith('Dockerfile'))
    .map((name) => join(dockerDir, name))
    .filter((path) => read(path).includes(WALG_ASSET));

  expect(candidates).toHaveLength(1);
  const candidate = candidates[0];
  if (!candidate) throw new Error('Expected one WAL-G PostgreSQL Dockerfile');
  return candidate;
}

function backupEvidence(
  runNumber: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const minute = String(runNumber * 10).padStart(2, '0');
  const completedMinute = String(runNumber * 10 + 1).padStart(2, '0');
  const walFileName = `00000001${runNumber.toString(16).toUpperCase().padStart(16, '0')}`;
  const startLsn = BigInt(runNumber) * 0x1000000n;
  return {
    schema_version: 1,
    run_id: `backup-${runNumber}`,
    main_sha: EVIDENCE_MAIN_SHA,
    evidence_type: 'base_backup',
    status: 'success',
    started_at: `2026-07-16T00:${minute}:00Z`,
    completed_at: `2026-07-16T00:${completedMinute}:00Z`,
    backup_name: `base_${walFileName}`,
    backup_type: 'full',
    backup_user_data: {
      aqua_run_id: `backup-${runNumber}`,
      backup_kind: 'full',
      main_sha: EVIDENCE_MAIN_SHA,
    },
    backup_wal_file_name: walFileName,
    backup_storage_name: 'default',
    backup_start_time: `2026-07-16T00:${minute}:10.000000Z`,
    backup_finish_time: `2026-07-16T00:${minute}:50.000000Z`,
    backup_start_lsn: startLsn.toString(),
    backup_finish_lsn: (startLsn + 216n).toString(),
    backup_pg_version: 160013,
    source_system_identifier: EVIDENCE_SYSTEM_IDENTIFIER,
    source_image_id: EVIDENCE_IMAGE_ID,
    source_image_revision: EVIDENCE_IMAGE_REVISION,
    source_postgres_dr_contract_sha256: EVIDENCE_DR_CONTRACT_SHA256,
    source_wal_g_revision: WALG_REVISION,
    walg_config_sha256: EVIDENCE_WALG_CONFIG_SHA256,
    walg_rotation_bundle_sha256: EVIDENCE_ROTATION_BUNDLE_SHA256,
    full: true,
    verified: true,
    wal_verified: true,
    elapsed_seconds: 60,
    failure_stage: null,
    ...overrides,
  };
}

function databaseVerificationPayload(): Record<string, unknown> {
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
    canonical_schemas: [...EVIDENCE_CANONICAL_SCHEMAS],
    tenant_schemas: [EVIDENCE_TENANT_SCHEMA],
    release: {
      release_id: 'release-20260716',
      git_sha: EVIDENCE_MAIN_SHA,
    },
    migration_heads: {
      schemas: EVIDENCE_SOURCE_SCHEMAS.map((schema) => migrationHead({ schema })),
      tenants: EVIDENCE_TENANT_SOURCES.map((sourceSchema) =>
        migrationHead({
          tenant_schema: EVIDENCE_TENANT_SCHEMA,
          source_schema: sourceSchema,
        }),
      ),
    },
    sentinels: [
      sentinel('global', 'auth', 'tenants'),
      sentinel('global', 'auth', 'users'),
      sentinel('global', 'billing', 'subscriptions'),
      ...EVIDENCE_TENANT_SENTINELS.map((table) =>
        sentinel('tenant', EVIDENCE_TENANT_SCHEMA, table),
      ),
    ],
  };
}

function databaseVerificationSha256(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${JSON.stringify(payload)}\n`)
    .digest('hex');
}

function pitrEvidence(
  backupName: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const verification = databaseVerificationPayload();
  const backupWalFileName = backupName.replace(/^base_/, '');
  return {
    schema_version: 1,
    run_id: 'pitr-1',
    main_sha: EVIDENCE_MAIN_SHA,
    evidence_type: 'timestamp_pitr',
    status: 'success',
    started_at: '2026-07-16T00:34:00Z',
    completed_at: '2026-07-16T00:50:00Z',
    backup_name: backupName,
    recovery_target_time: '2026-07-16T00:37:00Z',
    failure_time: '2026-07-16T00:40:00Z',
    archive_observed_at: '2026-07-16T00:40:00Z',
    source_before_sentinel_recorded_at: '2026-07-16T00:35:00.000000Z',
    source_after_sentinel_recorded_at: '2026-07-16T00:38:00.000000Z',
    restored_before_sentinel_recorded_at: '2026-07-16T00:35:00.000000Z',
    source_before_sentinel_recorded_lsn: '0/1000000',
    source_after_sentinel_recorded_lsn: '0/2000000',
    restored_before_sentinel_recorded_lsn: '0/1000000',
    source_before_commit_fence_at: '2026-07-16T00:36:00.000000Z',
    source_before_commit_fence_lsn: '0/1000100',
    source_after_commit_fence_at: '2026-07-16T00:38:01.000000Z',
    source_after_commit_fence_lsn: '0/2000100',
    isolated_target_attested: true,
    timestamp_recovery: true,
    wal_verified: true,
    before_sentinel_present: true,
    after_sentinel_present: false,
    promoted: true,
    rpo_seconds: 300,
    rto_seconds: 960,
    archive_wait_seconds: 120,
    archive_required_wal: backupWalFileName,
    archived_through_wal: backupWalFileName,
    source_system_identifier: EVIDENCE_SYSTEM_IDENTIFIER,
    restored_system_identifier: EVIDENCE_SYSTEM_IDENTIFIER,
    source_image_id: EVIDENCE_IMAGE_ID,
    source_image_revision: EVIDENCE_IMAGE_REVISION,
    source_postgres_dr_contract_sha256: EVIDENCE_DR_CONTRACT_SHA256,
    source_wal_g_revision: WALG_REVISION,
    walg_config_sha256: EVIDENCE_WALG_CONFIG_SHA256,
    walg_rotation_bundle_sha256: EVIDENCE_ROTATION_BUNDLE_SHA256,
    target_pgdata_volume: 'aqua-pitr-gha-1-1',
    target_network: 'aqua-pitr-gha-1-1',
    database_verified: true,
    database_verification_sha256: databaseVerificationSha256(verification),
    database_verification: verification,
    target_read_only_rootfs: true,
    failure_stage: null,
    ...overrides,
  };
}

function evaluateEvidence(records: ReadonlyArray<Record<string, unknown>>): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const evidenceDirectory = mkdtempSync(join(tmpdir(), 'aqua-walg-evidence-'));
  try {
    records.forEach((record, index) => {
      writeFileSync(
        join(evidenceDirectory, `${String(index).padStart(3, '0')}.json`),
        `${JSON.stringify(record)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );
    });
    const result = spawnSync(
      process.execPath,
      [
        EVIDENCE_EVALUATOR_PATH,
        '--evidence-dir',
        evidenceDirectory,
        '--expected-main-sha',
        EVIDENCE_MAIN_SHA,
        '--expected-postgres-dr-contract-sha256',
        EVIDENCE_DR_CONTRACT_SHA256,
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(evidenceDirectory, { recursive: true, force: true });
  }
}

function runWrapperWithWalgStatus(
  wrapper: string,
  status: number,
  args: ReadonlyArray<string>,
): number | null {
  const loaderSource = 'source /usr/local/bin/walg-load-secrets.sh';
  if (!wrapper.includes(loaderSource)) {
    throw new Error('WAL-G wrapper must source the canonical secret loader');
  }
  const harness = wrapper.replace(loaderSource, 'walg_exec() { return "${WALG_TEST_STATUS:?}"; }');
  const harnessDirectory = mkdtempSync(join(tmpdir(), 'aqua-walg-wrapper-'));
  const harnessPath = join(harnessDirectory, 'wrapper.sh');
  try {
    writeExecutable(harnessPath, harness);
    return spawnSync(harnessPath, args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        WALG_TEST_STATUS: String(status),
        WALG_RPO_BUDGET_SECONDS: '6',
        WALG_ARCHIVE_SWITCH_BUDGET_SECONDS: '2',
        WALG_WAL_PUSH_BUDGET_SECONDS: '2',
        WALG_HEALTH_DETECTION_BUDGET_SECONDS: '2',
      },
    }).status;
  } finally {
    rmSync(harnessDirectory, { recursive: true, force: true });
  }
}

describe('WAL-G continuous archive and timestamp PITR contract', () => {
  it('builds WAL-G into the derived production image from immutable upstream inputs', () => {
    const dockerfile = read(findWalgDockerfile());
    const manifest = postgresManifest();
    const walG = manifest.wal_g;
    if (!isRecord(walG)) throw new Error('postgres image manifest must define wal_g');

    expect(dockerfile).toContain(`FROM ${UPSTREAM_IMAGE}`);
    expect(dockerfile).toContain(WALG_VERSION);
    expect(dockerfile).toContain(
      `https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}/${WALG_ASSET}`,
    );
    expect(dockerfile).toContain(WALG_SHA256);
    expect(
      dockerfile.includes(`ADD --checksum=sha256:${WALG_SHA256}`) ||
        /sha256sum\s+(?:--check|-c)/.test(dockerfile),
    ).toBe(true);
    expect(dockerfile).toMatch(/wal-g\s+--version/);
    expect(dockerfile).toContain(WALG_REVISION);
    expect(dockerfile).toContain('ARG BUILD_MAIN_SHA=0000000000000000000000000000000000000000');
    expect(dockerfile).toContain('ARG POSTGRES_DR_CONTRACT_SHA256');
    expect(dockerfile).toContain('org.opencontainers.image.revision="${BUILD_MAIN_SHA}"');
    expect(dockerfile).toContain(
      'io.aquaculture.postgres.dr-contract-sha256="${POSTGRES_DR_CONTRACT_SHA256}"',
    );
    expect(dockerfile).toContain('sha256sum --strict --check -');
    expect(dockerfile).toContain('$2 != "infrastructure/docker/Dockerfile.postgres-walg"');
    expect(dockerfile).not.toMatch(/^FROM\s+timescale\/timescaledb-ha:pg16\s*(?:#.*)?$/m);
    for (const wrapper of [
      'postgres-ssl-entrypoint.sh',
      'postgres-walg-healthcheck.sh',
      'walg-load-secrets.sh',
      'walg-runtime-command.sh',
      'walg-archive-command.sh',
      'walg-restore-command.sh',
    ]) {
      expect(dockerfile).toContain(wrapper);
    }

    expect(manifest.schema_version).toBe(2);
    expect(manifest.image).toBe(UPSTREAM_IMAGE);
    expect(manifest.production_image).toBe(PRODUCTION_IMAGE);
    expect(manifest.dockerfile).toBe('infrastructure/docker/Dockerfile.postgres-walg');
    expect(manifest.dr_contract).toEqual({
      manifest_path: '.github/manifests/postgres-dr-contract.sha256',
      image_label: 'io.aquaculture.postgres.dr-contract-sha256',
    });
    expect(walG).toMatchObject({
      asset: WALG_ASSET,
      asset_sha256: WALG_SHA256,
      revision: WALG_REVISION,
      version: WALG_VERSION,
    });

    const postgres = postgresService();
    expect(postgres.image).toBe(PRODUCTION_IMAGE);

    const contractEntries = hashManifestEntries(read(POSTGRES_DR_CONTRACT_PATH));
    const expectedContractPaths = [
      'infrastructure/docker/Dockerfile.postgres-walg',
      'infrastructure/docker/scripts/postgres-ssl-entrypoint.sh',
      'infrastructure/docker/scripts/postgres-walg-healthcheck.sh',
      'infrastructure/docker/scripts/walg-archive-command.sh',
      'infrastructure/docker/scripts/walg-load-secrets.sh',
      'infrastructure/docker/scripts/walg-restore-command.sh',
      'infrastructure/docker/scripts/walg-runtime-command.sh',
    ];
    expect([...contractEntries.keys()]).toEqual(expectedContractPaths);
    for (const contractPath of expectedContractPaths) {
      expect(contractEntries.get(contractPath)).toBe(sha256(join(REPO_ROOT, contractPath)));
    }
    const deployWorkflow = read(DEPLOY_WORKFLOW_PATH);
    expect(deployWorkflow).toContain('sha256sum --strict --check "${CONTRACT_MANIFEST}"');
    expect(deployWorkflow).toContain(
      'POSTGRES_DR_CONTRACT_SHA256=${{ steps.postgres_dr_contract.outputs.sha256 }}',
    );
    expect(
      read(DOCKERIGNORE_PATH)
        .split(/\r?\n/)
        .filter((line) => line.startsWith('!.github')),
    ).toEqual([
      '!.github/',
      '!.github/manifests/',
      '!.github/manifests/postgres-dr-contract.sha256',
    ]);
  });

  it('enables bounded continuous archiving through the fail-closed wrapper', () => {
    const command = shellCommand(postgresService().command);
    const environment = environmentRecord(postgresService().environment);
    const rpoBudgetSeconds = composeDefaultPositiveSeconds(
      environment.WALG_RPO_BUDGET_SECONDS ?? '',
      'WALG_RPO_BUDGET_SECONDS',
    );
    const archiveSwitchBudgetSeconds = composeDefaultPositiveSeconds(
      environment.WALG_ARCHIVE_SWITCH_BUDGET_SECONDS ?? '',
      'WALG_ARCHIVE_SWITCH_BUDGET_SECONDS',
    );
    const walPushBudgetSeconds = composeDefaultPositiveSeconds(
      environment.WALG_WAL_PUSH_BUDGET_SECONDS ?? '',
      'WALG_WAL_PUSH_BUDGET_SECONDS',
    );
    const healthDetectionBudgetSeconds = composeDefaultPositiveSeconds(
      environment.WALG_HEALTH_DETECTION_BUDGET_SECONDS ?? '',
      'WALG_HEALTH_DETECTION_BUDGET_SECONDS',
    );

    expect(command).toMatch(/(?:^|\s)-c\s+archive_mode=on(?:\s|$)/);
    expect(command).toMatch(/walg-archive-command\.sh/);
    expect(command).toMatch(/%p/);
    expect(command).toMatch(/%f/);
    expect(command).toContain(
      `archive_timeout=\${WALG_ARCHIVE_SWITCH_BUDGET_SECONDS:-${archiveSwitchBudgetSeconds}}s`,
    );
    expect(rpoBudgetSeconds).toBeLessThanOrEqual(300);
    expect(archiveSwitchBudgetSeconds + walPushBudgetSeconds + healthDetectionBudgetSeconds).toBe(
      rpoBudgetSeconds,
    );

    const archiveWrapper = read(ARCHIVE_WRAPPER_PATH);
    expect(executableShellLines(archiveWrapper)).toContain('set -euo pipefail');
    expect(archiveWrapper).toMatch(/walg-load-secrets\.sh/);
    expect(archiveWrapper).toMatch(/walg_exec\s+wal-push/);
    expect(archiveWrapper).toContain('WALG_WAL_PUSH_BUDGET_SECONDS');
    expect(archiveWrapper).toMatch(/\btimeout\s+\\/);
    expect(archiveWrapper).toContain('--kill-after=');
    expect(archiveWrapper).not.toMatch(/\|\|\s*(?:true|:)/);
  });

  it('fails health when observable WAL archive freshness or disk safety breaches the RPO', () => {
    const compose = productionCompose();
    const services = compose.services;
    if (!isRecord(services) || !isRecord(services.postgres)) {
      throw new Error('production compose must define postgres');
    }
    const healthcheck = services.postgres.healthcheck;
    if (!isRecord(healthcheck)) {
      throw new Error('production postgres must define a healthcheck');
    }
    const healthScript = expectStrictShell(POSTGRES_WALG_HEALTHCHECK_PATH);

    expect(healthcheck.test).toEqual(['CMD', '/usr/local/bin/postgres-walg-healthcheck.sh']);
    expect(healthcheck.interval).toBe('15s');
    expect(healthcheck.timeout).toBe('5s');
    expect(healthcheck.retries).toBe(1);
    const detectionBudgetSeconds = composeDefaultPositiveSeconds(
      environmentRecord(services.postgres.environment).WALG_HEALTH_DETECTION_BUDGET_SECONDS ?? '',
      'WALG_HEALTH_DETECTION_BUDGET_SECONDS',
    );
    expect(
      composeDurationSeconds(healthcheck.interval, 'postgres.healthcheck.interval') +
        composeDurationSeconds(healthcheck.timeout, 'postgres.healthcheck.timeout') *
          Number(healthcheck.retries),
    ).toBeLessThanOrEqual(detectionBudgetSeconds);
    expect(healthScript).toContain('MAX_RPO_SECONDS=300');
    expect(healthScript).toContain('MAX_READY_AGE_SECONDS=${WALG_WAL_PUSH_BUDGET_SECONDS}');
    expect(healthScript).toContain('WALG_HEALTH_DETECTION_BUDGET_SECONDS');
    expect(healthScript).toContain('MAX_WAL_DISK_PERCENT=90');
    expect(healthScript).toContain('pg_stat_archiver');
    expect(healthScript).toContain("current_setting('archive_timeout')");
    expect(healthScript).toContain('last_failed_time > last_archived_time');
    expect(healthScript).toContain("-name '*.ready'");
    expect(healthScript).toContain('df -P "${PGDATA}/pg_wal"');
  });

  it('bounds a hung wal-push and rejects a ready WAL older than its controlled mtime budget', () => {
    const archiveWrapper = read(ARCHIVE_WRAPPER_PATH);
    const healthScript = read(POSTGRES_WALG_HEALTHCHECK_PATH);
    const scratch = mkdtempSync(join(tmpdir(), 'aqua-walg-rpo-'));
    const archiveHarnessPath = join(scratch, 'archive-wrapper.sh');
    const fakeBin = join(scratch, 'bin');
    const pgdata = join(scratch, 'pgdata');
    const archiveStatus = join(pgdata, 'pg_wal', 'archive_status');
    const walName = '000000010000000000000001';
    const walPath = join(scratch, walName);
    const readyPath = join(archiveStatus, `${walName}.ready`);
    const fixedNowEpoch = 2_000_000_000;
    const testEnvironment = {
      PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      PGDATA: pgdata,
      POSTGRES_USER: 'aquaculture',
      POSTGRES_DB: 'aquaculture',
      WALG_BACKUP_EPOCH: 'test-epoch',
      WALG_S3_PREFIX: 's3://test/postgres/wal-g/test-epoch',
      WALG_S3_ENDPOINT: 'https://object.invalid',
      WALG_S3_REGION: 'test-1',
      WALG_RPO_BUDGET_SECONDS: '6',
      WALG_ARCHIVE_SWITCH_BUDGET_SECONDS: '2',
      WALG_WAL_PUSH_BUDGET_SECONDS: '2',
      WALG_HEALTH_DETECTION_BUDGET_SECONDS: '2',
    };

    try {
      mkdirSync(fakeBin, { recursive: true });
      mkdirSync(archiveStatus, { recursive: true });
      writeFileSync(walPath, 'wal-segment', { encoding: 'utf8', mode: 0o600 });
      writeFileSync(readyPath, '', { encoding: 'utf8', mode: 0o600 });
      writeExecutable(
        archiveHarnessPath,
        archiveWrapper.replace(
          'source /usr/local/bin/walg-load-secrets.sh',
          'walg_exec() { sleep "${WALG_TEST_SLEEP_SECONDS:?}"; }',
        ),
      );
      writeExecutable(join(fakeBin, 'pg_isready'), '#!/usr/bin/env bash\nexit 0\n');
      writeExecutable(join(fakeBin, 'psql'), "#!/usr/bin/env bash\nprintf 't\\n'\n");
      writeExecutable(join(fakeBin, 'date'), `#!/usr/bin/env bash\nprintf '${fixedNowEpoch}\\n'\n`);
      writeExecutable(
        join(fakeBin, 'df'),
        "#!/usr/bin/env bash\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'test 100 10 90 10%% /test\\n'\n",
      );

      const hangStartedAt = Date.now();
      const hungPush = spawnSync(archiveHarnessPath, [walPath, walName], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...testEnvironment, WALG_TEST_SLEEP_SECONDS: '30' },
        timeout: 5_000,
      });
      const hangElapsedMilliseconds = Date.now() - hangStartedAt;
      expect(hungPush.status).toBe(75);
      expect(hungPush.signal).toBeNull();
      expect(hangElapsedMilliseconds).toBeGreaterThanOrEqual(800);
      expect(hangElapsedMilliseconds).toBeLessThan(4_000);

      const healthHarness = healthScript.replace(
        '/usr/local/bin/walg-load-secrets.sh assert-runtime',
        'true',
      );
      utimesSync(readyPath, fixedNowEpoch - 3, fixedNowEpoch - 3);
      const staleReady = spawnSync('bash', ['-s'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: testEnvironment,
        input: healthHarness,
      });
      expect(staleReady.status).toBe(1);
      expect(staleReady.stderr).toContain('oldest unarchived WAL is 3s old (limit 2s)');

      utimesSync(readyPath, fixedNowEpoch - 2, fixedNowEpoch - 2);
      const boundaryReady = spawnSync('bash', ['-s'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: testEnvironment,
        input: healthHarness,
      });
      expect(boundaryReady.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('keeps WAL-G credentials and client encryption key out of Compose metadata', () => {
    const postgres = postgresService();
    const environment = environmentRecord(postgres.environment);
    const tmpfs = stringList(postgres.tmpfs);
    const volumes = stringList(postgres.volumes);
    const forbiddenSecretKeys = [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'WALG_S3_ACCESS_KEY_ID',
      'WALG_S3_SECRET_ACCESS_KEY',
      'WALG_LIBSODIUM_KEY_B64',
      'WALG_LIBSODIUM_KEY',
    ];

    expect(Object.keys(environment)).not.toEqual(expect.arrayContaining(forbiddenSecretKeys));
    expect(environment.WALG_BACKUP_EPOCH).toBe('${WALG_BACKUP_EPOCH:?WALG_BACKUP_EPOCH required}');
    expect(environment.WALG_S3_PREFIX).toBe(
      's3://${WALG_SPACES_BUCKET:?WALG_SPACES_BUCKET required}/postgres/wal-g/${WALG_BACKUP_EPOCH:?WALG_BACKUP_EPOCH required}',
    );
    expect(environment).not.toHaveProperty('WALG_S3_SSE');
    expect(Object.values(environment).join('\n')).not.toMatch(
      /\$\{(?:AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|WALG_S3_ACCESS_KEY_ID|WALG_S3_SECRET_ACCESS_KEY|WALG_LIBSODIUM_KEY(?:_B64)?)(?::[^}]*)?\}/,
    );
    expect(volumes).toContain('./certs/wal-g/postgres:/var/lib/postgresql/wal-g-secrets-source:ro');
    const secretTmpfs = tmpfs.find((mount) => mount.startsWith('/run/aqua-walg-secrets:'));
    expect(secretTmpfs).toBeDefined();
    const tmpfsOptions = secretTmpfs?.split(':').slice(1).join(':').split(',') ?? [];
    expect(tmpfsOptions).toEqual(expect.arrayContaining(['noexec', 'nosuid', 'nodev']));
    expect(tmpfsOptions.some((option) => /^mode=0?700$/.test(option))).toBe(true);
  });

  it('keeps the production PostgreSQL TLS identity outside physical backup PGDATA', () => {
    const postgres = postgresService();
    const command = shellCommand(postgres.command);
    const tmpfs = stringList(postgres.tmpfs);
    const volumes = stringList(postgres.volumes);
    const entrypoint = expectStrictShell(POSTGRES_SSL_ENTRYPOINT_PATH);
    const certificateGenerator = expectStrictShell(INTERNAL_CERT_GENERATOR_PATH);

    expect(tmpfs).toContain('/run/aqua-postgres-tls:rw,noexec,nosuid,nodev,size=1m,mode=0700');
    expect(command).toContain('ssl_cert_file=/run/aqua-postgres-tls/server.crt');
    expect(command).toContain('ssl_key_file=/run/aqua-postgres-tls/server.key');
    expect(command).toContain('ssl_ca_file=/run/aqua-postgres-tls/root.crt');
    expect(entrypoint).toContain(
      'TLS_RUNTIME_DIR="${POSTGRES_SSL_RUNTIME_DIR:-/run/aqua-postgres-tls}"',
    );
    expect(entrypoint).toContain("stat -f -c '%T'");
    expect(entrypoint).toContain('must reside on tmpfs');
    expect(volumes).toEqual(
      expect.arrayContaining([
        './certs/postgres/postgres-cert.pem:/var/lib/postgresql/ssl/server.crt:ro',
        './certs/postgres/postgres-key.pem:/var/lib/postgresql/ssl/server.key:rw',
        './certs/postgres/ca-cert.pem:/var/lib/postgresql/ssl/root.crt:ro',
        './certs/wal-g/postgres:/var/lib/postgresql/wal-g-secrets-source:ro',
      ]),
    );
    expect(volumes).not.toContain('./certs/postgres:/var/lib/postgresql/ssl:ro');
    expect(entrypoint).toContain('chown 0:0 "${SERVER_KEY_SOURCE}"');
    expect(entrypoint).toContain('chmod 0600 "${SERVER_KEY_SOURCE}"');
    expect(entrypoint).toContain(
      '[ "$(stat -c \'%u:%g:%a\' "${SERVER_KEY_SOURCE}")" != \'0:0:600\' ]',
    );
    expect(certificateGenerator).toContain(
      'generate_server_cert "postgres" "postgres" "DNS:postgres,DNS:aqua-postgres,DNS:localhost" 0600',
    );
    expect(entrypoint).toContain(
      'for legacy_path in "${PGDATA}/server.crt" "${PGDATA}/server.key" "${PGDATA}/root.crt"',
    );
    expect(entrypoint).not.toMatch(/\bcp\b[^\n]*\$\{PGDATA\}\/server\.key/);
    expect(entrypoint).not.toContain('openssl req');
  });

  it('gives PostgreSQL isolated backup egress without publishing its database port', () => {
    const compose = productionCompose();
    const services = compose.services;
    const networks = compose.networks;
    if (!isRecord(services) || !isRecord(networks)) {
      throw new Error('production compose must define services and networks');
    }
    const backupEgress = networks['aqua-backup-egress'];
    if (!isRecord(backupEgress)) {
      throw new Error('production compose must define aqua-backup-egress');
    }
    const driverOptions = backupEgress.driver_opts;
    if (!isRecord(driverOptions)) {
      throw new Error('aqua-backup-egress must define driver_opts');
    }

    expect(backupEgress.internal).not.toBe(true);
    expect(String(driverOptions['com.docker.network.bridge.enable_icc'])).toBe('false');
    expect(networkNames(postgresService().networks)).toEqual(
      expect.arrayContaining(['aqua-internal', 'aqua-backup-egress']),
    );
    expect(stringList(postgresService().ports)).toEqual([]);

    const backupNetworkMembers = Object.entries(services)
      .filter(
        ([, service]) =>
          isRecord(service) && networkNames(service.networks).includes('aqua-backup-egress'),
      )
      .map(([serviceName]) => serviceName);
    expect(backupNetworkMembers).toEqual(['postgres']);
  });

  it('materializes mode-0600 secret files atomically and loads them fail closed', () => {
    const materializer = expectStrictShell(MATERIALIZER_PATH);
    const loader = read(SECRET_LOADER_PATH);

    expect(executableShellLines(loader)).toContain('set -euo pipefail');
    expect(loader).toContain('set +x');
    expect(loader.indexOf('unset access_key secret_key')).toBeGreaterThanOrEqual(0);
    expect(loader.indexOf('set -x')).toBeGreaterThan(loader.indexOf('unset access_key secret_key'));

    expect(materializer).toMatch(/umask\s+0?77/);
    expect(materializer).toMatch(/mktemp/);
    expect(materializer).toMatch(/chmod\s+0?600/);
    expect(materializer).toMatch(/\bmv\b/);
    for (const secret of [
      'WALG_S3_ACCESS_KEY_ID',
      'WALG_S3_SECRET_ACCESS_KEY',
      'WALG_LIBSODIUM_KEY_B64',
      'WALG_BACKUP_EPOCH',
      'WALG_S3_PREFIX',
    ]) {
      expect(materializer).toContain(secret);
    }

    expect(loader).toContain('AWS_ACCESS_KEY_ID');
    expect(loader).toContain('AWS_SECRET_ACCESS_KEY');
    expect(loader).toContain('WALG_LIBSODIUM_KEY_PATH');
    expect(loader).toContain('walg_backup_epoch');
    expect(loader).toContain('walg_s3_prefix');
    expect(loader).toContain('WAL-G bundle epoch/prefix differs from the container configuration');
    expect(loader).toContain('/run/aqua-walg-secrets');
    expect(loader).toContain(
      'WALG_SECRET_DIR must resolve directly to the WAL-G tmpfs runtime directory',
    );
    expect(loader).toContain('legacy_logical_dir="${pgdata}/wal-g-secrets"');
    expect(loader).not.toMatch(/\bln\s+-s\b/);
    expect(loader).not.toMatch(
      /(?:cp|install)[^\n]*(?:\$\{?PGDATA\}?|\/var\/lib\/postgresql\/data)\/wal-g-secrets/,
    );
    expect(loader).toMatch(/WALG_DELTA_MAX_STEPS=.*0/);
    expect(loader).toMatch(/WALG_PREVENT_WAL_OVERWRITE=.*true/);
    expect(loader).toMatch(/WALG_COMPRESSION_METHOD=.*lz4/);
    expect(loader).toContain('if env -i \\');
    expect(loader).not.toContain('WALG_S3_SSE');
    expect(loader).toMatch(/(?:-r|-f)\s+/);

    const result = spawnSync('bash', [MATERIALIZER_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    expect(result.status).not.toBe(0);
  });

  it('runs WAL-G with an exact environment allowlist', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'walg-environment-allowlist-'));
    const sourceDirectory = join(scratch, 'source');
    const runtimeDirectory = join(scratch, 'runtime');
    const lockPath = join(scratch, 'runtime.lock');
    const fakeWalg = join(scratch, 'wal-g');
    try {
      expect(runMaterializer(sourceDirectory).status).toBe(0);
      mkdirSync(runtimeDirectory, { mode: 0o700 });
      for (const entry of [
        'aws_access_key_id',
        'aws_secret_access_key',
        'libsodium.key',
        'walg_backup_epoch',
        'walg_s3_prefix',
        'manifest.sha256',
      ]) {
        const target = join(runtimeDirectory, entry);
        copyFileSync(join(sourceDirectory, entry), target);
        chmodSync(target, 0o600);
      }
      writeFileSync(lockPath, '', { mode: 0o600 });
      writeExecutable(
        fakeWalg,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          '[ -z "${AQUA_UNRELATED_CONTAINER_SECRET:-}" ]',
          `[ "\${WALG_S3_PREFIX:?}" = '${TEST_WALG_PREFIX}' ]`,
          '[ "${WALG_PREVENT_WAL_OVERWRITE:?}" = true ]',
          '[ "${WALG_COMPRESSION_METHOD:?}" = lz4 ]',
          '',
        ].join('\n'),
      );

      const result = spawnSync(
        'bash',
        ['-ceu', 'source "$1"; walg_exec backup-list', 'walg-environment-test', SECRET_LOADER_PATH],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            AQUA_UNRELATED_CONTAINER_SECRET: 'must-not-cross-walg-boundary',
            WALG_SECRET_RUNTIME_DIR: runtimeDirectory,
            WALG_SECRET_DIR: runtimeDirectory,
            WALG_SECRET_LOCK_FILE: lockPath,
            WALG_BACKUP_EPOCH: TEST_WALG_BACKUP_EPOCH,
            WALG_S3_PREFIX: TEST_WALG_PREFIX,
            WALG_S3_ENDPOINT: 'https://objects.invalid',
            WALG_S3_REGION: 'test-1',
            POSTGRES_USER: 'aquaculture',
            POSTGRES_DB: 'aquaculture',
            WALG_BIN: fakeWalg,
          },
        },
      );
      expect(result.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('fails closed when Docker control-plane inspection fails during runtime activation', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'walg-docker-control-plane-'));
    const hostSecretDirectory = join(scratch, 'wal-g');
    const fakeBin = join(scratch, 'bin');
    try {
      mkdirSync(fakeBin, { mode: 0o700 });
      writeExecutable(join(fakeBin, 'docker'), '#!/usr/bin/env bash\nexit 73\n');
      const result = runMaterializer(hostSecretDirectory, {
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        WALG_INSTALL_RUNNING_CONTAINER: 'true',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Docker control plane is unavailable');
      expect(result.stdout).not.toContain('container is absent');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('requires a run-scoped PITR credential source and rejects the production write bundle', () => {
    const pitr = read(PITR_RESTORE_PATH);
    expect(pitr).toContain(
      'TARGET_WALG_SECRET_SOURCE="${TARGET_WALG_SECRET_SOURCE:?TARGET_WALG_SECRET_SOURCE required}"',
    );
    expect(pitr).toContain(
      '[ "${TARGET_WALG_SECRET_SOURCE}" = \'/var/aqua-saas/certs/wal-g/postgres\' ]',
    );
    expect(pitr).not.toContain('TARGET_WALG_SECRET_SOURCE:-/var/aqua-saas/certs/wal-g/postgres');
  });

  it('recovers injected publication failures and stale controlled residue without accepting extras', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'walg-materializer-restart-'));
    const hostSecretDirectory = join(scratch, 'secrets', 'wal-g');
    const fakeBin = join(scratch, 'bin');
    const moveCounter = join(scratch, 'mv-count');
    const realMove = spawnSync('bash', ['-ceu', 'command -v mv'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });

    try {
      expect(realMove.status).toBe(0);
      mkdirSync(fakeBin, { recursive: true });
      writeExecutable(
        join(fakeBin, 'mv'),
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          'count=0',
          'if [ -f "${WALG_TEST_MV_COUNT_FILE:?}" ]; then IFS= read -r count < "${WALG_TEST_MV_COUNT_FILE}"; fi',
          'count=$((count + 1))',
          'printf "%s\\n" "${count}" > "${WALG_TEST_MV_COUNT_FILE}"',
          'if [ "${count}" -eq 2 ]; then exit 91; fi',
          'exec "${WALG_TEST_REAL_MV:?}" "$@"',
          '',
        ].join('\n'),
      );

      const injectedFailure = runMaterializer(hostSecretDirectory, {
        PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        WALG_TEST_MV_COUNT_FILE: moveCounter,
        WALG_TEST_REAL_MV: realMove.stdout.trim(),
      });
      expect(injectedFailure.status).toBe(91);
      expect(readdirSync(hostSecretDirectory).sort()).toEqual(['.lock']);

      const killedInitialStage = join(hostSecretDirectory, '.materialize.Z9y8X7');
      mkdirSync(killedInitialStage, { mode: 0o700 });
      writeFileSync(join(killedInitialStage, '.initial-publication'), '', { mode: 0o600 });
      writeFileSync(join(hostSecretDirectory, 'aws_access_key_id'), 'partial-new-value', {
        mode: 0o600,
      });
      writeFileSync(
        join(hostSecretDirectory, '.manifest.sha256.next.31337'),
        'publication-residue',
        { mode: 0o600 },
      );

      const restarted = runMaterializer(hostSecretDirectory);
      expect(restarted.status).toBe(0);
      expect(readdirSync(hostSecretDirectory).sort()).toEqual(
        [
          '.lock',
          'aws_access_key_id',
          'aws_secret_access_key',
          'libsodium.key',
          'manifest.sha256',
          'walg_backup_epoch',
          'walg_s3_prefix',
        ].sort(),
      );

      const killedStage = join(hostSecretDirectory, '.materialize.A1b2C3');
      mkdirSync(killedStage, { mode: 0o700 });
      writeFileSync(join(killedStage, 'libsodium.key'), TEST_WALG_KEY, { mode: 0o600 });
      writeFileSync(join(hostSecretDirectory, '.walg_s3_prefix.next.4242'), TEST_WALG_PREFIX, {
        mode: 0o600,
      });
      expect(runMaterializer(hostSecretDirectory).status).toBe(0);
      expect(
        readdirSync(hostSecretDirectory).some((entry) => entry.startsWith('.materialize.')),
      ).toBe(false);
      expect(readdirSync(hostSecretDirectory).some((entry) => entry.includes('.next.'))).toBe(
        false,
      );

      const unexpectedEntry = join(hostSecretDirectory, 'untracked-secret-copy');
      writeFileSync(unexpectedEntry, 'must-not-be-accepted', { mode: 0o600 });
      const materializerRejectsExtra = runMaterializer(hostSecretDirectory);
      expect(materializerRejectsExtra.status).not.toBe(0);
      expect(materializerRejectsExtra.stderr).toContain('contains an unexpected entry');
      expect(readFileSync(unexpectedEntry, 'utf8')).toBe('must-not-be-accepted');

      const loaderRejectsExtra = runSourceBundleValidation(hostSecretDirectory);
      expect(loaderRejectsExtra.status).not.toBe(0);
      expect(loaderRejectsExtra.stderr).toContain('contains an unexpected entry');
      rmSync(unexpectedEntry);
      expect(runSourceBundleValidation(hostSecretDirectory).status).toBe(0);
      expect(
        runSourceBundleValidation(
          hostSecretDirectory,
          'epoch-20260716-002',
          's3://test-bucket/postgres/wal-g/epoch-20260716-002',
        ).status,
      ).not.toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects symlink ancestors in both WAL-G bundle publication and loading', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'walg-materializer-symlink-'));
    const realParent = join(scratch, 'real-parent');
    const aliasParent = join(scratch, 'alias-parent');
    const realBundle = join(realParent, 'wal-g');

    try {
      mkdirSync(realParent, { recursive: true });
      symlinkSync(realParent, aliasParent, 'dir');
      const rejectedPublication = runMaterializer(join(aliasParent, 'wal-g'));
      expect(rejectedPublication.status).not.toBe(0);
      expect(rejectedPublication.stderr).toContain('symlink ancestor');
      expect(runMaterializer(realBundle).status).toBe(0);

      const rejectedLoad = runSourceBundleValidation(join(aliasParent, 'wal-g'));
      expect(rejectedLoad.status).not.toBe(0);
      expect(rejectedLoad.stderr).toContain('symlinked ancestor');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('enforces WAL-G epoch, archive prefix, and encryption-key rotation as one tuple', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'walg-epoch-rotation-'));
    const hostSecretDirectory = join(scratch, 'wal-g');

    try {
      expect(runMaterializer(hostSecretDirectory).status).toBe(0);
      const initialManifest = readFileSync(join(hostSecretDirectory, 'manifest.sha256'), 'utf8');

      const sameEpochKeyMutation = runMaterializer(hostSecretDirectory, {
        WALG_LIBSODIUM_KEY_B64: TEST_WALG_NEXT_KEY,
      });
      expect(sameEpochKeyMutation.status).not.toBe(0);
      expect(sameEpochKeyMutation.stderr).toContain(
        'same-epoch WAL-G rotation may change only the access-key principal',
      );
      expect(readFileSync(join(hostSecretDirectory, 'manifest.sha256'), 'utf8')).toBe(
        initialManifest,
      );

      const sameEpochPrincipalRotation = runMaterializer(hostSecretDirectory, {
        WALG_S3_ACCESS_KEY_ID: 'rotated-access-key',
        WALG_S3_SECRET_ACCESS_KEY: 'rotated-secret-key',
      });
      expect(sameEpochPrincipalRotation.status).toBe(0);
      expect(readFileSync(join(hostSecretDirectory, 'aws_access_key_id'), 'utf8')).toBe(
        'rotated-access-key',
      );

      const nextEpoch = 'epoch-20260716-002';
      const nextPrefix = `s3://test-bucket/postgres/wal-g/${nextEpoch}`;
      const reusedEncryptionKey = runMaterializer(hostSecretDirectory, {
        WALG_BACKUP_EPOCH: nextEpoch,
        WALG_S3_PREFIX: nextPrefix,
      });
      expect(reusedEncryptionKey.status).not.toBe(0);
      expect(reusedEncryptionKey.stderr).toContain(
        'requires both a new archive prefix and a new encryption key',
      );
      expect(readFileSync(join(hostSecretDirectory, 'walg_backup_epoch'), 'utf8')).toBe(
        TEST_WALG_BACKUP_EPOCH,
      );

      const completeEpochRotation = runMaterializer(hostSecretDirectory, {
        WALG_BACKUP_EPOCH: nextEpoch,
        WALG_S3_PREFIX: nextPrefix,
        WALG_LIBSODIUM_KEY_B64: TEST_WALG_NEXT_KEY,
      });
      expect(completeEpochRotation.status).toBe(0);
      expect(readFileSync(join(hostSecretDirectory, 'walg_backup_epoch'), 'utf8')).toBe(nextEpoch);
      expect(readFileSync(join(hostSecretDirectory, 'walg_s3_prefix'), 'utf8')).toBe(nextPrefix);
      expect(runSourceBundleValidation(hostSecretDirectory, nextEpoch, nextPrefix).status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('rejects a corrupted prior manifest before it can authorize a key rotation', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'walg-corrupt-rotation-authority-'));
    const hostSecretDirectory = join(scratch, 'wal-g');
    try {
      expect(runMaterializer(hostSecretDirectory).status).toBe(0);
      const manifestPath = join(hostSecretDirectory, 'manifest.sha256');
      const forgedKeyHash = createHash('sha256').update(TEST_WALG_NEXT_KEY).digest('hex');
      const forgedManifest = readFileSync(manifestPath, 'utf8').replace(
        /^[0-9a-f]{64} {2}libsodium\.key$/m,
        `${forgedKeyHash}  libsodium.key`,
      );
      writeFileSync(manifestPath, forgedManifest, { mode: 0o600 });

      const rejected = runMaterializer(hostSecretDirectory, {
        WALG_LIBSODIUM_KEY_B64: TEST_WALG_NEXT_KEY,
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain(
        'existing WAL-G credential manifest does not match the prior bundle bytes',
      );
      expect(readFileSync(join(hostSecretDirectory, 'libsodium.key'), 'utf8')).toBe(TEST_WALG_KEY);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('never emits the libsodium key when bundle validation inherits xtrace', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'walg-loader-xtrace-'));
    const hostSecretDirectory = join(scratch, 'wal-g');
    try {
      expect(runMaterializer(hostSecretDirectory).status).toBe(0);
      const traced = spawnSync(
        'bash',
        [
          '-xceu',
          'source "$1"; _walg_validate_bundle "$2" source',
          'walg-loader-xtrace-test',
          SECRET_LOADER_PATH,
          hostSecretDirectory,
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            WALG_BACKUP_EPOCH: TEST_WALG_BACKUP_EPOCH,
            WALG_S3_PREFIX: TEST_WALG_PREFIX,
          },
        },
      );
      expect(traced.status).toBe(0);
      expect(traced.stderr).not.toContain(TEST_WALG_KEY);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('returns completed production backup evidence over protected native OpenSSH', () => {
    const workflow = read(BACKUP_WORKFLOW_PATH);
    const materializeIndex = workflow.indexOf(
      'bash tools/scripts/database/materialize-walg-secrets.sh',
    );
    const backupIndex = workflow.indexOf('bash tools/scripts/database/walg-base-backup.sh');
    const logicalBackupIndex = workflow.indexOf('bash tools/scripts/database/backup-databases.sh');
    const evidenceMarkerIndex = workflow.indexOf("printf 'AQUA_WALG_EVIDENCE_B64=%s\\n'");
    const captureIndex = workflow.indexOf(
      'Capture completed ceremony evidence from protected OpenSSH transport',
    );

    expect(materializeIndex).toBeGreaterThanOrEqual(0);
    expect(backupIndex).toBeGreaterThan(materializeIndex);
    expect(logicalBackupIndex).toBeGreaterThan(backupIndex);
    expect(evidenceMarkerIndex).toBeGreaterThan(logicalBackupIndex);
    expect(captureIndex).toBeGreaterThan(evidenceMarkerIndex);
    expect(workflow).toContain('WALG_LIBSODIUM_KEY_B64');
    expect(workflow).toContain('bash tools/scripts/ci/run-protected-ssh.sh');
    expect(workflow).toContain(
      'REMOTE_EVIDENCE_B64: ${{ steps.remote_backup.outputs.evidence_b64 }}',
    );
    expect(workflow).toContain(
      'DRY_RUN=true — skipping all WAL-G credential materialization and activation',
    );
    expect(workflow).toContain("sed -n 's/^AQUA_WALG_EVIDENCE_B64=");
    expect(workflow).toContain('evidence_b64: ${{ steps.capture_evidence.outputs.evidence_b64 }}');
    expect(workflow).not.toContain('appleboy/ssh-action@');
    expect(workflow).not.toContain('capture_stdout:');
    expect(workflow).not.toContain('steps.remote_backup.outputs.stdout');
    expect(workflow).not.toMatch(/WALG_LIBSODIUM_KEY:\s*\$\{\{\s*secrets\./);
    expect(workflow).not.toContain('node tools/scripts/database/evaluate-walg-evidence.mjs');
    expect(workflow).not.toContain('aws s3 cp "${EVIDENCE_FILE}"');
    expect(workflow).not.toMatch(/walg-base-backup[^\n]*\|\|\s*(?:true|:)/);
  });

  it('materializes a run-scoped read-only PITR bundle without rotating the live source bundle', () => {
    const workflow = read(PITR_WORKFLOW_PATH);

    expect(workflow).toContain('PITR_WALG_SPACES_ACCESS_KEY_ID');
    expect(workflow).toContain('PITR_WALG_SPACES_SECRET_ACCESS_KEY');
    expect(workflow).toContain('PITR_WALG_LIBSODIUM_KEY_B64');
    expect(workflow).toContain('TARGET_SECRET_SOURCE="${RUNTIME_ROOT}/target-wal-g-secrets"');
    expect(workflow).toContain('WALG_HOST_SECRET_DIR="${TARGET_SECRET_SOURCE}"');
    expect(workflow).toContain('WALG_INSTALL_RUNNING_CONTAINER=false');
    expect(workflow).toContain('--env "WALG_BACKUP_EPOCH=${PITR_WALG_BACKUP_EPOCH}"');
    expect(workflow).toContain('--env "WALG_S3_PREFIX=${TARGET_WALG_S3_PREFIX}"');
    expect(workflow).toContain('selected PITR epoch/prefix is not the active source archive chain');
    expect(workflow).not.toContain('TARGET_SECRET_SOURCE=/var/aqua-saas/certs/postgres/wal-g');
    expect(workflow).not.toContain('WALG_INSTALL_RUNNING_CONTAINER=true');
  });

  it('executes only seven hash-pinned inputs from the eight-file protected archive', () => {
    const workflow = read(BACKUP_WORKFLOW_PATH);
    const manifestEntries = hashManifestEntries(read(BACKUP_HASH_MANIFEST_PATH));
    const hashWorkflow = read(BACKUP_HASH_WORKFLOW_PATH);

    expect([...manifestEntries.keys()].sort()).toEqual([...TRUSTED_BACKUP_BUNDLE].sort());
    for (const path of TRUSTED_BACKUP_BUNDLE) {
      expect(manifestEntries.get(path)).toBe(sha256(join(REPO_ROOT, path)));
      expect(workflow).toContain(path);
      expect(hashWorkflow).toContain(`- '${path}'`);
    }

    expect(workflow).toContain('RUNTIME_ROOT=$(mktemp -d /tmp/aqua-backup-runtime.XXXXXX)');
    expect(workflow).toContain('cd "${RUNTIME_ROOT}"');
    expect(workflow).toContain('bash tools/scripts/ci/prepare-protected-runtime-bundle.sh');
    expect(workflow).toContain('base64 -w0 "${RUNTIME_BUNDLE_PATH}"');
    expect(workflow).toContain('base64 --decode > "${RUNTIME_BUNDLE_TAR}"');
    expect(workflow).toContain('EXPECTED_ARCHIVE_PATHS=$(printf');
    expect(workflow).toContain('tar --extract --no-same-owner --no-same-permissions');
    expect(workflow).not.toMatch(/^\s+git -C "\$\{REPOSITORY\}"/m);
    expect(workflow).toContain('sha256sum --check "${MANIFEST}"');
    expect(workflow).not.toContain('REPOSITORY=/var/aqua-saas');
    expect(workflow).not.toContain('protected_git');
    expect(workflow).not.toContain('origin "main:');
    expect(workflow).not.toMatch(
      /\bgit(?:\s+-C\s+(?:"[^"]+"|\S+))?\s+(?:checkout|restore|switch|reset)\b/,
    );
    expect(workflow).not.toContain('cd /var/aqua-saas');
  });

  it('re-attests random run-owned Docker resources immediately before PITR cleanup', () => {
    const workflow = read(PITR_WORKFLOW_PATH);
    const cleanupStart = workflow.indexOf('cleanup_runtime() {');
    const cleanupEnd = workflow.indexOf('trap cleanup_runtime EXIT', cleanupStart);
    const cleanup = workflow.slice(cleanupStart, cleanupEnd);

    expect(cleanupStart).toBeGreaterThanOrEqual(0);
    expect(cleanupEnd).toBeGreaterThan(cleanupStart);
    expect(workflow).toContain(
      "RESOURCE_NONCE=$(od -An -N16 -tx1 /dev/urandom | tr -d '[:space:]')",
    );
    expect(workflow).toContain('[[ ! "${RESOURCE_NONCE}" =~ ^[0-9a-f]{32}$ ]]');
    expect(workflow).toContain('TARGET_CONTAINER="aqua-pitr-${EVIDENCE_RUN_ID}-${RESOURCE_NONCE}"');
    expect(workflow).toContain('TARGET_NETWORK="aqua-pitr-${EVIDENCE_RUN_ID}-${RESOURCE_NONCE}"');
    expect(workflow).toContain(
      'TARGET_VOLUME="aqua-pitr-${EVIDENCE_RUN_ID}-${RESOURCE_NONCE}-pgdata"',
    );
    expect(workflow).toContain('TARGET_NETWORK_ID=$(docker network create');
    expect(workflow).toContain('TARGET_CONTAINER_ID=$(docker create');
    expect(workflow).toContain(
      '--label "com.aqua-saas.restore.owner-network-id=${TARGET_NETWORK_ID}"',
    );
    expect(
      workflow.match(/--label "com\.aqua-saas\.restore\.nonce=\$\{RESOURCE_NONCE\}"/g),
    ).toHaveLength(3);
    expect(workflow).toContain('[ "${CREATED_VOLUME_ROLE}" != \'isolated-drill\' ]');
    expect(workflow).toContain(
      '[ "${CREATED_VOLUME_OWNER_NETWORK_ID}" != "${TARGET_NETWORK_ID}" ]',
    );
    expect(workflow.indexOf('VOLUME_CREATED=true')).toBeGreaterThan(
      workflow.indexOf('refusing to claim a PITR volume without exact fresh-run ownership'),
    );

    expect(cleanup).toContain(
      'if ! attest_target_container; then\n' +
        "                  echo 'FATAL: refusing to remove a PITR container whose immutable identity or ownership labels changed.' >&2\n" +
        '                  cleanup_status=1\n' +
        '                elif ! docker rm --force "${TARGET_CONTAINER_ID}"',
    );
    expect(cleanup).toContain(
      'if ! attest_target_network; then\n' +
        "                  echo 'FATAL: refusing to remove a PITR network whose immutable identity or ownership labels changed.' >&2\n" +
        '                  cleanup_status=1\n' +
        '                elif ! docker network rm "${TARGET_NETWORK_ID}"',
    );
    expect(cleanup).toContain(
      'if ! attest_target_volume; then\n' +
        "                  echo 'FATAL: refusing to remove a PITR volume whose creation identity or ownership labels changed.' >&2\n" +
        '                  cleanup_status=1\n' +
        '                elif ! docker volume rm "${TARGET_VOLUME}"',
    );
    expect(cleanup).not.toContain('docker rm --force "${TARGET_CONTAINER}"');
    expect(cleanup).not.toContain('docker network rm "${TARGET_NETWORK}"');
  });

  it('signs stdout evidence before preserving an immutable run-scoped artifact', () => {
    const workflow = read(BACKUP_WORKFLOW_PATH);
    const createRunIndex = workflow.indexOf('walg-evidence-attestation.mjs create-run');
    const createEvidenceIndex = workflow.indexOf('walg-evidence-attestation.mjs create-evidence');
    const verifyIndex = workflow.indexOf('cosign verify-blob');
    const mirrorIndex = workflow.indexOf('Mirror signed records by content digest');
    const artifactIndex = workflow.indexOf('actions/upload-artifact@');
    const propagateFailureIndex = workflow.indexOf(
      'Propagate backup job failure after preserving its signed run record',
    );

    expect(createRunIndex).toBeGreaterThanOrEqual(0);
    expect(createEvidenceIndex).toBeGreaterThan(createRunIndex);
    expect(verifyIndex).toBeGreaterThan(createEvidenceIndex);
    expect(mirrorIndex).toBeGreaterThan(verifyIndex);
    expect(artifactIndex).toBeGreaterThan(mirrorIndex);
    expect(propagateFailureIndex).toBeGreaterThan(artifactIndex);
    expect(workflow).toContain('id-token: write');
    expect(workflow.match(/cosign sign-blob --yes/g)).toHaveLength(2);
    expect(workflow).toContain('--bundle evidence-artifact/run-record.sigstore.json');
    expect(workflow).toContain('--bundle evidence-artifact/evidence-attestation.sigstore.json');
    expect(workflow).toContain(
      "--certificate-oidc-issuer 'https://token.actions.githubusercontent.com'",
    );
    expect(workflow).toContain('VERSIONING_STATUS=$(aws s3api get-bucket-versioning');
    expect(workflow).toContain(
      'RECORD_KEY="wal-g-evidence/v2/sha256/${RECORD_SHA256}/$(basename "${RECORD}")"',
    );
    expect(workflow).toContain(
      'name: walg-evidence-v2-backup-production.yml-${{ github.run_id }}-${{ github.run_attempt }}',
    );
    expect(workflow).toContain('overwrite: false');
    expect(workflow).not.toContain('aws s3 cp "${EVIDENCE_FILE}"');
  });

  it('keeps archive and restore wrappers argument-safe and preserves WAL-G failures', () => {
    const archiveWrapper = read(ARCHIVE_WRAPPER_PATH);
    const restoreWrapper = read(RESTORE_WRAPPER_PATH);
    const runtimeWrapper = expectStrictShell(RUNTIME_WRAPPER_PATH);

    expect(executableShellLines(archiveWrapper)).toContain('set -euo pipefail');
    expect(executableShellLines(restoreWrapper)).toContain('set -euo pipefail');
    expect(archiveWrapper).not.toMatch(/\bset\s+-x\b|\bset\s+-o\s+xtrace\b/);
    expect(restoreWrapper).not.toMatch(/\bset\s+-x\b|\bset\s+-o\s+xtrace\b/);

    expect(runtimeWrapper).toMatch(/\bcase\b/);
    expect(runtimeWrapper).not.toMatch(/\beval\b|\bbash\s+-c\b|\bsh\s+-c\b/);
    for (const command of ['backup-list', 'backup-push', 'backup-fetch', 'wal-verify']) {
      expect(runtimeWrapper).toContain(command);
    }
    expect(runtimeWrapper).toMatch(/\*\)[\s\S]{0,240}(?:exit|return)\s+[1-9]\d*/);

    expect(archiveWrapper).toMatch(/\[\[?\s+"?\$#"?\s+-(?:eq|ne)\s+2/);
    expect(archiveWrapper).toMatch(/basename/);
    expect(archiveWrapper).toMatch(/walg_exec\s+wal-push\s+"\$\{wal_path\}"/);
    expect(archiveWrapper).not.toMatch(/wal-push[^\n]*wal_name/);
    expect(restoreWrapper).toMatch(/\[\[?\s+"?\$#"?\s+-(?:eq|ne)\s+2/);
    expect(restoreWrapper).toMatch(
      /walg_exec\s+wal-fetch\s+"\$\{wal_name\}"\s+"\$\{destination\}"/,
    );
    expect(restoreWrapper).not.toMatch(/\bexec\s+[^\n]*wal-fetch/);
    expect(archiveWrapper).toMatch(/else\s+status=\$\?\s+fi/);
    expect(restoreWrapper).toMatch(/else\s+status=\$\?\s+fi/);
    expect(restoreWrapper).toMatch(/"\$\{status\}"\s+-eq\s+74/);
    expect(restoreWrapper).toMatch(/exit\s+74/);
    expect(restoreWrapper).toMatch(/"\$\{status\}"\s+-lt\s+126/);
    expect(restoreWrapper).toMatch(/(?:exit|return)\s+(?:12[6-9]|1[3-9]\d|2\d\d)/);
    expect(restoreWrapper).toMatch(/exit\s+"\$\{status\}"/);
    expect(archiveWrapper).not.toMatch(/\|\|\s*(?:true|:)/);
    expect(restoreWrapper).not.toMatch(/\|\|\s*(?:true|:)/);

    const scratch = mkdtempSync(join(tmpdir(), 'aqua-walg-wrapper-'));
    try {
      const walName = '000000010000000000000001';
      const walPath = join(scratch, walName);
      writeFileSync(walPath, 'wal-segment', { encoding: 'utf8', mode: 0o600 });

      expect(runWrapperWithWalgStatus(archiveWrapper, 0, [walPath, walName])).toBe(0);
      expect(runWrapperWithWalgStatus(archiveWrapper, 1, [walPath, walName])).toBe(1);
      expect(runWrapperWithWalgStatus(archiveWrapper, 74, [walPath, walName])).toBe(74);
      expect(runWrapperWithWalgStatus(archiveWrapper, 130, [walPath, walName])).toBe(130);

      expect(runWrapperWithWalgStatus(restoreWrapper, 0, [walName, walPath])).toBe(0);
      expect(runWrapperWithWalgStatus(restoreWrapper, 1, [walName, walPath])).toBe(126);
      expect(runWrapperWithWalgStatus(restoreWrapper, 74, [walName, walPath])).toBe(74);
      expect(runWrapperWithWalgStatus(restoreWrapper, 130, [walName, walPath])).toBe(130);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('creates verified full base backups with delta ancestry disabled', () => {
    const backup = expectStrictShell(BASE_BACKUP_PATH);
    const loader = read(SECRET_LOADER_PATH);
    const runtimeWrapper = read(RUNTIME_WRAPPER_PATH);

    expect(backup).toContain('assert-runtime');
    expect(backup.match(/backup-list-json/g)).toHaveLength(2);
    expect(backup).toContain('backup-push-full');
    expect(backup).toMatch(/wal-verify\s+"\$\{BACKUP_NAME\}"/);
    expect(backup).toMatch(/LATEST\|latest\|''\)\s+die/);
    expect(runtimeWrapper).toMatch(
      /walg_exec\s+backup-push\s+"\$\{PGDATA:\?PGDATA required\}"\s+--full\s+--verify/,
    );
    expect(loader).toMatch(/WALG_DELTA_MAX_STEPS=.*0/);
    expect(runtimeWrapper).not.toMatch(/--delta-from/);
    expect(backup).toMatch(/(?:evidence|EVIDENCE)/);
    expect(backup).toContain('created backup user_data does not match the run/main/full authority');
    expect(backup).toContain(
      'created backup system identifier differs from the live source cluster',
    );
    expect(backup).toContain('backup_wal_file_name');
    expect(backup).toContain('backup_start_lsn');
    expect(backup).toContain('backup_finish_lsn');
    expect(backup).toContain('source_system_identifier');
    expect(backup).toContain('source_image_id');
    expect(backup).toContain('source_image_revision');
    expect(backup).toContain('source_postgres_dr_contract_sha256');
    expect(backup).toContain('source_wal_g_revision');
    expect(backup).toContain('walg_config_sha256');
    expect(backup).toContain('walg_rotation_bundle_sha256');
    expect(backup).toContain('changed during backup');
    for (const field of ['full', 'verified', 'wal_verified']) {
      expect(backup).toContain(`${field}: succeeded`);
    }
  });

  it('requires an explicitly named base backup for isolated timestamp recovery', () => {
    const pitr = expectStrictShell(PITR_RESTORE_PATH);

    expect(pitr).toMatch(/com\.aqua-saas\.restore\.role/);
    expect(pitr).toMatch(/RESTORE_ROLE='isolated-drill'/);
    expect(pitr).toMatch(/TARGET_COMPOSE_SERVICE[^\n]*=[^\n]*postgres/);
    expect(pitr).toContain('"${WALG_RUNTIME_COMMAND}" wal-verify-at-lsn \\');
    expect(pitr).toContain(
      '"${BACKUP_NAME}" "${SOURCE_TIMELINE_ID}" "${SOURCE_AFTER_COMMIT_FENCE_LSN}"',
    );
    expect(pitr).toMatch(/backup-fetch\s+"\$\{BACKUP_NAME\}"/);
    expect(pitr).toMatch(/recovery\.signal/);
    expect(pitr).toMatch(/recovery_target_time/);
    expect(pitr).toMatch(/recovery_target_action/);
    expect(pitr).toMatch(/promote/);
    expect(pitr).toMatch(/LATEST\|latest\)\s*die[^\n]*forbidden/);
    expect(pitr).toMatch(/(?:BACKUP_NAME|BASE_BACKUP)/);
    expect(pitr).toMatch(/(?:SENTINEL|sentinel)/);
    expect(pitr).toMatch(/(?:MAX_RPO_SECONDS|RPO_LIMIT_SECONDS).*300/);
    expect(pitr).toMatch(/(?:MAX_RTO_SECONDS|RTO_LIMIT_SECONDS).*3600/);
    expect(pitr).toContain('PITR_RESET_TARGET=true is required');
    expect(pitr).toContain('before=true and after=false');

    // The evidence names distinguish immutable ledger insertion metadata from
    // the separate transaction commit fences.
    expect(pitr).toContain('source_before_sentinel_recorded_at');
    expect(pitr).toContain('source_after_sentinel_recorded_at');
    expect(pitr).toContain('restored_before_sentinel_recorded_at');
    expect(pitr).not.toMatch(/(?:source|restored)_(?:before|after)_sentinel_committed_at/);
    expect(pitr).toContain('SOURCE_BEFORE_RECORDED_AT');
    expect(pitr).toContain('SOURCE_AFTER_RECORDED_AT');
    expect(pitr).toContain('RESTORED_BEFORE_RECORDED_AT');
    expect(pitr).toMatch(
      /"\$\{RESTORED_BEFORE_RECORDED_AT\}"\s+(?:=|!=)\s+"\$\{SOURCE_BEFORE_RECORDED_AT\}"/,
    );

    expect(pitr).toContain('source_before_commit_fence_at');
    expect(pitr).toContain('source_before_commit_fence_lsn');
    expect(pitr).toContain('source_after_commit_fence_at');
    expect(pitr).toContain('source_after_commit_fence_lsn');
    expect(pitr).toContain('source_after_sentinel_recorded_lsn');
    expect(pitr).toContain(
      'values[0] <= values[1] && values[1] <= values[2] && values[2] <= values[3] && values[1] < values[3]',
    );

    const archiveFenceIndex = pitr.indexOf("FAILURE_STAGE='wal-archive-fence'");
    const sourceLossFenceIndex = pitr.indexOf("FAILURE_STAGE='source-loss-fence'");
    const failureTimeIndex = pitr.indexOf('FAILURE_TIME="${ARCHIVE_OBSERVED_AT}"');
    const targetSecretIndex = pitr.indexOf("FAILURE_STAGE='target-secret-install'");
    const targetWalVerifyIndex = pitr.indexOf("FAILURE_STAGE='wal-verify-from-isolated-target'");
    const targetSecretRelinkIndex = pitr.indexOf("FAILURE_STAGE='target-secret-relink'");
    const secondEpochAttestationIndex = pitr.indexOf(
      'TARGET_WALG_ROTATION_BUNDLE_AFTER_FETCH_SHA256=$(container_walg_rotation_bundle_sha256',
    );
    const recoveryConfigurationIndex = pitr.indexOf("FAILURE_STAGE='recovery-configuration'");
    expect(archiveFenceIndex).toBeGreaterThanOrEqual(0);
    expect(sourceLossFenceIndex).toBeGreaterThan(archiveFenceIndex);
    expect(failureTimeIndex).toBeGreaterThan(sourceLossFenceIndex);
    expect(targetSecretIndex).toBeGreaterThan(failureTimeIndex);
    expect(targetWalVerifyIndex).toBeGreaterThan(targetSecretIndex);
    expect(targetSecretRelinkIndex).toBeGreaterThan(targetWalVerifyIndex);
    expect(secondEpochAttestationIndex).toBeGreaterThan(targetSecretRelinkIndex);
    expect(recoveryConfigurationIndex).toBeGreaterThan(secondEpochAttestationIndex);
    expect(pitr).toContain(
      'isolated target WAL-G configuration/rotation bundle changed before recovery',
    );
    expect(pitr.slice(failureTimeIndex)).not.toMatch(/\bsource_psql\b/);
    expect(pitr).toContain('archive_observed_at');
    expect(pitr).toContain('archive_required_wal');
    expect(pitr).toContain('archived_through_wal');
    expect(pitr).toContain('ARCHIVE_REQUIRED_WAL="${AFTER_WAL_FILE}"');
    expect(pitr).toMatch(
      /RPO_SECONDS=\$\(\(\s*\(FAILURE_NS\s*-\s*BEFORE_NS\s*\+\s*999999999\)\s*\/\s*1000000000\s*\)\)/,
    );

    // The source is the canonical production Compose resource; the target is
    // an immutable-ID, run-scoped, resource-bounded isolated container.
    expect(pitr).toContain('SOURCE_COMPOSE_WORKING_DIR');
    expect(pitr).toContain('SOURCE_COMPOSE_CONFIG_FILES');
    expect(pitr).toContain('SOURCE_COMPOSE_ONEOFF');
    expect(pitr).toContain('[ "${SOURCE_COMPOSE_WORKING_DIR}" != \'/var/aqua-saas\' ]');
    expect(pitr).toContain('source and target must use the exact same immutable image ID');
    expect(pitr).toContain('org.opencontainers.image.revision');
    expect(pitr).toContain('ReadonlyRootfs');
    expect(pitr).toContain('target root filesystem must be read-only');
    expect(pitr).toContain("capDrop.join(',') !== 'ALL'");
    expect(pitr).toContain("capAdd.join(',') !== 'CHOWN,DAC_OVERRIDE,FOWNER'");
    expect(pitr).toContain("config.SecurityOpt.includes('no-new-privileges:true')");
    expect(pitr).toContain('config?.Memory !== 2147483648');
    expect(pitr).toContain('config?.NanoCpus !== 1000000000');
    expect(pitr).toContain('TARGET_READ_ONLY_ROOTFS=true');

    expect(pitr).toMatch(/NetworkSettings\.Networks/);
    expect(pitr).toContain('target must have exactly one run-scoped network');
    expect(pitr).toContain('source and target share the restore network');
    expect(pitr).toContain('target network ICC must be false');
    expect(pitr).toContain('target network must contain only the target container');
    expect(pitr).toContain('target network was not freshly created for this drill');
    expect(pitr).toMatch(/\.Mounts/);
    expect(pitr).toContain('source and target share a writable PGDATA mount');
    expect(pitr).toContain('source and target PGDATA volume authorities are identical');
    expect(pitr).toContain(
      'target PGDATA volume must be attached only to the run-scoped target container',
    );
    expect(pitr).toContain('target PGDATA volume was not freshly created for this drill');
    expect(pitr).toContain("mount.Type === 'bind' && mount.RW === false");

    expect(pitr).toContain('EXPECTED_SOURCE_SYSTEM_IDENTIFIER');
    expect(pitr).toContain(
      'restored target system identifier differs from the attested source cluster',
    );
    expect(pitr).toContain('walg_config_sha256');
    expect(pitr).toContain('walg_rotation_bundle_sha256');
    expect(pitr).toContain('isolated target WAL-G configuration/rotation bundle differs');
  });

  it('requires three consecutive backups and one bounded PITR proof', () => {
    const evaluator = read(EVIDENCE_EVALUATOR_PATH);
    expect(evaluator).toContain('export function evaluateWalgEvidence');
    expect(evaluator).not.toContain('_sentinel_committed_at');
    expect(evaluator).toContain('CHAIN_AUTHORITY_FIELDS');
    expect(evaluator).toContain('hasSameChainAuthority(record, matchingBackup)');

    const twoBackups = evaluateEvidence([backupEvidence(1), backupEvidence(2)]);
    expect(twoBackups.status).toBe(1);
    expect(twoBackups.stdout).toMatch(/requires 3 consecutive/);

    const interrupted = evaluateEvidence([
      backupEvidence(1),
      backupEvidence(2, { status: 'failure' }),
      backupEvidence(3),
      backupEvidence(4),
    ]);
    expect(interrupted.status).toBe(1);
    expect(interrupted.stdout).toMatch(/requires 3 consecutive/);

    const duplicateBackup = evaluateEvidence([
      backupEvidence(1, { backup_name: 'base_duplicate' }),
      backupEvidence(2, { backup_name: 'base_duplicate' }),
      backupEvidence(3, { backup_name: 'base_duplicate' }),
      pitrEvidence('base_duplicate'),
    ]);
    expect(duplicateBackup.status).toBe(1);
    expect(duplicateBackup.stdout).toMatch(/requires 3 consecutive/);

    const backups = [backupEvidence(1), backupEvidence(2), backupEvidence(3)];
    const backupName = String(backups[2]?.backup_name);
    const missingPitr = evaluateEvidence(backups);
    expect(missingPitr.status).toBe(1);
    expect(missingPitr.stdout).toMatch(/requires one isolated timestamp PITR/);

    const valid = evaluateEvidence([...backups, pitrEvidence(backupName)]);
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain('"ok":true');
    expect(valid.stdout).toContain('"pitrRunId":"pitr-1"');

    const staleMainSha = 'b'.repeat(40);
    const staleMain = evaluateEvidence([
      ...backups.map((record) => {
        if (!isRecord(record.backup_user_data)) {
          throw new Error('Expected canonical backup user_data fixture');
        }
        return {
          ...record,
          main_sha: staleMainSha,
          source_image_revision: staleMainSha,
          backup_user_data: {
            ...record.backup_user_data,
            main_sha: staleMainSha,
          },
        };
      }),
      pitrEvidence(backupName, {
        main_sha: staleMainSha,
        source_image_revision: staleMainSha,
      }),
    ]);
    expect(staleMain.status).toBe(1);
    expect(staleMain.stdout).toMatch(/main_sha does not match required current main/);

    for (const foreignAuthority of [
      { source_system_identifier: '7500000000000000001' },
      { source_image_id: `sha256:${'c'.repeat(64)}` },
      { source_postgres_dr_contract_sha256: '3'.repeat(64) },
      { walg_config_sha256: '1'.repeat(64) },
      { walg_rotation_bundle_sha256: '2'.repeat(64) },
    ]) {
      const mixedBackupChain = evaluateEvidence([
        backupEvidence(1),
        backupEvidence(2, foreignAuthority),
        backupEvidence(3),
        pitrEvidence(backupName),
      ]);
      expect(mixedBackupChain.status).toBe(1);
      expect(mixedBackupChain.stdout).toMatch(
        /one exact system\/config\/key\/image\/main WAL chain/,
      );
    }

    const foreignMainSha = 'f'.repeat(40);
    const mixedMainAuthority = evaluateEvidence([
      backupEvidence(1),
      backupEvidence(2, {
        main_sha: foreignMainSha,
        source_image_revision: foreignMainSha,
        backup_user_data: {
          aqua_run_id: 'backup-2',
          backup_kind: 'full',
          main_sha: foreignMainSha,
        },
      }),
      backupEvidence(3),
      pitrEvidence(backupName),
    ]);
    expect(mixedMainAuthority.status).toBe(1);

    const rewoundWalCoordinates = evaluateEvidence([
      backupEvidence(1),
      backupEvidence(2, { backup_start_lsn: '100', backup_finish_lsn: '200' }),
      backupEvidence(3),
      pitrEvidence(backupName),
    ]);
    expect(rewoundWalCoordinates.status).toBe(1);

    for (const unprovenBackupMetadata of [
      { backup_type: 'delta' },
      {
        backup_user_data: {
          aqua_run_id: 'another-run',
          backup_kind: 'full',
          main_sha: EVIDENCE_MAIN_SHA,
        },
      },
      { backup_storage_name: 'failover' },
      { backup_start_lsn: 50_331_648 },
      { source_system_identifier: Number(EVIDENCE_SYSTEM_IDENTIFIER) },
      { backup_finish_lsn: '18446744073709551616' },
    ]) {
      const unboundBackup = evaluateEvidence([
        backupEvidence(1),
        backupEvidence(2),
        backupEvidence(3, unprovenBackupMetadata),
        pitrEvidence(backupName),
      ]);
      expect(unboundBackup.status).toBe(1);
    }

    for (const foreignAuthority of [
      {
        source_system_identifier: '7500000000000000001',
        restored_system_identifier: '7500000000000000001',
      },
      { source_image_id: `sha256:${'c'.repeat(64)}` },
      { source_postgres_dr_contract_sha256: '3'.repeat(64) },
      { walg_config_sha256: '1'.repeat(64) },
      { walg_rotation_bundle_sha256: '2'.repeat(64) },
    ]) {
      const foreignPitrChain = evaluateEvidence([
        ...backups,
        pitrEvidence(backupName, foreignAuthority),
      ]);
      expect(foreignPitrChain.status).toBe(1);
      expect(foreignPitrChain.stdout).toMatch(/requires one isolated timestamp PITR/);
    }

    const foreignMainVerification = databaseVerificationPayload();
    if (!isRecord(foreignMainVerification.release)) {
      throw new Error('Expected canonical release verification object');
    }
    foreignMainVerification.release.git_sha = foreignMainSha;
    const foreignMainPitr = evaluateEvidence([
      ...backups,
      pitrEvidence(backupName, {
        main_sha: foreignMainSha,
        source_image_revision: foreignMainSha,
        database_verification: foreignMainVerification,
        database_verification_sha256: databaseVerificationSha256(foreignMainVerification),
      }),
    ]);
    expect(foreignMainPitr.status).toBe(1);

    const preBackupWalPitr = evaluateEvidence([
      ...backups,
      pitrEvidence(backupName, {
        archive_required_wal: '000000010000000000000002',
        archived_through_wal: '000000010000000000000003',
      }),
    ]);
    expect(preBackupWalPitr.status).toBe(1);

    const firstBackupName = String(backups[0]?.backup_name);
    const pitrCompletedBeforeNewerUnrelatedBackups = pitrEvidence(firstBackupName, {
      started_at: '2026-07-16T00:11:30Z',
      completed_at: '2026-07-16T00:15:00Z',
      recovery_target_time: '2026-07-16T00:13:00Z',
      failure_time: '2026-07-16T00:14:00.000000Z',
      archive_observed_at: '2026-07-16T00:14:00.000000Z',
      source_before_sentinel_recorded_at: '2026-07-16T00:12:00.000000Z',
      restored_before_sentinel_recorded_at: '2026-07-16T00:12:00.000000Z',
      source_before_commit_fence_at: '2026-07-16T00:12:30.000000Z',
      source_after_sentinel_recorded_at: '2026-07-16T00:13:30.000000Z',
      source_after_commit_fence_at: '2026-07-16T00:13:40.000000Z',
      rpo_seconds: 120,
      rto_seconds: 210,
    });
    const matchingBackupBound = evaluateEvidence([
      ...backups,
      pitrCompletedBeforeNewerUnrelatedBackups,
    ]);
    expect(matchingBackupBound.status).toBe(0);
    expect(matchingBackupBound.stdout).toContain('"pitrRunId":"pitr-1"');

    const pitrCompletedBeforeItsBackup = pitrEvidence(backupName, {
      started_at: '2026-07-16T00:29:00Z',
      completed_at: '2026-07-16T00:30:00Z',
      recovery_target_time: '2026-07-16T00:29:30Z',
      failure_time: '2026-07-16T00:29:50.000000Z',
      archive_observed_at: '2026-07-16T00:29:50.000000Z',
      source_before_sentinel_recorded_at: '2026-07-16T00:29:10.000000Z',
      restored_before_sentinel_recorded_at: '2026-07-16T00:29:10.000000Z',
      source_before_commit_fence_at: '2026-07-16T00:29:20.000000Z',
      source_after_sentinel_recorded_at: '2026-07-16T00:29:40.000000Z',
      source_after_commit_fence_at: '2026-07-16T00:29:45.000000Z',
      rpo_seconds: 40,
      rto_seconds: 60,
    });
    expect(evaluateEvidence([...backups, pitrCompletedBeforeItsBackup]).status).toBe(1);

    for (const unproven of [
      { restored_before_sentinel_recorded_at: '2026-07-16T00:35:01.000000Z' },
      {
        source_before_sentinel_recorded_at: undefined,
        source_before_sentinel_committed_at: '2026-07-16T00:35:00.000000Z',
      },
      {
        source_after_sentinel_recorded_at: undefined,
        source_after_sentinel_committed_at: '2026-07-16T00:38:00.000000Z',
      },
      {
        restored_before_sentinel_recorded_at: undefined,
        restored_before_sentinel_committed_at: '2026-07-16T00:35:00.000000Z',
      },
      { restored_before_sentinel_recorded_lsn: '0/1000001' },
      { failure_time: undefined },
      { archive_observed_at: undefined },
      { archive_observed_at: '2026-07-16T00:39:59.000000Z' },
      { rpo_seconds: 299 },
      { before_sentinel_present: false },
      { after_sentinel_present: true },
      { wal_verified: false },
      { database_verified: false },
      { database_verification_sha256: 'd'.repeat(64) },
      { source_image_revision: 'd'.repeat(40) },
      { source_image_revision: '0'.repeat(40) },
      { source_postgres_dr_contract_sha256: '3'.repeat(64) },
      { source_wal_g_revision: 'e'.repeat(40) },
      { walg_config_sha256: 'not-a-sha256' },
      { walg_rotation_bundle_sha256: 'not-a-sha256' },
      { source_system_identifier: 'not-a-system-id' },
      { restored_system_identifier: '7500000000000000001' },
      { source_before_commit_fence_lsn: 'not-an-lsn' },
      { source_after_sentinel_recorded_lsn: 'not-an-lsn' },
      { source_after_sentinel_recorded_lsn: '0/1000000' },
      { source_after_commit_fence_lsn: '0/1000000' },
      { archive_required_wal: 'not-a-wal-segment' },
      { archive_required_wal: '000000010000000000000004' },
      { archived_through_wal: 'not-a-wal-segment' },
      { archive_wait_seconds: 301 },
      { target_read_only_rootfs: false },
      { source_before_commit_fence_at: '2026-07-16T00:37:01.000000Z' },
      { source_after_commit_fence_at: '2026-07-16T00:40:01.000000Z' },
    ]) {
      const invalid = evaluateEvidence([...backups, pitrEvidence(backupName, unproven)]);
      expect(invalid.status).toBe(1);
    }

    const malformedVerification = databaseVerificationPayload();
    malformedVerification.canonical_schemas = EVIDENCE_CANONICAL_SCHEMAS.slice(0, -1);
    const invalidVerificationShape = evaluateEvidence([
      ...backups,
      pitrEvidence(backupName, {
        database_verification: malformedVerification,
        database_verification_sha256: databaseVerificationSha256(malformedVerification),
      }),
    ]);
    expect(invalidVerificationShape.status).toBe(1);

    for (const breach of [
      { failure_time: '2026-07-16T00:40:01Z', rpo_seconds: 301 },
      { rto_seconds: 3601 },
    ]) {
      const invalid = evaluateEvidence([...backups, pitrEvidence(backupName, breach)]);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toMatch(/RPO <= 300s and RTO <= 3600s/);
      expect(invalid.stderr).toBe('');
    }
  });
});
