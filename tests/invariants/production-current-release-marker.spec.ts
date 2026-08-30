import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CONTROL_PLANE = join(REPO_ROOT, 'scripts/deploy/production-host-control-plane.sh');
const DEPLOY_PATHS = join(REPO_ROOT, 'scripts/deploy/deploy-paths.sh');

function runMarkerCommand(
  root: string,
  operation: 'publish' | 'read' | 'verify',
  sha: string,
  releaseId: string,
  manifestHash: string,
): ReturnType<typeof spawnSync> {
  const releaseRoot = join(root, 'control', 'releases');
  const functionName =
    operation === 'publish'
      ? 'publish_deploy_current_release'
      : operation === 'read'
        ? 'read_deploy_current_release'
        : 'assert_deploy_current_release';
  const command = [
    `source ${JSON.stringify(CONTROL_PLANE)}`,
    'aqua_control_plane_lock_acquire exclusive 5',
    `source ${JSON.stringify(DEPLOY_PATHS)}`,
    operation === 'read'
      ? functionName
      : `${functionName} ${JSON.stringify(sha)} ${JSON.stringify(
          releaseId,
        )} ${JSON.stringify(manifestHash)}`,
  ].join('; ');
  return spawnSync('/bin/bash', ['-c', command], {
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: root,
      LC_ALL: 'C',
      NODE_ENV: 'test',
      AQUA_CONTROL_PLANE_TEST_ROOT: join(root, 'control'),
      DEPLOY_STATE_ROOT: releaseRoot,
      PRODUCTION_HOST_MAIN_SHA: sha,
    },
  });
}

describe('production current-release proof', () => {
  it('creates or narrowly converges the persistent environment file under the exclusive lock', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-production-env-file-'));
    const controlRoot = join(root, 'control');
    const run = (caseName: string): ReturnType<typeof spawnSync> => {
      const directory = join(controlRoot, caseName);
      const envFile = join(directory, '.env');
      const command = [
        `source ${JSON.stringify(CONTROL_PLANE)}`,
        'aqua_control_plane_lock_acquire exclusive 5',
        `source ${JSON.stringify(DEPLOY_PATHS)}`,
        `prepare_deploy_env_file ${JSON.stringify(envFile)}`,
      ].join('; ');
      return spawnSync('/bin/bash', ['-c', command], {
        encoding: 'utf8',
        env: {
          PATH: '/usr/bin:/bin',
          HOME: root,
          LC_ALL: 'C',
          NODE_ENV: 'test',
          AQUA_CONTROL_PLANE_TEST_ROOT: controlRoot,
        },
      });
    };
    try {
      mkdirSync(controlRoot, { mode: 0o700 });

      const absentDirectory = join(controlRoot, 'absent');
      mkdirSync(absentDirectory, { mode: 0o700 });
      expect(run('absent').status).toBe(0);
      expect(statSync(join(absentDirectory, '.env')).mode & 0o777).toBe(0o600);

      const legacyDirectory = join(controlRoot, 'legacy');
      mkdirSync(legacyDirectory, { mode: 0o700 });
      const legacy = join(legacyDirectory, '.env');
      writeFileSync(legacy, 'SECRET=legacy\n', { mode: 0o644 });
      chmodSync(legacy, 0o644);
      expect(run('legacy').status).toBe(0);
      expect(statSync(legacy).mode & 0o777).toBe(0o600);
      expect(readFileSync(legacy, 'utf8')).toBe('SECRET=legacy\n');

      const wrongModeDirectory = join(controlRoot, 'wrong-mode');
      mkdirSync(wrongModeDirectory, { mode: 0o700 });
      const wrongMode = join(wrongModeDirectory, '.env');
      writeFileSync(wrongMode, 'SECRET=blocked\n', { mode: 0o640 });
      chmodSync(wrongMode, 0o640);
      expect(run('wrong-mode').status).not.toBe(0);
      expect(statSync(wrongMode).mode & 0o777).toBe(0o640);

      const symlinkDirectory = join(controlRoot, 'symlink');
      mkdirSync(symlinkDirectory, { mode: 0o700 });
      const symlinkTarget = join(symlinkDirectory, 'target');
      writeFileSync(symlinkTarget, 'SECRET=target\n', { mode: 0o600 });
      symlinkSync(symlinkTarget, join(symlinkDirectory, '.env'));
      expect(run('symlink').status).not.toBe(0);
      expect(readFileSync(symlinkTarget, 'utf8')).toBe('SECRET=target\n');

      const hardlinkDirectory = join(controlRoot, 'hardlink');
      mkdirSync(hardlinkDirectory, { mode: 0o700 });
      const hardlinkTarget = join(hardlinkDirectory, 'target');
      writeFileSync(hardlinkTarget, 'SECRET=linked\n', { mode: 0o600 });
      linkSync(hardlinkTarget, join(hardlinkDirectory, '.env'));
      expect(run('hardlink').status).not.toBe(0);
      expect(statSync(hardlinkTarget).nlink).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('atomically binds a promoted release to its exact image manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'aqua-current-release-'));
    const sha = 'a'.repeat(40);
    const releaseId = `${sha}-20260718T010203Z`;
    const releaseRoot = join(root, 'control', 'releases');
    const releaseDirectory = join(releaseRoot, releaseId);
    const manifest = Buffer.from(
      `gateway-api\tghcr.io/okan-wqm/aquaculture_platform/gateway-api\tsha256:${'b'.repeat(64)}\n`,
    );
    const manifestHash = createHash('sha256').update(manifest).digest('hex');
    try {
      mkdirSync(releaseDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(join(releaseDirectory, 'image-digests.tsv'), manifest, { mode: 0o600 });

      const published = runMarkerCommand(root, 'publish', sha, releaseId, manifestHash);
      expect(published.status).toBe(0);
      expect(published.stderr).toBe('');

      const markerPath = join(root, 'control', 'current-release.json');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
      expect(marker).toMatchObject({
        schema_version: 1,
        main_sha: sha,
        release_id: releaseId,
        image_digest_manifest_sha256: manifestHash,
      });
      expect(marker['promoted_at']).toMatch(/^2026-|^20[0-9]{2}-/);

      const verified = runMarkerCommand(root, 'verify', sha, releaseId, manifestHash);
      expect(verified.status).toBe(0);

      const read = runMarkerCommand(root, 'read', sha, releaseId, manifestHash);
      expect(read.status).toBe(0);
      expect(read.stderr).toBe('');
      expect(read.stdout).toBe(`${JSON.stringify(marker, Object.keys(marker).sort())}\n`);

      writeFileSync(join(releaseDirectory, 'image-digests.tsv'), Buffer.from('tampered\n'));
      const tamperedManifest = runMarkerCommand(root, 'read', sha, releaseId, manifestHash);
      expect(tamperedManifest.status).not.toBe(0);
      expect(tamperedManifest.stderr).toContain('image manifest hash mismatch');
      writeFileSync(join(releaseDirectory, 'image-digests.tsv'), manifest);

      const staleReleaseId = `${sha}-20260718T020304Z`;
      const staleDirectory = join(releaseRoot, staleReleaseId);
      mkdirSync(staleDirectory, { mode: 0o700 });
      writeFileSync(join(staleDirectory, 'image-digests.tsv'), manifest, { mode: 0o600 });
      const stale = runMarkerCommand(root, 'verify', sha, staleReleaseId, manifestHash);
      expect(stale.status).not.toBe(0);
      expect(stale.stderr).toContain('does not match the requested release');

      chmodSync(markerPath, 0o600);
      const unsafeRead = runMarkerCommand(root, 'read', sha, releaseId, manifestHash);
      expect(unsafeRead.status).not.toBe(0);
      expect(unsafeRead.stderr).toContain('exact mode rejected');
      const unsafeReplacement = runMarkerCommand(root, 'publish', sha, releaseId, manifestHash);
      expect(unsafeReplacement.status).not.toBe(0);
      expect(unsafeReplacement.stderr).toContain('exact mode rejected');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
