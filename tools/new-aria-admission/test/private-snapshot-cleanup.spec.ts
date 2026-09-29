import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PrivateRepositorySnapshot } from '../src/runtime/repository-snapshot-materializer';
import { ExecutableRunBundlePublication } from '../src/runtime/executable-run-bundle';
import {
  assertVerifiedExecutableSource,
  VerifiedExecutableSource,
} from '../src/runtime/verified-executable';

import { repositorySnapshotFixture } from './repository-snapshot-fixture';

const cleanupPaths: string[] = [];
const fixturePath = realpathSync(join(__dirname, 'fixtures/baseline-verifier-fixture.cjs'));

function replaceRootWithSentinel(root: string): {
  readonly moved: string;
  readonly sentinel: string;
} {
  const moved = `${root}-owned`;
  const sentinel = mkdtempSync(join(tmpdir(), 'new-aria-cleanup-sentinel-'));
  cleanupPaths.push(root, moved, sentinel);
  writeFileSync(join(sentinel, 'KEEP'), 'do-not-delete\n');
  chmodSync(root, 0o700);
  renameSync(root, moved);
  symlinkSync(sentinel, root, 'dir');
  return { moved, sentinel };
}

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe('private executable and repository snapshot cleanup', () => {
  it('keeps verified executable bytes in module-private state and rejects proxies', () => {
    const sha256 = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
    const source = VerifiedExecutableSource.load(fixturePath, sha256, 'runtime');

    expect(Reflect.ownKeys(source)).toEqual([]);
    expect(Reflect.get(source, 'bytes')).toBeUndefined();
    expect(Object.isFrozen(source)).toBe(true);
    expect(() => assertVerifiedExecutableSource(new Proxy(source, {}))).toThrow(/not authentic/);
  });

  it('does not traverse a replacement symlink while disposing an executable', () => {
    const sha256 = createHash('sha256').update(readFileSync(fixturePath)).digest('hex');
    const snapshot = VerifiedExecutableSource.load(fixturePath, sha256, 'runtime').materialize();
    const replacement = replaceRootWithSentinel(dirname(snapshot.executable_path));

    expect(() => snapshot.dispose()).toThrow(/path identity/);
    expect(readFileSync(join(replacement.sentinel, 'KEEP'), 'utf8')).toBe('do-not-delete\n');
    expect(existsSync(join(replacement.moved, 'executable'))).toBe(true);
  });

  it('does not traverse a replacement symlink while disposing a repository snapshot', () => {
    const snapshot = new PrivateRepositorySnapshot(repositorySnapshotFixture('a'.repeat(40)));
    const replacement = replaceRootWithSentinel(snapshot.root);

    expect(() => snapshot.dispose()).toThrow(/root changed/);
    expect(readFileSync(join(replacement.sentinel, 'KEEP'), 'utf8')).toBe('do-not-delete\n');
    expect(existsSync(join(replacement.moved, 'reviewed.txt'))).toBe(true);
  });

  it('rejects repository snapshot entries beyond the exact global roster budget', () => {
    const snapshot = new PrivateRepositorySnapshot(repositorySnapshotFixture('a'.repeat(40)));
    cleanupPaths.push(snapshot.root);
    chmodSync(snapshot.root, 0o700);
    writeFileSync(join(snapshot.root, 'foreign-a'), 'a');
    writeFileSync(join(snapshot.root, 'foreign-b'), 'b');
    chmodSync(snapshot.root, 0o500);

    expect(() => snapshot.verify()).toThrow(/entry limit/i);
  });

  it('does not traverse a replacement symlink while aborting a run bundle', () => {
    const parent = mkdtempSync(join(tmpdir(), 'new-aria-bundle-parent-'));
    cleanupPaths.push(parent);
    const bundlePath = join(parent, 'bundle');
    const publication = new ExecutableRunBundlePublication(bundlePath);
    const replacement = replaceRootWithSentinel(bundlePath);

    expect(() => publication.abort()).toThrow(/root identity/);
    expect(readFileSync(join(replacement.sentinel, 'KEEP'), 'utf8')).toBe('do-not-delete\n');
    expect(existsSync(join(replacement.moved, 'staging'))).toBe(true);
  });
});
