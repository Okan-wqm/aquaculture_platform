import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import {
  AnchoredFilesystemError,
  closeAnchoredDirectoryChain,
  assertStablePathKindCurrent,
  assertStableRegularFileCurrent,
  observeStablePathKind,
  observeStableRegularFile,
  openAnchoredDirectoryChain,
  openHermeticExecutableAuthority,
} from './anchored-filesystem';

const fixtureRoots: string[] = [];

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

void describe('descriptor-anchored filesystem authority', () => {
  void it('keeps directory identity stable across unrelated child entry churn', () => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-directory-'));
    fixtureRoots.push(root);
    const nested = join(root, 'nested');
    mkdirSync(nested);
    const sibling = join(root, 'transient-sibling');
    let churnObserved = false;

    const chain = openAnchoredDirectoryChain(nested, 'directory churn fixture', (componentPath) => {
      if (componentPath !== root) return;
      mkdirSync(sibling);
      churnObserved = true;
    });
    try {
      assert.equal(churnObserved, true);
      assert.equal(chain.path, nested);
      rmSync(sibling, { recursive: true });
    } finally {
      closeAnchoredDirectoryChain(chain);
    }
  });

  void it('ignores unrelated siblings while rejecting same-size target replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-file-'));
    fixtureRoots.push(root);
    const target = join(root, 'target.txt');
    writeFileSync(target, 'first\n');
    const observed = observeStableRegularFile(target, 1024, 'fixture target');

    writeFileSync(join(root, 'unrelated.txt'), 'sibling\n');
    assert.doesNotThrow(() => assertStableRegularFileCurrent(observed, 1024, 'fixture target'));

    const replacement = join(root, 'replacement.txt');
    writeFileSync(replacement, 'other\n');
    renameSync(replacement, target);
    assert.throws(
      () => assertStableRegularFileCurrent(observed, 1024, 'fixture target'),
      (error: unknown) =>
        error instanceof AnchoredFilesystemError &&
        error.code === 'STABLE_REGULAR_FILE_CHANGED' &&
        error.path === target,
    );
  });

  void it('pins absent path authority to the exact child without sibling-history false positives', () => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-absence-'));
    fixtureRoots.push(root);
    const target = join(root, 'missing.txt');
    const observed = observeStablePathKind(target, 'missing fixture');
    assert.equal(observed.kind, 'MISSING');
    writeFileSync(target, 'present\n');
    assert.throws(
      () => assertStablePathKindCurrent(observed, 'missing fixture'),
      (error: unknown) =>
        error instanceof AnchoredFilesystemError &&
        error.code === 'STABLE_PATH_KIND_CHANGED' &&
        error.path === target,
    );
    rmSync(target);
    const current = observeStablePathKind(target, 'missing fixture');
    const sibling = join(root, 'unrelated.txt');
    writeFileSync(sibling, 'transient\n');
    rmSync(sibling);
    assert.doesNotThrow(() => assertStablePathKindCurrent(current, 'missing fixture'));

    const nested = join(root, 'absent-parent', 'missing.txt');
    const nestedObservation = observeStablePathKind(nested, 'nested missing fixture');
    assert.equal(nestedObservation.kind, 'MISSING');
    assert.equal(nestedObservation.anchorPath, join(root, 'absent-parent'));
    assert.equal(nestedObservation.anchorKind, 'MISSING');
  });

  void it('rejects an ancestor directory replaced by a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-parent-'));
    const outside = mkdtempSync(join(tmpdir(), 'anchored-outside-'));
    fixtureRoots.push(root, outside);
    const nested = join(root, 'nested');
    writeFileSync(join(root, 'placeholder'), 'root\n');
    mkdirSync(nested);
    writeFileSync(join(nested, 'target.txt'), 'governed\n');
    writeFileSync(join(outside, 'target.txt'), 'governed\n');
    const observed = observeStableRegularFile(join(nested, 'target.txt'), 1024, 'ancestor fixture');
    renameSync(nested, `${nested}-original`);
    symlinkSync(outside, nested, 'dir');
    assert.throws(
      () => assertStableRegularFileCurrent(observed, 1024, 'ancestor fixture'),
      (error: unknown) =>
        error instanceof AnchoredFilesystemError &&
        error.code === 'SYMLINK_COMPONENT' &&
        error.path === nested,
    );
  });

  void it('descriptor-binds executable bytes and rejects writable parent authorities', () => {
    const trustedRoot = mkdtempSync('/root/hermetic-executable-');
    fixtureRoots.push(trustedRoot);
    const executablePath = join(trustedRoot, 'true');
    copyFileSync('/usr/bin/true', executablePath);
    chmodSync(executablePath, 0o755);
    const authority = openHermeticExecutableAuthority({
      path: executablePath,
      label: 'fixture executable',
      versionArgs: ['--version'],
      versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
      maximumBytes: 1024 * 1024,
      maximumVersionBytes: 4096,
    });
    assert.match(authority.attestation.binarySha256, /^[0-9a-f]{64}$/);
    const invocation = spawnSync(authority.descriptorPath, ['--version'], {
      argv0: authority.argv0,
      encoding: 'utf8',
    });
    assert.equal(invocation.status, 0);

    const replacementPath = join(trustedRoot, 'replacement');
    writeFileSync(replacementPath, readFileSync(executablePath));
    chmodSync(replacementPath, 0o755);
    renameSync(replacementPath, executablePath);
    assert.throws(() => authority.assertCurrent(), /descriptor-bound attestation/);
    authority.close();

    const writableRoot = mkdtempSync(join(tmpdir(), 'writable-executable-'));
    fixtureRoots.push(writableRoot);
    const writableExecutable = join(writableRoot, 'true');
    copyFileSync('/usr/bin/true', writableExecutable);
    chmodSync(writableExecutable, 0o755);
    assert.throws(
      () =>
        openHermeticExecutableAuthority({
          path: writableExecutable,
          label: 'writable fixture executable',
          versionArgs: ['--version'],
          versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
          maximumBytes: 1024 * 1024,
          maximumVersionBytes: 4096,
        }),
      /parent is not root-owned and group\/world non-writable/,
    );
  });

  void it('preserves the canonical executable argv0 through a descriptor-bound probe', () => {
    const authority = openHermeticExecutableAuthority({
      path: realpathSync('/usr/bin/flock'),
      label: 'util-linux flock fixture',
      versionArgs: ['--version'],
      versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
      maximumBytes: 1024 * 1024,
      maximumVersionBytes: 4096,
    });
    try {
      assert.equal(authority.argv0, 'flock');
      assert.match(authority.attestation.version, /^flock from util-linux \d+\.\d+/);
      const invocation = spawnSync(authority.descriptorPath, ['--version'], {
        argv0: authority.argv0,
        encoding: 'utf8',
        env: { LANG: 'C', LC_ALL: 'C' },
      });
      assert.equal(invocation.status, 0);
      assert.match(invocation.stdout, /^flock from util-linux \d+\.\d+/);
    } finally {
      authority.close();
    }
  });
});
