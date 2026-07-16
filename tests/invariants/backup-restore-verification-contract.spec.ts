import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  GLOBAL_SENTINELS,
  TENANT_SENTINELS,
  renderDatabaseVerificationSql,
} from '../../tools/scripts/database/generate-database-verification-sql';

const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKUP_SCRIPT_PATH = join(REPO_ROOT, 'tools/scripts/database/backup-databases.sh');
const RESTORE_SCRIPT_PATH = join(REPO_ROOT, 'tools/scripts/database/restore-databases.sh');
const VERIFICATION_SQL_PATH = join(REPO_ROOT, 'tools/scripts/database/database-verification.sql');
const HASH_MANIFEST_PATH = join(REPO_ROOT, '.github/manifests/backup-script.sha256');
const BACKUP_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/backup-production.yml');
const HASH_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/backup-manifest-invariant.yml');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function manifestEntries(manifest: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.match(/^([0-9a-f]{64})\s{2}([^\s].*)$/);
    if (match?.[1] && match[2]) entries.set(match[2], match[1]);
  }
  return entries;
}

describe('backup and isolated restore verification contract', () => {
  it('keeps the checked-in SQL generated from the platform topology SSoT', () => {
    expect(read(VERIFICATION_SQL_PATH)).toBe(renderDatabaseVerificationSql());
    expect(GLOBAL_SENTINELS).toEqual([
      { schema: 'auth', table: 'tenants' },
      { schema: 'auth', table: 'users' },
      { schema: 'billing', table: 'subscriptions' },
    ]);
    expect(TENANT_SENTINELS.map((sentinel) => sentinel.sourceSchema)).toEqual([
      'farm',
      'sensor',
      'hr',
      'messaging',
      'hydroponics',
      'alert',
      'ai',
    ]);
  });

  it('uses one exported PostgreSQL snapshot for pg_dump and the verification sidecar', () => {
    const backup = read(BACKUP_SCRIPT_PATH);

    expect(backup).toContain('SELECT pg_export_snapshot();');
    expect(backup).toContain('--snapshot="${SNAPSHOT_ID}"');
    expect(backup).toContain('database-verification.sql');
    expect(backup).toContain('.verification.json');
    expect(backup).toContain('verification_sha256=${VERIFICATION_SHA256}');
    expect(backup).toContain('verification_key=${VERIFICATION_KEY}');
    expect(backup).toContain('dump_sha256=${UPLOAD_SHA256}');
  });

  it('fails restore closed on unsafe database names, parity mismatch, or RTO breach', () => {
    const restore = read(RESTORE_SCRIPT_PATH);

    expect(restore).toMatch(/MAX_RESTORE_SECONDS="\$\{MAX_RESTORE_SECONDS:-3600\}"/);
    expect(restore).toContain('if [ "${MAX_RESTORE_SECONDS}" -gt 3600 ]; then');
    expect(restore).toContain('database-verification.sql');
    expect(restore).toContain('.verification.json');
    expect(restore).toContain('com.aqua-saas.restore.role');
    expect(restore).toContain('isolated-drill');
    expect(restore).not.toContain('I_UNDERSTAND_DRILL_AGAINST_LIVE_CONTAINER');
    expect(restore).toContain('dropdb --if-exists --force "${TARGET_DB}"');
    expect(restore).toContain('createdb "${TARGET_DB}"');
    expect(restore).toContain('SELECT timescaledb_pre_restore();');
    expect(restore).toContain('SELECT timescaledb_post_restore();');
    expect(restore).toContain('cmp -s "${EXPECTED_DATABASE_PAYLOAD}" "${ACTUAL_DATABASE_PAYLOAD}"');
    expect(restore).toContain('RESTORE_ELAPSED_SECONDS');
    expect(restore).not.toContain('DROP DATABASE IF EXISTS ${TARGET_DB}');
    expect(restore).not.toContain('CREATE DATABASE ${TARGET_DB}');
  });

  it('refuses an operator-supplied RTO threshold above 60 minutes', () => {
    const result = spawnSync('bash', [RESTORE_SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TARGET_CONTAINER: 'aqua-postgres-drill',
        TARGET_DB: 'aquaculture_drill',
        SPACES_BUCKET: 'test-bucket',
        AWS_ACCESS_KEY_ID: 'test-access-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        BACKUP_KEY: 'pg-backups/test.dump',
        MAX_RESTORE_SECONDS: '3601',
      },
    });

    expect(result.status).toBe(4);
    expect(`${result.stdout}${result.stderr}`).toMatch(/cannot exceed 3600 seconds/i);
  });

  it.each([
    'aquaculture',
    'aquaculture;DROP DATABASE postgres',
    'drill"; SELECT pg_sleep(10); --',
    'UPPERCASE_DB',
  ])('rejects TARGET_DB=%p before any external command can run', (targetDb) => {
    const result = spawnSync('bash', [RESTORE_SCRIPT_PATH], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        TARGET_CONTAINER: 'aqua-postgres-drill',
        TARGET_DB: targetDb,
        SPACES_BUCKET: 'test-bucket',
        AWS_ACCESS_KEY_ID: 'test-access-key',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
        BACKUP_KEY: 'pg-backups/test.dump',
      },
    });

    expect(result.status).toBe(4);
    expect(`${result.stdout}${result.stderr}`).toMatch(
      /refusing to DROP protected database|TARGET_DB must match/,
    );
  });

  it('hash-pins every file executed or consumed by the production backup job', () => {
    const manifest = read(HASH_MANIFEST_PATH);
    const entries = manifestEntries(manifest);
    const requiredPaths = [
      'tools/scripts/database/backup-databases.sh',
      'tools/scripts/database/database-verification.sql',
    ];

    expect([...entries.keys()].sort()).toEqual([...requiredPaths].sort());
    for (const path of requiredPaths) {
      expect(entries.get(path)).toBe(sha256(join(REPO_ROOT, path)));
    }

    const runtimeWorkflow = read(BACKUP_WORKFLOW_PATH);
    expect(runtimeWorkflow).toContain(
      'ACTUAL_PATHS=$(awk \'$1 !~ /^#/ && NF == 2 {print $2}\' "$MANIFEST" | sort)',
    );
    expect(runtimeWorkflow).toContain('while read -r EXPECTED_SHA TRUSTED_PATH; do');
    expect(runtimeWorkflow).toContain('git checkout -f origin/main -- "${TRUSTED_PATH}"');
    expect(runtimeWorkflow).toContain('sha256sum --check "$MANIFEST"');

    const invariantWorkflow = read(HASH_WORKFLOW_PATH);
    expect(invariantWorkflow).toContain("- 'tools/scripts/database/database-verification.sql'");
    expect(invariantWorkflow).toContain(
      "- 'tools/scripts/database/generate-database-verification-sql.ts'",
    );
    expect(invariantWorkflow).toContain('sha256sum --check "$MANIFEST"');
  });
});
