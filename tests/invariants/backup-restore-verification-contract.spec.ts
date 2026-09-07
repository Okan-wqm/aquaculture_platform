import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
const PITR_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/pitr-restore-production.yml');
const HASH_WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/backup-manifest-invariant.yml');
const BUNDLE_PREPARER_PATH = join(
  REPO_ROOT,
  'tools/scripts/ci/prepare-protected-runtime-bundle.sh',
);
const RUNTIME_BUNDLE_PATHS = [
  '.github/manifests/postgres-dr-contract.sha256',
  'tools/scripts/database/backup-databases.sh',
  'tools/scripts/database/database-verification.sql',
  'tools/scripts/database/evaluate-walg-evidence.mjs',
  'tools/scripts/database/materialize-walg-secrets.sh',
  'tools/scripts/database/walg-base-backup.sh',
  'tools/scripts/database/walg-pitr-restore.sh',
] as const;
const MUTABLE_RUNTIME_PATH = 'tools/scripts/database/backup-databases.sh';

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

function extractRemoteScript(workflow: string): string {
  const openingMarker = "<<'AQUA_REMOTE_SCRIPT'";
  const markerStart = workflow.indexOf(openingMarker);
  if (markerStart < 0) throw new Error('Could not find AQUA_REMOTE_SCRIPT opening marker');
  const scriptStart = workflow.indexOf('\n', markerStart) + 1;
  const scriptEnd = workflow.indexOf('\n          AQUA_REMOTE_SCRIPT', scriptStart);
  if (scriptStart === 0 || scriptEnd < scriptStart) {
    throw new Error('Could not find AQUA_REMOTE_SCRIPT closing marker');
  }
  return workflow.slice(scriptStart, scriptEnd);
}

interface RuntimeBundleFixture {
  root: string;
  preparerPath: string;
  sourceSha: string;
}

function runFixtureGit(root: string, args: readonly string[]): string {
  const result = spawnSync('git', [...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

function createRuntimeBundleFixture(): RuntimeBundleFixture {
  const root = mkdtempSync(join(tmpdir(), 'aqua-runtime-bundle-repo-'));
  const preparerPath = join(root, 'tools/scripts/ci/prepare-protected-runtime-bundle.sh');
  mkdirSync(dirname(preparerPath), { recursive: true });
  copyFileSync(BUNDLE_PREPARER_PATH, preparerPath);

  for (const path of RUNTIME_BUNDLE_PATHS) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(REPO_ROOT, path), destination);
  }
  const manifestPath = join(root, '.github/manifests/backup-script.sha256');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${RUNTIME_BUNDLE_PATHS.map((path) => `${sha256(join(REPO_ROOT, path))}  ${path}`).join(
      '\n',
    )}\n`,
    { mode: 0o600 },
  );

  runFixtureGit(root, ['init', '--quiet']);
  runFixtureGit(root, ['add', '--all']);
  runFixtureGit(root, [
    '-c',
    'user.name=Aqua Test',
    '-c',
    'user.email=aqua-test@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--quiet',
    '-m',
    'test: protected runtime fixture',
  ]);
  return { root, preparerPath, sourceSha: runFixtureGit(root, ['rev-parse', 'HEAD']) };
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

  it('uses one exported PostgreSQL snapshot and publishes only GPG-encrypted artifacts', () => {
    const backup = read(BACKUP_SCRIPT_PATH);

    expect(backup).toContain('SELECT pg_export_snapshot();');
    expect(backup).toContain('--snapshot="${SNAPSHOT_ID}"');
    expect(backup).toContain('database-verification.sql');
    expect(backup).toContain(
      'BACKUP_GPG_RECIPIENT must be an exact 40-hex primary-key fingerprint',
    );
    expect(backup).toContain('mapfile -t BACKUP_GPG_PRIMARY_FINGERPRINTS');
    expect(backup).toContain('--list-keys "${BACKUP_GPG_RECIPIENT}"');
    expect(backup).toContain('[ "${#BACKUP_GPG_PRIMARY_FINGERPRINTS[@]}" -ne 1 ]');
    expect(backup).toContain('--recipient "${BACKUP_GPG_RECIPIENT}"');
    expect(backup).toContain('--output "${DATABASE_PAYLOAD}.gpg"');
    expect(backup).toContain('VERIFICATION_UPLOAD_PATH="${DATABASE_PAYLOAD}.gpg"');
    expect(backup).toContain('VERIFICATION_KEY="${REMOTE_KEY}.verification.json.gpg"');
    expect(backup).toContain('VERIFICATION_SHA256=$(sha256sum "${VERIFICATION_UPLOAD_PATH}"');
    expect(backup).toContain('VERIFICATION_PAYLOAD_SHA256=$(sha256sum "${DATABASE_PAYLOAD}"');
    expect(backup).toContain('verification_sha256=${VERIFICATION_SHA256}');
    expect(backup).toContain('verification_payload_sha256=${VERIFICATION_PAYLOAD_SHA256}');
    expect(backup).toContain('payload_sha256=${VERIFICATION_PAYLOAD_SHA256}');
    expect(backup).toContain('verification_key=${VERIFICATION_KEY}');
    expect(backup).toContain('dump_sha256=${UPLOAD_SHA256}');
    expect(backup).not.toContain('--local-user');
  });

  it('fails restore closed on unsafe database names, parity mismatch, or RTO breach', () => {
    const restore = read(RESTORE_SCRIPT_PATH);

    expect(restore).toMatch(/MAX_RESTORE_SECONDS="\$\{MAX_RESTORE_SECONDS:-3600\}"/);
    expect(restore).toContain('if [ "${MAX_RESTORE_SECONDS}" -gt 3600 ]; then');
    expect(restore).toContain('database-verification.sql');
    expect(restore).toContain('.verification.json.gpg');
    expect(restore).toContain('com.aqua-saas.restore.role');
    expect(restore).toContain('isolated-drill');
    expect(restore).not.toContain('I_UNDERSTAND_DRILL_AGAINST_LIVE_CONTAINER');
    expect(restore).toContain('dropdb --if-exists --force "${TARGET_DB}"');
    expect(restore).toContain('createdb "${TARGET_DB}"');
    expect(restore).toContain('SELECT timescaledb_pre_restore();');
    expect(restore).toContain('SELECT timescaledb_post_restore();');
    expect(restore).toContain('cmp -s "${EXPECTED_DATABASE_PAYLOAD}" "${ACTUAL_DATABASE_PAYLOAD}"');
    expect(restore).toContain('RESTORE_ELAPSED_SECONDS');
    expect(restore).toContain(
      'TARGET_CONTAINER_ID=$(docker container inspect --format \'{{.Id}}\' "${TARGET_CONTAINER}"',
    );
    expect(restore).toContain('[[ ! "${TARGET_CONTAINER_ID}" =~ ^[0-9a-f]{64}$ ]]');
    expect(restore).toContain('target_authority_sha256()');
    expect(restore).toContain('assert_restore_target_authority');
    expect(restore).toContain('[ "${current_name_id}" != "${TARGET_CONTAINER_ID}" ]');
    expect(restore).toContain('[ "${current_authority}" != "${TARGET_AUTHORITY_SHA256}" ]');
    expect(restore).toContain('"${TARGET_CONTAINER_ID}" \\\n  dropdb');
    expect(restore).not.toMatch(/docker exec -i[\s\S]{0,100}"\$\{TARGET_CONTAINER\}"/);
    expect(restore).not.toContain('DROP DATABASE IF EXISTS ${TARGET_DB}');
    expect(restore).not.toContain('CREATE DATABASE ${TARGET_DB}');
  });

  it('binds both ciphertexts reciprocally and selects one exact primary secret key', () => {
    const restore = read(RESTORE_SCRIPT_PATH);

    expect(restore).toContain(
      'LOCAL_VERIFICATION_ENVELOPE="${TMP}/$(basename "${BACKUP_KEY}").verification.json.gpg"',
    );
    expect(restore).toContain('[ "${VERIFICATION_KEY}" != "${BACKUP_KEY}.verification.json.gpg" ]');
    expect(restore).toContain('[ "${SIDE_SHA256}" != "${REMOTE_VERIFICATION_SHA256}" ]');
    expect(restore).toContain(
      '[ "${SIDE_PAYLOAD_SHA256}" != "${REMOTE_VERIFICATION_PAYLOAD_SHA256}" ]',
    );
    expect(restore).toContain('[ "${SIDE_DUMP_SHA256}" != "${REMOTE_SHA256}" ]');
    expect(restore).toContain(
      'LOCAL_VERIFICATION_SHA256=$(sha256sum "${LOCAL_VERIFICATION_ENVELOPE}"',
    );
    expect(restore).toContain('BACKUP_GPG_KEY must be an exact 40-hex primary-key fingerprint');
    expect(restore).toContain('mapfile -t BACKUP_GPG_SECRET_FINGERPRINTS');
    expect(restore).toContain('--list-secret-keys "${BACKUP_GPG_KEY}"');
    expect(restore).toContain('[ "${#BACKUP_GPG_SECRET_FINGERPRINTS[@]}" -ne 1 ]');
    expect(restore.match(/--try-secret-key "\$\{BACKUP_GPG_KEY\}"/g)).toHaveLength(2);
    expect(restore).toContain('--output "${EXPECTED_DATABASE_PAYLOAD}"');
    expect(restore).toContain('"${REMOTE_VERIFICATION_PAYLOAD_SHA256}" ]; then');
    expect(restore).not.toContain('--local-user');
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
      '.github/manifests/postgres-dr-contract.sha256',
      'tools/scripts/database/backup-databases.sh',
      'tools/scripts/database/database-verification.sql',
      'tools/scripts/database/evaluate-walg-evidence.mjs',
      'tools/scripts/database/materialize-walg-secrets.sh',
      'tools/scripts/database/walg-base-backup.sh',
      'tools/scripts/database/walg-pitr-restore.sh',
    ];

    expect([...entries.keys()].sort()).toEqual([...requiredPaths].sort());
    for (const path of requiredPaths) {
      expect(entries.get(path)).toBe(sha256(join(REPO_ROOT, path)));
    }

    const runtimeWorkflow = read(BACKUP_WORKFLOW_PATH);
    expect(runtimeWorkflow).toContain(
      'ACTUAL_PATHS=$(awk \'$1 !~ /^#/ && NF == 2 {print $2}\' "${MANIFEST}" | sort)',
    );
    expect(runtimeWorkflow).toContain('bash tools/scripts/ci/prepare-protected-runtime-bundle.sh');
    expect(runtimeWorkflow).toContain('EXPECTED_ARCHIVE_PATHS=$(printf');
    expect(runtimeWorkflow).toContain('RUNTIME_ROOT=$(mktemp -d /tmp/aqua-backup-runtime.XXXXXX)');
    expect(runtimeWorkflow).toContain('sha256sum --check "${MANIFEST}"');
    expect(runtimeWorkflow).toContain('[ -L "${TRUSTED_PATH}" ]');
    expect(runtimeWorkflow).toContain('bash tools/scripts/ci/run-protected-ssh.sh');
    expect(runtimeWorkflow).toContain('DROPLET_SSH_FINGERPRINT');
    expect(runtimeWorkflow).toContain(
      'REMOTE_EVIDENCE_B64: ${{ steps.remote_backup.outputs.evidence_b64 }}',
    );
    expect(runtimeWorkflow).not.toMatch(
      /\bgit(?:\s+-C\s+(?:"[^"]+"|\S+))?\s+(?:checkout|restore|switch|reset)\b/,
    );
    expect(runtimeWorkflow).not.toContain('appleboy/ssh-action@');
    expect(runtimeWorkflow).not.toContain('capture_stdout:');
    expect(runtimeWorkflow).not.toContain('steps.remote_backup.outputs.stdout');

    const invariantWorkflow = read(HASH_WORKFLOW_PATH);
    for (const path of requiredPaths) {
      expect(invariantWorkflow).toContain(`- '${path}'`);
    }
    expect(invariantWorkflow).toContain(
      "- 'tools/scripts/database/generate-database-verification-sql.ts'",
    );
    expect(invariantWorkflow).toContain("- 'tools/scripts/ci/prepare-protected-runtime-bundle.sh'");
    expect(invariantWorkflow).toContain('[ -L "$TRUSTED_PATH" ]');
    expect(invariantWorkflow).toContain('sha256sum --check "$MANIFEST"');
  });

  it('transfers the protected runner bundle without reading target-host Git state', () => {
    const backupWorkflow = read(BACKUP_WORKFLOW_PATH);
    const pitrWorkflow = read(PITR_WORKFLOW_PATH);

    for (const workflow of [backupWorkflow, pitrWorkflow]) {
      expect(workflow).toContain('bash tools/scripts/ci/prepare-protected-runtime-bundle.sh');
      expect(workflow).toContain('SOURCE_SHA="${GITHUB_SHA}"');
      expect(workflow).toContain('RUNTIME_BUNDLE_SHA256');
      expect(workflow).toContain('base64 -w0 "${RUNTIME_BUNDLE_PATH}"');
      expect(workflow).toContain('base64 --decode > "${RUNTIME_BUNDLE_TAR}"');
      expect(workflow).toContain('EXPECTED_ARCHIVE_PATHS=$(printf');
      expect(workflow).toContain('ARCHIVE_MEMBER_TYPES=$(tar -tvf');
      expect(workflow).toContain('tar --extract --no-same-owner --no-same-permissions');
      const remoteScript = extractRemoteScript(workflow);
      expect(remoteScript).not.toMatch(
        /(^|[^A-Za-z0-9_])(?:\/[A-Za-z0-9._/-]+\/)?git(?:-[A-Za-z0-9._-]+)?(?=$|[^A-Za-z0-9_])/i,
      );
      expect(remoteScript).not.toMatch(/(^|[\s/'"])\.git(?:[\s/'"]|$)/i);
    }
  });

  it('builds an exact eight-file archive from the protected commit instead of the worktree', () => {
    const fixture = createRuntimeBundleFixture();
    const outputPath = join(fixture.root, 'runtime-bundle.tar');
    const protectedContent = read(join(fixture.root, MUTABLE_RUNTIME_PATH));
    try {
      writeFileSync(join(fixture.root, MUTABLE_RUNTIME_PATH), 'mutable worktree bytes\n');
      const prepared = spawnSync('bash', [fixture.preparerPath], {
        cwd: fixture.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          OUTPUT_PATH: outputPath,
          SOURCE_SHA: fixture.sourceSha,
        },
      });
      expect(prepared.status).toBe(0);
      expect(prepared.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);

      const archive = spawnSync('tar', ['-tf', outputPath], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      });
      expect(archive.status).toBe(0);
      expect(archive.stdout.trim().split('\n').sort()).toEqual([
        '.github/manifests/backup-script.sha256',
        ...[...RUNTIME_BUNDLE_PATHS].sort(),
      ]);
      const archivedContent = spawnSync('tar', ['-xOf', outputPath, MUTABLE_RUNTIME_PATH], {
        cwd: fixture.root,
        encoding: 'utf8',
      });
      expect(archivedContent.status).toBe(0);
      expect(archivedContent.stdout).toBe(protectedContent);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects a symlink entry in the protected runtime commit tree', () => {
    const fixture = createRuntimeBundleFixture();
    const outputPath = join(fixture.root, 'unsafe-runtime-bundle.tar');
    try {
      const symlinkPath = join(fixture.root, MUTABLE_RUNTIME_PATH);
      unlinkSync(symlinkPath);
      symlinkSync('/etc/passwd', symlinkPath);
      runFixtureGit(fixture.root, ['add', '--all']);
      runFixtureGit(fixture.root, [
        '-c',
        'user.name=Aqua Test',
        '-c',
        'user.email=aqua-test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'test: unsafe symlink fixture',
      ]);
      const unsafeSha = runFixtureGit(fixture.root, ['rev-parse', 'HEAD']);
      const prepared = spawnSync('bash', [fixture.preparerPath], {
        cwd: fixture.root,
        encoding: 'utf8',
        env: { ...process.env, OUTPUT_PATH: outputPath, SOURCE_SHA: unsafeSha },
      });
      expect(prepared.status).not.toBe(0);
      expect(`${prepared.stdout}${prepared.stderr}`).toContain(
        'protected runtime tree entry is not a regular file',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

/**
 * ADR-0009 — WAL-G is the SOLE backup and restore authority.
 *
 * admin-api carried a second one until 2026-09-05: an in-process pg_dump
 * subsystem with three ledger tables, three crons and a restore executor that
 * rejected unconditionally. Two authorities for one invariant meant the UI
 * asserted a recovery capability the platform did not have. Nothing outside
 * `tools/scripts/database/` (and the DR workflows that call it) may spawn
 * `pg_dump`/`pg_restore` or schedule a backup job.
 */
describe('single backup authority (ADR-0009)', () => {
  const SOURCE_ROOTS = ['apps', 'libs', 'platform/libs', 'scripts'];
  const SPAWN_RE =
    /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\([^)]*pg_(?:dump|restore)/;
  const BACKUP_CRON_RE = /@(?:Cron|Interval|Timeout)\([^)]*\)\s*(?:async\s+)?\w*[Bb]ackup\w*\s*\(/;

  function walkSources(dir: string, out: string[]): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        entry.name === 'node_modules' ||
        entry.name === '.archive' ||
        entry.name === '__tests__' ||
        entry.name === 'dist'
      )
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkSources(full, out);
      else if (/\.(?:ts|mjs|js)$/.test(entry.name) && !/\.(?:spec|test)\.ts$/.test(entry.name))
        out.push(full);
    }
    return out;
  }

  it('no service, library or script outside tools/scripts/database spawns pg_dump or pg_restore', () => {
    const offenders: string[] = [];
    for (const root of SOURCE_ROOTS) {
      for (const file of walkSources(join(REPO_ROOT, root), [])) {
        if (SPAWN_RE.test(read(file))) offenders.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Nest service schedules a backup job', () => {
    const offenders: string[] = [];
    for (const file of walkSources(join(REPO_ROOT, 'apps'), [])) {
      if (BACKUP_CRON_RE.test(read(file))) offenders.push(file.slice(REPO_ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it('admin-api keeps no backup ledger of its own — the drop evidence is a WAL-G recovery point', () => {
    const schemaManager = read(
      join(REPO_ROOT, 'libs/backend-common/src/database/schema-manager.service.ts'),
    );
    for (const retired of ['schema_backups', 'schema_restores', 'retired_schema_backups']) {
      expect(schemaManager).not.toMatch(new RegExp(`'${retired}'`));
    }
    expect(schemaManager).toContain("'retired_backup_ledger'");
    expect(schemaManager).toContain("readonly authority: 'wal-g'");
  });
});
