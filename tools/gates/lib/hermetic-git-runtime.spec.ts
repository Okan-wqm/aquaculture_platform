import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { defineHermeticExecutableExecutionPolicyV1 } from './anchored-filesystem';
import {
  computeCanonicalGitWorktreeEvidence,
  createHermeticGitRuntime,
  HERMETIC_GIT_EXECUTION_MODES_V1,
  HERMETIC_GIT_EXECUTION_POLICY_V1,
  HERMETIC_GIT_RUNTIME,
  HermeticGitExecutionTimeoutError,
  HermeticGitSynchronousBudgetError,
  InventoryInspectionError,
  runWithHermeticGitExecutionBudget,
  runWithHermeticGitExecutionDeadline,
  testOnlyCloseHermeticGitDescriptors,
  testOnlyFingerprintHermeticGitRegularFile,
} from './hermetic-git-runtime';

const fixtureRoots: string[] = [];

async function openFifoWriterAfterReader(path: string): Promise<number> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      return openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENXIO') throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for the Hermetic Git FIFO reader: ${path}`);
      }
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    }
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: root,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: '/usr/bin:/bin',
      TZ: 'UTC',
    },
  }).trim();
}

function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1'): string {
  const root = mkdtempSync(join(tmpdir(), 'hermetic-git-runtime-'));
  fixtureRoots.push(root);
  execFileSync('/usr/bin/git', [
    'init',
    '--quiet',
    '--initial-branch=main',
    ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : []),
    root,
  ]);
  writeFileSync(join(root, '.gitignore'), '.env\n*.key\n', 'utf8');
  mkdirSync(join(root, 'tracked'), { recursive: true });
  writeFileSync(join(root, 'tracked', 'payload.txt'), 'governed\n', 'utf8');
  git(root, 'add', '.');
  git(
    root,
    '-c',
    'user.name=Hermetic Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'fixture',
  );
  return root;
}

function linkedFixture(): { readonly root: string; readonly linked: string } {
  const root = fixture();
  const linked = `${root}-linked`;
  fixtureRoots.push(linked);
  git(root, 'worktree', 'add', '--quiet', '-b', 'linked-fixture', linked);
  return { root, linked };
}

function injectPersistedFsmonitorIndexBit(root: string): void {
  const indexPath = join(root, '.git', 'index');
  const index = readFileSync(indexPath);
  const entryStart = 12;
  const flagsOffset = entryStart + 60;
  const flags = index.readUInt16BE(flagsOffset);
  assert.equal(flags & 0x4000, 0, 'fixture index entry unexpectedly has extended flags');
  const pathEnd = index.indexOf(0, entryStart + 62);
  assert.notEqual(pathEnd, -1, 'fixture index entry has no path terminator');
  const oldEntryEnd = entryStart + Math.ceil((pathEnd + 1 - entryStart) / 8) * 8;
  const fixed = Buffer.from(index.subarray(entryStart, entryStart + 62));
  fixed.writeUInt16BE(flags | 0x4000, 60);
  const extendedFlags = Buffer.alloc(2);
  extendedFlags.writeUInt16BE(0x20, 0);
  const path = Buffer.from(index.subarray(entryStart + 62, pathEnd + 1));
  const unpadded = Buffer.concat([fixed, extendedFlags, path]);
  const padding = Buffer.alloc(Math.ceil(unpadded.length / 8) * 8 - unpadded.length);
  const body = Buffer.concat([
    index.subarray(0, entryStart),
    unpadded,
    padding,
    index.subarray(oldEntryEnd, index.length - 20),
  ]);
  writeFileSync(indexPath, Buffer.concat([body, createHash('sha1').update(body).digest()]));
}

async function withProcessEnvironment(
  overrides: Readonly<Record<string, string>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

void describe('HermeticGitRuntime', () => {
  void it('enforces one non-relaxable deadline and reaps buffered and streamed children', async () => {
    assert.equal('close' in HERMETIC_GIT_RUNTIME, false);
    assert.equal(HERMETIC_GIT_RUNTIME.executionModes, HERMETIC_GIT_EXECUTION_MODES_V1);
    assert.equal(HERMETIC_GIT_EXECUTION_MODES_V1.synchronousBuffered.contextualBudget, 'FORBIDDEN');
    assert.equal(
      HERMETIC_GIT_EXECUTION_MODES_V1.asynchronous.interruptSemantics,
      'LIVE_ALL_INHERITED_SIGNALS',
    );
    const relaxedPolicy = defineHermeticExecutableExecutionPolicyV1({
      schemaVersion: 1,
      commandDeadlineMs: HERMETIC_GIT_EXECUTION_POLICY_V1.commandDeadlineMs + 1,
      timeoutSignal: 'SIGKILL',
    });
    assert.throws(
      () => createHermeticGitRuntime(relaxedPolicy),
      /cannot relax the production command deadline/,
    );

    let deadlineReads = 0;
    const accessorPolicy = Object.freeze({
      schemaVersion: 1 as const,
      get commandDeadlineMs(): number {
        deadlineReads += 1;
        return 250;
      },
      timeoutSignal: 'SIGKILL' as const,
    });
    const accessorRuntime = createHermeticGitRuntime(accessorPolicy);
    assert.equal(deadlineReads, 1);
    assert.equal(accessorRuntime.executionPolicy.commandDeadlineMs, 250);
    assert.equal(deadlineReads, 1);
    assert.equal(
      Object.getOwnPropertyDescriptor(accessorRuntime.executionPolicy, 'commandDeadlineMs')?.get,
      undefined,
    );
    assert.equal(accessorRuntime.attestation.binaryPath, '/usr/bin/git');
    accessorRuntime.close();
    assert.throws(() => accessorRuntime.runText('/', ['--version']), /runtime is closed/);

    const root = fixture();
    const blockedInput = join(root, 'blocked-input');
    execFileSync('/usr/bin/mkfifo', [blockedInput]);
    const executionPolicy = defineHermeticExecutableExecutionPolicyV1({
      schemaVersion: 1,
      commandDeadlineMs: 250,
      timeoutSignal: 'SIGKILL',
    });
    const runtime = createHermeticGitRuntime(executionPolicy);
    const blockedCommand = ['hash-object', '--', 'blocked-input'] as const;

    assert.throws(
      () => runtime.runBuffer(root, blockedCommand),
      (error: unknown) =>
        error instanceof HermeticGitExecutionTimeoutError &&
        error.code === 'HERMETIC_GIT_EXECUTION_TIMEOUT' &&
        error.executionMode === 'BUFFERED' &&
        error.commandDeadlineMs === executionPolicy.commandDeadlineMs &&
        error.timeoutSignal === executionPolicy.timeoutSignal &&
        error.deadlineSource === 'EXECUTION_POLICY',
    );
    await assert.rejects(
      runtime.consumeStdout(root, blockedCommand, () => undefined),
      (error: unknown) =>
        error instanceof HermeticGitExecutionTimeoutError &&
        error.code === 'HERMETIC_GIT_EXECUTION_TIMEOUT' &&
        error.executionMode === 'STREAMED' &&
        error.commandDeadlineMs === executionPolicy.commandDeadlineMs &&
        error.timeoutSignal === executionPolicy.timeoutSignal &&
        error.deadlineSource === 'EXECUTION_POLICY',
    );

    const aggregateBudgetController = new AbortController();
    assert.throws(
      () =>
        runWithHermeticGitExecutionBudget(100, aggregateBudgetController.signal, () => {
          runtime.runBuffer(root, blockedCommand);
        }),
      (error: unknown) =>
        error instanceof HermeticGitSynchronousBudgetError &&
        error.code === 'HERMETIC_GIT_SYNCHRONOUS_BUDGET_FORBIDDEN',
    );
    assert.equal(runtime.runText(root, ['rev-parse', '--verify', 'HEAD']).status, 0);

    const outerController = new AbortController();
    const innerController = new AbortController();
    await assert.rejects(
      runWithHermeticGitExecutionBudget(100, outerController.signal, () =>
        runWithHermeticGitExecutionBudget(1_000, innerController.signal, async () => {
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 60));
          await runtime.runBufferAsync(root, blockedCommand);
        }),
      ),
      (error: unknown) =>
        error instanceof HermeticGitExecutionTimeoutError &&
        error.commandDeadlineMs <= 50 &&
        error.deadlineSource === 'CONTEXT_BUDGET',
    );
    const outerAbort = new Error('outer budget aborted');
    outerController.abort(outerAbort);
    await assert.rejects(
      runWithHermeticGitExecutionBudget(100, outerController.signal, () =>
        runWithHermeticGitExecutionBudget(1_000, innerController.signal, () =>
          runtime.runTextAsync(root, ['rev-parse', '--verify', 'HEAD']),
        ),
      ),
      (error: unknown) => error === outerAbort,
    );

    let releaseConsumer = (): void => undefined;
    const lateConsumerFailure = new Error('late consumer failure');
    const consumerGate = new Promise<void>((_resolveConsumer, rejectConsumer) => {
      releaseConsumer = () => rejectConsumer(lateConsumerFailure);
    });
    await assert.rejects(
      runtime.consumeStdout(root, ['rev-parse', '--verify', 'HEAD'], () => consumerGate),
      (error: unknown) =>
        error instanceof HermeticGitExecutionTimeoutError && error.executionMode === 'STREAMED',
    );
    releaseConsumer();
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));

    assert.equal(runtime.runText(root, ['rev-parse', '--verify', 'HEAD']).status, 0);
    runtime.close();
  });

  void it('live-aborts a running FIFO child from every inherited signal and reaps it', async () => {
    const root = fixture();
    const runtime = createHermeticGitRuntime(
      defineHermeticExecutableExecutionPolicyV1({
        schemaVersion: 1,
        commandDeadlineMs: 5_000,
        timeoutSignal: 'SIGKILL',
      }),
    );
    for (const abortScope of ['OUTER', 'INNER'] as const) {
      const fifoName = `live-abort-${abortScope.toLowerCase()}`;
      const fifoPath = join(root, fifoName);
      execFileSync('/usr/bin/mkfifo', [fifoPath]);
      const outer = new AbortController();
      const inner = new AbortController();
      const abortFailure = new Error(`${abortScope.toLowerCase()} live abort`);
      const execution = runWithHermeticGitExecutionBudget(4_000, outer.signal, () =>
        runWithHermeticGitExecutionBudget(4_000, inner.signal, () =>
          runtime.consumeStdout(root, ['hash-object', '--', fifoName], () => undefined),
        ),
      );
      const rejection = assert.rejects(execution, (error: unknown) => error === abortFailure);
      const writer = await openFifoWriterAfterReader(fifoPath);
      const interruptedAt = Date.now();
      (abortScope === 'OUTER' ? outer : inner).abort(abortFailure);
      await rejection;
      assert.ok(Date.now() - interruptedAt < 1_000);
      closeSync(writer);
      assert.throws(
        () => openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
      );
    }

    const deadlineFifo = join(root, 'deadline-drain');
    execFileSync('/usr/bin/mkfifo', [deadlineFifo]);
    const deadlineFailure = new Error('coordinator deadline');
    let deadlineSignal: AbortSignal | undefined;
    const deadlineExecution = runWithHermeticGitExecutionDeadline(
      250,
      deadlineFailure,
      (signal) => {
        deadlineSignal = signal;
        return runtime.consumeStdout(
          root,
          ['hash-object', '--', 'deadline-drain'],
          () => undefined,
        );
      },
    );
    const deadlineRejection = assert.rejects(
      deadlineExecution,
      (error: unknown) => error === deadlineFailure,
    );
    const deadlineWriter = await openFifoWriterAfterReader(deadlineFifo);
    await deadlineRejection;
    assert.equal(deadlineSignal?.aborted, true);
    assert.equal(deadlineSignal?.reason, deadlineFailure);
    closeSync(deadlineWriter);
    assert.throws(
      () => openSync(deadlineFifo, constants.O_WRONLY | constants.O_NONBLOCK),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
    );

    const nestedDeadlineFifo = join(root, 'nested-deadline-owner');
    execFileSync('/usr/bin/mkfifo', [nestedDeadlineFifo]);
    const outerDeadlineFailure = new Error('outer coordinator deadline');
    const innerDeadlineFailure = new Error('inner coordinator deadline');
    const nestedDeadlineExecution = runWithHermeticGitExecutionDeadline(
      250,
      outerDeadlineFailure,
      () =>
        runWithHermeticGitExecutionDeadline(2_000, innerDeadlineFailure, () =>
          runtime.consumeStdout(
            root,
            ['hash-object', '--', 'nested-deadline-owner'],
            () => undefined,
          ),
        ),
    );
    const nestedDeadlineRejection = assert.rejects(
      nestedDeadlineExecution,
      (error: unknown) => error === outerDeadlineFailure,
    );
    const nestedDeadlineWriter = await openFifoWriterAfterReader(nestedDeadlineFifo);
    await nestedDeadlineRejection;
    closeSync(nestedDeadlineWriter);
    assert.throws(
      () => openSync(nestedDeadlineFifo, constants.O_WRONLY | constants.O_NONBLOCK),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
    );

    const executionPolicyFifo = join(root, 'execution-policy-deadline');
    execFileSync('/usr/bin/mkfifo', [executionPolicyFifo]);
    const shortPolicyRuntime = createHermeticGitRuntime(
      defineHermeticExecutableExecutionPolicyV1({
        schemaVersion: 1,
        commandDeadlineMs: 75,
        timeoutSignal: 'SIGKILL',
      }),
    );
    const laterCoordinatorFailure = new Error('later coordinator deadline');
    const executionPolicyExecution = runWithHermeticGitExecutionDeadline(
      1_000,
      laterCoordinatorFailure,
      () =>
        shortPolicyRuntime.consumeStdout(
          root,
          ['hash-object', '--', 'execution-policy-deadline'],
          () => undefined,
        ),
    );
    const executionPolicyRejection = assert.rejects(
      executionPolicyExecution,
      (error: unknown) =>
        error instanceof HermeticGitExecutionTimeoutError &&
        error.deadlineSource === 'EXECUTION_POLICY' &&
        error !== laterCoordinatorFailure,
    );
    const executionPolicyWriter = await openFifoWriterAfterReader(executionPolicyFifo);
    await executionPolicyRejection;
    closeSync(executionPolicyWriter);
    assert.throws(
      () => openSync(executionPolicyFifo, constants.O_WRONLY | constants.O_NONBLOCK),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
    );
    shortPolicyRuntime.close();
    runtime.close();
  });

  void it('shares one async buffered kernel for stdin, limits, and live execution', async () => {
    const root = fixture();
    const runtime = createHermeticGitRuntime(
      defineHermeticExecutableExecutionPolicyV1({
        schemaVersion: 1,
        commandDeadlineMs: 2_000,
        timeoutSignal: 'SIGKILL',
      }),
    );
    const unhandledRejections: unknown[] = [];
    const observeUnhandled = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', observeUnhandled);
    try {
      const hashed = await runtime.runBufferAsync(
        root,
        ['hash-object', '--stdin'],
        [0],
        Buffer.from('async buffered input\n'),
        1_024,
      );
      assert.match(hashed.stdout.toString('ascii').trim(), /^[0-9a-f]{40}$/);
      await assert.rejects(
        runtime.runBufferAsync(root, ['rev-parse', '--verify', 'HEAD'], [0], undefined, 1),
        /stdout exceeds its 1-byte limit/,
      );
      const consumerFailure = new Error('injected streamed consumer failure');
      await assert.rejects(
        runtime.consumeStdout(root, ['rev-parse', '--verify', 'HEAD'], () => {
          throw consumerFailure;
        }),
        (error: unknown) => error === consumerFailure,
      );
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      assert.deepEqual(unhandledRejections, []);
    } finally {
      process.off('unhandledRejection', observeUnhandled);
    }
    runtime.close();
  });

  void it('attempts every descriptor close and preserves action plus cleanup failures', async () => {
    const root = fixture();
    const descriptors = ['first', 'middle', 'last'].map((name) => {
      const path = join(root, `${name}.fd`);
      writeFileSync(path, name, 'utf8');
      return openSync(path, constants.O_RDONLY);
    });
    const first = descriptors[0];
    const middle = descriptors[1];
    const last = descriptors[2];
    assert.ok(first !== undefined && middle !== undefined && last !== undefined);
    closeSync(first);
    closeSync(last);
    assert.throws(
      () => testOnlyCloseHermeticGitDescriptors(descriptors),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
    );
    for (const descriptor of descriptors) {
      assert.throws(
        () => fstatSync(descriptor),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EBADF',
      );
    }

    const fingerprintPath = join(root, 'fingerprint-cleanup-fault');
    writeFileSync(fingerprintPath, 'before\n', 'utf8');
    const staleObservation = lstatSync(fingerprintPath, { bigint: true });
    writeFileSync(fingerprintPath, 'after generation with different bytes\n', 'utf8');
    const cleanupFailure = new Error('injected fingerprint close failure');
    await assert.rejects(
      testOnlyFingerprintHermeticGitRegularFile(
        fingerprintPath,
        staleObservation,
        async (handle) => {
          await handle.close();
          throw cleanupFailure;
        },
      ),
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.errors[0] instanceof InventoryInspectionError &&
        error.errors[1] === cleanupFailure,
    );
  });

  void it('attests one absolute Git binary and ignores PATH/HOME/XDG/system/alternate env', async () => {
    const root = fixture();
    const maliciousRoot = mkdtempSync(join(tmpdir(), 'malicious-git-env-'));
    fixtureRoots.push(maliciousRoot);
    const fakeBin = join(maliciousRoot, 'bin');
    const fakeGit = join(fakeBin, 'git');
    const invocationSentinel = join(maliciousRoot, 'fake-git-ran');
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeGit, `#!/bin/sh\nprintf invoked > ${invocationSentinel}\nexit 97\n`, 'utf8');
    chmodSync(fakeGit, 0o755);
    const home = join(maliciousRoot, 'home');
    const xdg = join(maliciousRoot, 'xdg');
    mkdirSync(join(xdg, 'git'), { recursive: true });
    mkdirSync(home, { recursive: true });
    const excludes = join(maliciousRoot, 'global-excludes');
    writeFileSync(excludes, 'visible.txt\n', 'utf8');
    writeFileSync(join(home, '.gitconfig'), `[core]\nexcludesFile = ${excludes}\n`, 'utf8');
    writeFileSync(join(xdg, 'git', 'config'), `[core]\nexcludesFile = ${excludes}\n`, 'utf8');
    const systemConfig = join(maliciousRoot, 'system.gitconfig');
    writeFileSync(systemConfig, `[core]\nexcludesFile = ${excludes}\n`, 'utf8');
    const alternateObjects = join(maliciousRoot, 'objects');
    mkdirSync(alternateObjects);
    writeFileSync(join(root, 'visible.txt'), 'must remain visible\n', 'utf8');

    await withProcessEnvironment(
      {
        GIT_ALTERNATE_OBJECT_DIRECTORIES: alternateObjects,
        GIT_CONFIG_SYSTEM: systemConfig,
        GIT_DIR: join(maliciousRoot, 'not-the-repository'),
        HOME: home,
        LD_PRELOAD: join(maliciousRoot, 'not-a-library.so'),
        PATH: `${fakeBin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: xdg,
      },
      async () => {
        const evidence = await computeCanonicalGitWorktreeEvidence(root);
        assert.equal(evidence.dirty, true);
        assert.equal(HERMETIC_GIT_RUNTIME.attestation.binaryPath, '/usr/bin/git');
        assert.match(HERMETIC_GIT_RUNTIME.attestation.binarySha256, /^[0-9a-f]{64}$/);
      },
    );
    assert.equal(readFileSync(join(root, 'visible.txt'), 'utf8'), 'must remain visible\n');
    assert.throws(() => readFileSync(invocationSentinel), /ENOENT/);
  });

  void it('makes mutable info/exclude ineffective while preserving .gitignore semantics', async () => {
    const root = fixture();
    writeFileSync(join(root, 'evidence.txt'), 'visible\n', 'utf8');
    const before = await computeCanonicalGitWorktreeEvidence(root);
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'evidence.txt\n', 'utf8');
    const after = await computeCanonicalGitWorktreeEvidence(root);
    assert.deepEqual(after, before);

    writeFileSync(join(root, '.env'), 'ignored secret\n', 'utf8');
    assert.deepEqual(await computeCanonicalGitWorktreeEvidence(root), before);
  });

  void it('binds staged and unstaged tracked bytes without mutating repository state', async () => {
    const root = fixture();
    const trackedPath = join(root, 'tracked', 'payload.txt');
    const clean = await computeCanonicalGitWorktreeEvidence(root);
    writeFileSync(trackedPath, 'unstaged bytes\n', 'utf8');
    const statusBefore = git(root, 'status', '--porcelain=v1', '-z');
    const unstaged = await computeCanonicalGitWorktreeEvidence(root);
    const statusAfter = git(root, 'status', '--porcelain=v1', '-z');
    git(root, 'add', 'tracked/payload.txt');
    const staged = await computeCanonicalGitWorktreeEvidence(root);

    assert.notEqual(unstaged.contentSha256, clean.contentSha256);
    assert.notEqual(staged.contentSha256, unstaged.contentSha256);
    assert.equal(statusAfter, statusBefore);
  });

  void it('binds untracked bytes and executable mode to one canonical content identity', async () => {
    const root = fixture();
    const untrackedPath = join(root, 'untracked.bin');
    writeFileSync(untrackedPath, Buffer.from([0x00, 0x10, 0x00]), { mode: 0o644 });
    const first = await computeCanonicalGitWorktreeEvidence(root);
    writeFileSync(untrackedPath, Buffer.from([0x00, 0x11, 0x00]));
    const bytesChanged = await computeCanonicalGitWorktreeEvidence(root);
    chmodSync(untrackedPath, 0o755);
    const modeChanged = await computeCanonicalGitWorktreeEvidence(root);

    assert.notEqual(bytesChanged.contentSha256, first.contentSha256);
    assert.notEqual(modeChanged.contentSha256, bytesChanged.contentSha256);
  });

  void it('streams large untracked evidence and observes mutations without whole-file buffering', async () => {
    const root = fixture();
    const largeBinaryPath = join(root, 'large-binary-evidence.bin');
    writeFileSync(largeBinaryPath, Buffer.alloc(0));
    truncateSync(largeBinaryPath, 8 * 1024 * 1024);
    const first = await computeCanonicalGitWorktreeEvidence(root);
    writeFileSync(largeBinaryPath, Buffer.from([0x00, 0xff, 0x80, 0x00]), { flag: 'r+' });
    const changed = await computeCanonicalGitWorktreeEvidence(root);

    assert.notEqual(changed.contentSha256, first.contentSha256);
  });

  void it('binds an untracked symlink target and canonical 120000 mode', async () => {
    const root = fixture();
    const linkPath = join(root, 'evidence-link');
    symlinkSync('first-target', linkPath);
    const firstTarget = await computeCanonicalGitWorktreeEvidence(root);
    rmSync(linkPath);
    writeFileSync(linkPath, 'first-target', 'utf8');
    const regularFile = await computeCanonicalGitWorktreeEvidence(root);
    rmSync(linkPath);
    symlinkSync('second-target', linkPath);
    const secondTarget = await computeCanonicalGitWorktreeEvidence(root);

    assert.notEqual(regularFile.contentSha256, firstTarget.contentSha256);
    assert.notEqual(secondTarget.contentSha256, firstTarget.contentSha256);
  });

  void it('rejects a torn byte snapshot even when path-level dirty status is unchanged', async () => {
    const root = fixture();
    const trackedPath = join(root, 'tracked', 'payload.txt');
    writeFileSync(trackedPath, 'first dirty generation\n', 'utf8');

    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root, {
        beforeSnapshotVerification: () => {
          writeFileSync(trackedPath, 'other dirty generation\n', 'utf8');
        },
      }),
      (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'DIRTY_SNAPSHOT_MOVED',
    );
  });

  void it('separates content identity from repository substrate identity', async () => {
    const source = fixture();
    writeFileSync(join(source, 'tracked', 'payload.txt'), 'same dirty bytes\n', 'utf8');
    writeFileSync(join(source, 'untracked.txt'), 'same untracked bytes\n', 'utf8');
    const replica = `${source}-independent-replica`;
    fixtureRoots.push(replica);
    cpSync(source, replica, { recursive: true, preserveTimestamps: true });
    git(replica, 'config', 'remote.origin.url', 'https://example.invalid/different.git');
    git(replica, 'config', 'user.name', 'Different Inert User');
    git(replica, 'config', 'user.email', 'different@example.invalid');

    const sourceEvidence = await computeCanonicalGitWorktreeEvidence(source);
    const replicaEvidence = await computeCanonicalGitWorktreeEvidence(replica);
    assert.equal(replicaEvidence.headSha, sourceEvidence.headSha);
    assert.equal(replicaEvidence.statusSha256, sourceEvidence.statusSha256);
    assert.equal(replicaEvidence.contentSha256, sourceEvidence.contentSha256);
    assert.notEqual(
      replicaEvidence.substrateAttestationSha256,
      sourceEvidence.substrateAttestationSha256,
    );

    const sameBytes = readFileSync(join(source, 'tracked', 'payload.txt'));
    renameSync(join(source, 'tracked', 'payload.txt'), join(source, 'tracked', 'payload.old'));
    writeFileSync(join(source, 'tracked', 'payload.txt'), sameBytes);
    rmSync(join(source, 'tracked', 'payload.old'));
    const replacedEvidence = await computeCanonicalGitWorktreeEvidence(source);
    assert.equal(replacedEvidence.contentSha256, sourceEvidence.contentSha256);
    assert.notEqual(
      replacedEvidence.substrateAttestationSha256,
      sourceEvidence.substrateAttestationSha256,
    );
  });

  void it('refuses local include/filter/diff process authorities before executing them', async () => {
    const root = fixture();
    const sentinel = join(root, 'filter-ran');
    writeFileSync(join(root, '.gitattributes'), 'tracked/payload.txt filter=evil diff=evil\n');
    git(root, 'add', '.gitattributes');
    git(root, 'config', 'filter.evil.clean', `/bin/sh -c 'touch ${sentinel}'`);
    git(root, 'config', 'diff.evil.command', `/bin/sh -c 'touch ${sentinel}'`);
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root),
      /refuses ungoverned local config (?:filter|diff)\.evil/,
    );
    assert.throws(() => readFileSync(sentinel), /ENOENT/);
  });

  void it('rejects assume-unchanged, skip-worktree, and fsmonitor-valid index flags', async () => {
    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const root = fixture();
      git(root, 'update-index', flag, 'tracked/payload.txt');
      await assert.rejects(
        computeCanonicalGitWorktreeEvidence(root),
        /assume-unchanged, skip-worktree, fsmonitor-valid/,
      );
    }
    const fsmonitorRoot = fixture();
    injectPersistedFsmonitorIndexBit(fsmonitorRoot);
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(fsmonitorRoot),
      /Git index|unknown index entry|git .* failed/,
    );
  });

  void it('detects executable-mode drift even when local core.fileMode is false', async () => {
    const root = fixture();
    git(root, 'config', 'core.fileMode', 'false');
    const clean = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(clean.dirty, false);
    chmodSync(join(root, 'tracked', 'payload.txt'), 0o654);
    const changed = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(changed.dirty, true);
    assert.notEqual(changed.contentSha256, clean.contentSha256);
  });

  void it('proves HEAD-only blobs after a staged deletion', async () => {
    const root = fixture();
    const objectId = git(root, 'rev-parse', 'HEAD:tracked/payload.txt');
    git(root, 'rm', '--quiet', 'tracked/payload.txt');
    const looseObject = join(root, '.git', 'objects', objectId.slice(0, 2), objectId.slice(2));
    writeFileSync(looseObject, 'corrupted HEAD-only object authority\n', 'utf8');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root),
      /git .* failed|blob proof|governed blobs/i,
    );
  });

  void it('rejects transient create-remove races for a tracked missing path', async () => {
    const root = fixture();
    const trackedPath = join(root, 'tracked', 'payload.txt');
    rmSync(trackedPath);
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root, {
        beforeSnapshotVerification: () => {
          writeFileSync(trackedPath, 'governed\n', 'utf8');
          rmSync(trackedPath);
        },
      }),
      /changed during hashing|evidence changed|generation changed|DIRTY_SNAPSHOT_MOVED|raw tracked bytes/i,
    );
  });

  void it('fails closed for gitlinks, partial/promisor config, replace refs, and alternates', async () => {
    const gitlinkRoot = fixture();
    git(
      gitlinkRoot,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${git(gitlinkRoot, 'rev-parse', 'HEAD')},vendor/submodule`,
    );
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(gitlinkRoot),
      /gitlink; submodule content is not recursively governed/,
    );

    const promisorRoot = fixture();
    git(promisorRoot, 'config', 'remote.origin.promisor', 'true');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(promisorRoot),
      /refuses partial\/promisor object authority/,
    );

    const replaceRoot = fixture();
    writeFileSync(join(replaceRoot, 'tracked', 'payload.txt'), 'replacement commit\n', 'utf8');
    git(replaceRoot, 'add', 'tracked/payload.txt');
    git(
      replaceRoot,
      '-c',
      'user.name=Hermetic Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'replacement fixture',
    );
    git(
      replaceRoot,
      'replace',
      git(replaceRoot, 'rev-parse', 'HEAD'),
      git(replaceRoot, 'rev-parse', 'HEAD~1'),
    );
    await assert.rejects(computeCanonicalGitWorktreeEvidence(replaceRoot), /replace refs/);

    const alternateRoot = fixture();
    const alternatePath = fixture();
    writeFileSync(
      join(alternateRoot, '.git', 'objects', 'info', 'alternates'),
      `${join(alternatePath, '.git', 'objects')}\n`,
      'utf8',
    );
    await assert.rejects(computeCanonicalGitWorktreeEvidence(alternateRoot), /object alternates/);
  });

  void it('rejects transient creation of an initially absent topology authority', async () => {
    const root = fixture();
    const alternatesPath = join(root, '.git', 'objects', 'info', 'alternates');
    let injected = false;
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root, {
        afterRepositoryTopologyRead: () => {
          if (injected) return;
          injected = true;
          writeFileSync(alternatesPath, '', 'utf8');
          rmSync(alternatesPath);
        },
      }),
      /parent.*changed|entry-generation|repository-topology observation/,
    );
  });

  void it('does not cache object proofs across independent full evidence generations', async () => {
    const root = fixture();
    await computeCanonicalGitWorktreeEvidence(root);
    const objectId = git(root, 'rev-parse', 'HEAD:tracked/payload.txt');
    const looseObject = join(root, '.git', 'objects', objectId.slice(0, 2), objectId.slice(2));
    writeFileSync(looseObject, 'corrupted object authority\n', 'utf8');
    await assert.rejects(computeCanonicalGitWorktreeEvidence(root), /git .* failed|blob proof/i);
  });

  void it('captures self-hidden untracked .gitignore authority without capturing ignored payloads', async () => {
    const root = fixture();
    const hidden = join(root, 'hidden');
    mkdirSync(hidden);
    writeFileSync(join(hidden, '.gitignore'), '.gitignore\nsecret.txt\n', 'utf8');
    writeFileSync(join(hidden, 'secret.txt'), 'first secret\n', 'utf8');
    const first = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(first.dirty, true);

    writeFileSync(join(hidden, 'secret.txt'), 'second secret\n', 'utf8');
    const ignoredPayloadChanged = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(ignoredPayloadChanged.contentSha256, first.contentSha256);

    writeFileSync(join(hidden, '.gitignore'), '.gitignore\nsecret.txt\n# authority changed\n');
    const authorityChanged = await computeCanonicalGitWorktreeEvidence(root);
    assert.notEqual(authorityChanged.contentSha256, first.contentSha256);
  });

  void it('pins every parent directory descriptor and rejects a parent-to-symlink swap', async () => {
    const root = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'hermetic-git-outside-'));
    fixtureRoots.push(outside);
    writeFileSync(join(outside, 'payload.txt'), 'governed\n', 'utf8');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root, {
        beforeSnapshotVerification: () => {
          renameSync(join(root, 'tracked'), join(root, 'tracked-original'));
          symlinkSync(outside, join(root, 'tracked'));
        },
      }),
      /symlink|ELOOP|changed/,
    );
  });

  void it('atomically attests linked-worktree redirect, commondir, and backlink bytes', async () => {
    const fixture = linkedFixture();
    const clean = await computeCanonicalGitWorktreeEvidence(fixture.linked);
    assert.equal(clean.dirty, false);

    const gitDir = git(fixture.linked, 'rev-parse', '--absolute-git-dir');
    writeFileSync(join(gitDir, 'gitdir'), `${fixture.root}/.git\n`, 'utf8');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(fixture.linked),
      /gitdir backlink does not name/,
    );
  });

  void it('rejects same-byte .git generation replacement and invalid UTF-8 metadata', async () => {
    const replaced = linkedFixture();
    const redirectPath = join(replaced.linked, '.git');
    const redirectBytes = readFileSync(redirectPath);
    let replacedOnce = false;
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(replaced.linked, {
        afterRepositoryTopologyRead: () => {
          if (replacedOnce) return;
          replacedOnce = true;
          renameSync(redirectPath, `${redirectPath}.previous`);
          writeFileSync(redirectPath, redirectBytes);
        },
      }),
      /repository-topology observation|generation|changed/,
    );

    const invalid = linkedFixture();
    writeFileSync(
      join(invalid.linked, '.git'),
      Buffer.concat([Buffer.from('gitdir: ', 'ascii'), Buffer.from([0xff]), Buffer.from('\n')]),
    );
    await assert.rejects(computeCanonicalGitWorktreeEvidence(invalid.linked), /not valid UTF-8/);
  });

  void it('rejects tracked paths that cannot cross the UTF-8 manifest boundary', async () => {
    const root = fixture();
    const invalidPath = Buffer.concat([
      Buffer.from(`${root}/`, 'utf8'),
      Buffer.from([0x69, 0x6e, 0x76, 0x61, 0x6c, 0x69, 0x64, 0xff]),
    ]);
    writeFileSync(invalidPath, 'invalid path\n');
    git(root, 'add', '-A');
    await assert.rejects(computeCanonicalGitWorktreeEvidence(root), /not valid UTF-8/);
  });

  void it('rejects case/normalization collisions and unsupported SHA-256 repositories', async () => {
    const collisionRoot = fixture();
    writeFileSync(join(collisionRoot, 'Case.txt'), 'upper\n', 'utf8');
    writeFileSync(join(collisionRoot, 'case.txt'), 'lower\n', 'utf8');
    git(collisionRoot, 'add', 'Case.txt', 'case.txt');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(collisionRoot),
      /case\/normalization collision/,
    );

    const sha256Root = fixture('sha256');
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(sha256Root),
      /repository format 0|governs only repository-format-0 SHA-1/,
    );
  });
});
