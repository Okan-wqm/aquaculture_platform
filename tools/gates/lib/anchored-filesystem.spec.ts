import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs, {
  chmodSync,
  closeSync,
  copyFileSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, it } from 'node:test';

import {
  AnchoredFilesystemError,
  HermeticExecutableExecutionTimeoutError,
  assertStableDirectoryContentGenerationCurrent,
  assertStableDirectoryCurrent,
  closeAnchoredDirectoryChain,
  assertStablePathKindCurrent,
  assertStableRegularFileCurrent,
  defineHermeticExecutableExecutionPolicyV1,
  observeStableDirectory,
  observeStablePathKind,
  observeStableRegularFile,
  openAnchoredDirectoryChain,
  openHermeticExecutableAuthority,
} from './anchored-filesystem';
import { testOnlyOpenHermeticExecutableAuthorityForOwnedFixture } from './anchored-filesystem.fixture';
import { errorFromUnknown } from './error-cause';

const fixtureRoots: string[] = [];
const EXECUTABLE_TEST_POLICY_V1 = defineHermeticExecutableExecutionPolicyV1({
  schemaVersion: 1,
  commandDeadlineMs: 5_000,
  timeoutSignal: 'SIGKILL',
});

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

  void it('attempts every directory descriptor cleanup after multiple close failures', () => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-cleanup-'));
    fixtureRoots.push(root);
    const nested = join(root, 'first', 'second');
    mkdirSync(nested, { recursive: true });
    const chain = openAnchoredDirectoryChain(nested, 'directory cleanup fixture');
    assert.ok(chain.components.length >= 3);
    const preclosed = chain.components.slice(0, 2);
    for (const component of preclosed) closeSync(component.descriptor);

    assert.throws(
      () => closeAnchoredDirectoryChain(chain),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
    );
    for (const component of chain.components) {
      assert.throws(
        () => fstatSync(component.descriptor),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EBADF',
      );
    }
  });

  void it('retains root construction and close failures before descriptor enrollment', (context) => {
    const constructionFailure = new Error('injected root descriptor construction failure');
    const closeFailure = new Error('injected root descriptor close failure');
    const actualCloseSync = fs.closeSync;
    let failedDescriptor: number | undefined;

    context.mock.method(fs, 'fstatSync', (descriptor: number) => {
      failedDescriptor = descriptor;
      throw constructionFailure;
    });
    context.mock.method(fs, 'closeSync', (descriptor: number): void => {
      if (descriptor === failedDescriptor) throw closeFailure;
      actualCloseSync(descriptor);
    });

    try {
      assert.throws(
        () => openAnchoredDirectoryChain('/', 'root construction fixture'),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.equal(error.errors[0], constructionFailure);
          assert.equal(error.errors[1], closeFailure);
          return true;
        },
      );
    } finally {
      if (failedDescriptor !== undefined) actualCloseSync(failedDescriptor);
      context.mock.restoreAll();
    }
  });

  void it('retains child construction and close failures before descriptor enrollment', (context) => {
    const constructionFailure = new Error('injected child descriptor construction failure');
    const closeFailure = new Error('injected child descriptor close failure');
    const actualFstatSync = fs.fstatSync;
    const actualCloseSync = fs.closeSync;
    let fstatCalls = 0;
    let failedDescriptor: number | undefined;

    context.mock.method(fs, 'fstatSync', (descriptor: number) => {
      fstatCalls += 1;
      if (fstatCalls === 2) {
        failedDescriptor = descriptor;
        throw constructionFailure;
      }
      return actualFstatSync(descriptor, { bigint: true });
    });
    context.mock.method(fs, 'closeSync', (descriptor: number): void => {
      if (descriptor === failedDescriptor) throw closeFailure;
      actualCloseSync(descriptor);
    });

    try {
      assert.throws(
        () => openAnchoredDirectoryChain('/tmp', 'child construction fixture'),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.equal(error.errors.length, 2);
          assert.equal(error.errors[0], constructionFailure);
          assert.equal(error.errors[1], closeFailure);
          return true;
        },
      );
    } finally {
      if (failedDescriptor !== undefined) actualCloseSync(failedDescriptor);
      context.mock.restoreAll();
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

  void it('rejects a FIFO regular-file candidate without blocking the observer process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-fifo-'));
    fixtureRoots.push(root);
    const fifoPath = join(root, 'candidate');
    const mkfifo = spawnSync('/usr/bin/mkfifo', [fifoPath], { encoding: 'utf8' });
    assert.equal(mkfifo.status, 0, mkfifo.stderr);
    const authorityPath = resolve(__dirname, 'anchored-filesystem.ts');
    const worker = [
      `const { observeStableRegularFile } = require(${JSON.stringify(authorityPath)});`,
      `process.stdout.write('READY\\n');`,
      `process.stdin.once('data', () => {`,
      `  try { observeStableRegularFile(${JSON.stringify(fifoPath)}, 1024, 'FIFO fixture'); process.exitCode = 2; }`,
      `  catch (error) { if (!(error instanceof Error) || !/expected filesystem topology changed/.test(error.message)) process.exitCode = 3; }`,
      `});`,
    ].join('\n');
    const observation = spawn(
      process.execPath,
      ['--require', 'ts-node/register/transpile-only', '--eval', worker],
      {
        cwd: __dirname,
        env: { ...process.env, TS_NODE_PROJECT: resolve(__dirname, '..', 'tsconfig.json') },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    assert.ok(
      observation.stdin !== null && observation.stdout !== null && observation.stderr !== null,
    );
    let stdout = '';
    let stderr = '';
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolveReadyPromise, rejectReadyPromise) => {
      resolveReady = resolveReadyPromise;
      rejectReady = rejectReadyPromise;
    });
    observation.stdout.setEncoding('utf8');
    observation.stderr.setEncoding('utf8');
    observation.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes('READY\n')) resolveReady();
    });
    observation.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    let spawnError: Error | undefined;
    observation.once('error', (error) => {
      spawnError = error;
      rejectReady(error);
    });
    const completion = new Promise<readonly [number | null, NodeJS.Signals | null]>((resolve) => {
      observation.once('close', (status, signal) => resolve([status, signal]));
    });
    const bounded = <T>(promise: Promise<T>, durationMs: number, label: string): Promise<T> =>
      new Promise<T>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error(label)), durationMs);
        void promise.then(
          (value) => {
            clearTimeout(timer);
            resolvePromise(value);
          },
          (error: unknown) => {
            clearTimeout(timer);
            rejectPromise(errorFromUnknown(label, error));
          },
        );
      });
    try {
      await bounded(ready, 10_000, 'FIFO observer child did not reach its loaded-module barrier');
      observation.stdin.end('\n');
      const [status, signal] = await bounded(
        completion,
        2_000,
        'FIFO regular-file observation blocked after its loaded-module barrier',
      );
      assert.equal(spawnError, undefined);
      assert.equal(signal, null);
      assert.equal(status, 0, stderr);
    } finally {
      if (observation.exitCode === null && observation.signalCode === null) {
        observation.kill('SIGKILL');
      }
      await completion;
    }
  });

  void it('normalizes expected file deletion and type swap as typed currentness drift', () => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-file-currentness-'));
    fixtureRoots.push(root);
    const deletedTarget = join(root, 'deleted.txt');
    writeFileSync(deletedTarget, 'governed\n');
    const deletedObservation = observeStableRegularFile(
      deletedTarget,
      1024,
      'deleted file fixture',
    );
    rmSync(deletedTarget);
    assert.throws(
      () => assertStableRegularFileCurrent(deletedObservation, 1024, 'deleted file fixture'),
      (error: unknown) =>
        error instanceof AnchoredFilesystemError &&
        error.code === 'STABLE_REGULAR_FILE_CHANGED' &&
        error.path === deletedTarget,
    );

    const swappedTarget = join(root, 'swapped.txt');
    writeFileSync(swappedTarget, 'governed\n');
    const swappedObservation = observeStableRegularFile(
      swappedTarget,
      1024,
      'type-swapped file fixture',
    );
    rmSync(swappedTarget);
    mkdirSync(swappedTarget);
    assert.throws(
      () => assertStableRegularFileCurrent(swappedObservation, 1024, 'type-swapped file fixture'),
      (error: unknown) =>
        error instanceof AnchoredFilesystemError &&
        error.code === 'STABLE_REGULAR_FILE_CHANGED' &&
        error.path === swappedTarget,
    );
  });

  void it('normalizes expected directory deletion and type swap for both directory fences', () => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-directory-currentness-'));
    fixtureRoots.push(root);
    const deletedDirectory = join(root, 'deleted');
    mkdirSync(deletedDirectory);
    const deletedObservation = observeStableDirectory(
      deletedDirectory,
      'deleted directory fixture',
      true,
    );
    rmSync(deletedDirectory, { recursive: true });
    assert.throws(
      () => assertStableDirectoryCurrent(deletedObservation, 'deleted directory fixture'),
      (error: unknown) =>
        error instanceof AnchoredFilesystemError &&
        error.code === 'STABLE_DIRECTORY_CHANGED' &&
        error.path === deletedDirectory,
    );

    const swappedDirectory = join(root, 'swapped');
    mkdirSync(swappedDirectory);
    const swappedObservation = observeStableDirectory(
      swappedDirectory,
      'type-swapped directory fixture',
      false,
    );
    rmSync(swappedDirectory, { recursive: true });
    writeFileSync(swappedDirectory, 'not a directory\n');
    assert.throws(
      () =>
        assertStableDirectoryContentGenerationCurrent(
          swappedObservation,
          'type-swapped directory fixture',
        ),
      (error: unknown) =>
        error instanceof AnchoredFilesystemError &&
        error.code === 'STABLE_DIRECTORY_CONTENT_CHANGED' &&
        error.path === swappedDirectory,
    );
  });

  void it('preserves operational filesystem errors during a currentness check', (context) => {
    const root = mkdtempSync(join(tmpdir(), 'anchored-operational-error-'));
    fixtureRoots.push(root);
    const target = join(root, 'target.txt');
    writeFileSync(target, 'governed\n');
    const observed = observeStableRegularFile(target, 1024, 'operational error fixture');
    const operationalFailure = Object.assign(new Error('injected filesystem I/O failure'), {
      code: 'EIO',
    });
    context.mock.method(fs, 'lstatSync', () => {
      throw operationalFailure;
    });
    assert.throws(
      () => assertStableRegularFileCurrent(observed, 1024, 'operational error fixture'),
      (error: unknown) => error === operationalFailure,
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
    const trustedRoot = mkdtempSync(join(realpathSync(tmpdir()), 'hermetic-executable-'));
    fixtureRoots.push(trustedRoot);
    const executablePath = join(trustedRoot, 'true');
    copyFileSync('/usr/bin/true', executablePath);
    chmodSync(executablePath, 0o755);
    const authority = testOnlyOpenHermeticExecutableAuthorityForOwnedFixture(
      {
        path: executablePath,
        label: 'fixture executable',
        versionArgs: ['--version'],
        versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
        executionPolicy: EXECUTABLE_TEST_POLICY_V1,
        maximumBytes: 1024 * 1024,
        maximumVersionBytes: 4096,
      },
      trustedRoot,
    );
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

    const writableRoot = mkdtempSync(join(realpathSync(tmpdir()), 'writable-executable-'));
    fixtureRoots.push(writableRoot);
    const writableExecutable = join(writableRoot, 'true');
    copyFileSync('/usr/bin/true', writableExecutable);
    chmodSync(writableExecutable, 0o755);
    chmodSync(writableRoot, 0o777);
    assert.throws(
      () =>
        testOnlyOpenHermeticExecutableAuthorityForOwnedFixture(
          {
            path: writableExecutable,
            label: 'writable fixture executable',
            versionArgs: ['--version'],
            versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
            executionPolicy: EXECUTABLE_TEST_POLICY_V1,
            maximumBytes: 1024 * 1024,
            maximumVersionBytes: 4096,
          },
          writableRoot,
        ),
      /mode-0700 OS-temp child/,
    );
  });

  void it('closes every retained descriptor when final executable currentness fails', () => {
    const trustedRoot = mkdtempSync(join(realpathSync(tmpdir()), 'hermetic-construction-failure-'));
    fixtureRoots.push(trustedRoot);
    const executablePath = join(trustedRoot, 'mutable-version-probe');
    const replacementPath = join(trustedRoot, 'replacement-version-probe');
    copyFileSync('/usr/bin/env', executablePath);
    copyFileSync('/usr/bin/true', replacementPath);
    chmodSync(executablePath, 0o755);
    chmodSync(replacementPath, 0o755);
    const descriptorsBefore = readdirSync('/proc/self/fd').length;

    assert.throws(
      () =>
        testOnlyOpenHermeticExecutableAuthorityForOwnedFixture(
          {
            path: executablePath,
            label: 'self-replacing fixture executable',
            versionArgs: ['/usr/bin/mv', replacementPath, executablePath],
            versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
            executionPolicy: EXECUTABLE_TEST_POLICY_V1,
            maximumBytes: 1024 * 1024,
            maximumVersionBytes: 4096,
          },
          trustedRoot,
        ),
      /descriptor-bound attestation/,
    );
    assert.equal(readdirSync('/proc/self/fd').length, descriptorsBefore);
  });

  void it('preserves the canonical executable argv0 through a descriptor-bound probe', () => {
    const authority = openHermeticExecutableAuthority({
      path: realpathSync('/usr/bin/flock'),
      label: 'util-linux flock fixture',
      versionArgs: ['--version'],
      versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
      executionPolicy: EXECUTABLE_TEST_POLICY_V1,
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

  void it('requires one immutable version policy and returns a typed fail-closed timeout', () => {
    const mutablePolicy = {
      schemaVersion: 1 as const,
      commandDeadlineMs: 100,
      timeoutSignal: 'SIGKILL' as const,
    };
    assert.throws(
      () =>
        openHermeticExecutableAuthority({
          path: realpathSync('/usr/bin/true'),
          label: 'mutable-policy fixture',
          versionArgs: ['--version'],
          versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
          executionPolicy: mutablePolicy,
          maximumBytes: 1024 * 1024,
          maximumVersionBytes: 4096,
        }),
      /execution policy must be immutable/,
    );

    const deadlinePolicy = defineHermeticExecutableExecutionPolicyV1({
      schemaVersion: 1,
      commandDeadlineMs: 100,
      timeoutSignal: 'SIGKILL',
    });

    assert.throws(
      () =>
        openHermeticExecutableAuthority({
          path: realpathSync('/usr/bin/sleep'),
          label: 'blocking version fixture',
          versionArgs: ['10'],
          versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
          executionPolicy: deadlinePolicy,
          maximumBytes: 1024 * 1024,
          maximumVersionBytes: 4096,
        }),
      (error: unknown) =>
        error instanceof HermeticExecutableExecutionTimeoutError &&
        error.code === 'HERMETIC_EXECUTABLE_EXECUTION_TIMEOUT' &&
        error.phase === 'VERSION_PROBE' &&
        error.commandDeadlineMs === deadlinePolicy.commandDeadlineMs &&
        error.timeoutSignal === deadlinePolicy.timeoutSignal,
    );

    let deadlineReads = 0;
    const accessorPolicy = Object.freeze({
      schemaVersion: 1 as const,
      get commandDeadlineMs(): number {
        deadlineReads += 1;
        return deadlineReads === 1 ? 50 : 1_000;
      },
      timeoutSignal: 'SIGKILL' as const,
    });
    assert.throws(
      () =>
        openHermeticExecutableAuthority({
          path: realpathSync('/usr/bin/sleep'),
          label: 'accessor-policy fixture',
          versionArgs: ['0.25'],
          versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
          executionPolicy: accessorPolicy,
          maximumBytes: 1024 * 1024,
          maximumVersionBytes: 4096,
        }),
      (error: unknown) =>
        error instanceof HermeticExecutableExecutionTimeoutError && error.commandDeadlineMs === 50,
    );
    assert.equal(deadlineReads, 1);
  });

  void it('propagates one absolute operation deadline into a real version-probe child', () => {
    const trustedRoot = mkdtempSync(join(realpathSync(tmpdir()), 'hermetic-absolute-deadline-'));
    fixtureRoots.push(trustedRoot);
    const executablePath = join(trustedRoot, 'sleep');
    copyFileSync('/usr/bin/sleep', executablePath);
    chmodSync(executablePath, 0o755);
    const startedAt = performance.now();
    assert.throws(
      () =>
        testOnlyOpenHermeticExecutableAuthorityForOwnedFixture(
          {
            path: executablePath,
            label: 'absolute-deadline fixture executable',
            versionArgs: ['1'],
            versionEnvironment: { LANG: 'C', LC_ALL: 'C' },
            executionPolicy: EXECUTABLE_TEST_POLICY_V1,
            maximumBytes: 1024 * 1024,
            maximumVersionBytes: 4096,
          },
          trustedRoot,
          startedAt + 50,
        ),
      (error: unknown) =>
        error instanceof HermeticExecutableExecutionTimeoutError &&
        error.phase === 'VERSION_PROBE' &&
        error.commandDeadlineMs <= 50,
    );
    assert.ok(performance.now() - startedAt < 1_000);
  });
});
