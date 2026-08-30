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
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { defineHermeticExecutableExecutionPolicyV1 } from './anchored-filesystem';
import {
  computeCanonicalGitWorktreeEvidence,
  HERMETIC_GIT_EXECUTION_MODES_V1,
  HERMETIC_GIT_EXECUTION_POLICY_V1,
  HERMETIC_GIT_RUNTIME,
  HermeticGitExecutionTimeoutError,
  HermeticGitSynchronousBudgetError,
  InventoryInspectionError,
  REPOSITORY_CHILD_FD_COORDINATES_V1,
  runWithHermeticGitExecutionBudget,
  runWithHermeticGitExecutionDeadline,
} from './hermetic-git-runtime';
import {
  testOnlyCloseHermeticGitDescriptors,
  testOnlyCreateHermeticGitRuntime,
  testOnlyFingerprintHermeticGitRegularFile,
} from './hermetic-git-runtime.fixture';

const fixtureRoots: string[] = [];

function errorTreeContains(error: unknown, pattern: RegExp): boolean {
  if (!(error instanceof Error)) return false;
  if (pattern.test(error.message)) return true;
  return (
    error instanceof AggregateError &&
    error.errors.some((nested) => errorTreeContains(nested, pattern))
  );
}

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
      () => testOnlyCreateHermeticGitRuntime(relaxedPolicy),
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
    const accessorRuntime = testOnlyCreateHermeticGitRuntime(accessorPolicy);
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
    const runtime = testOnlyCreateHermeticGitRuntime(executionPolicy);
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
    const runtime = testOnlyCreateHermeticGitRuntime(
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
    const shortPolicyRuntime = testOnlyCreateHermeticGitRuntime(
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

  void it('seals detached continuations before they can spawn a post-settlement child', async () => {
    const root = fixture();
    const fifoName = 'detached-after-settlement';
    const fifoPath = join(root, fifoName);
    execFileSync('/usr/bin/mkfifo', [fifoPath]);
    const runtime = testOnlyCreateHermeticGitRuntime(
      defineHermeticExecutableExecutionPolicyV1({
        schemaVersion: 1,
        commandDeadlineMs: 2_000,
        timeoutSignal: 'SIGKILL',
      }),
    );
    let resolveDetached!: (outcome: unknown) => void;
    const detachedOutcome = new Promise<unknown>((resolve) => {
      resolveDetached = resolve;
    });
    const result = await runWithHermeticGitExecutionDeadline(
      1_000,
      new Error('unexpected detached deadline'),
      () => {
        setImmediate(() => {
          void runtime.runBufferAsync(root, ['hash-object', '--', fifoName]).then(
            () => resolveDetached(new Error('detached child unexpectedly completed')),
            (error: unknown) => resolveDetached(error),
          );
        });
        return 'settled';
      },
    );
    assert.equal(result, 'settled');
    assert.match(String(await detachedOutcome), /scope is already settled/);
    assert.throws(
      () => openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
    );
    runtime.close();
  });

  void it('kills and reaps every unawaited child owned by an expired scope', async () => {
    const root = fixture();
    const fifoNames = ['unawaited-first', 'unawaited-second'] as const;
    for (const fifoName of fifoNames) execFileSync('/usr/bin/mkfifo', [join(root, fifoName)]);
    const runtime = testOnlyCreateHermeticGitRuntime(
      defineHermeticExecutableExecutionPolicyV1({
        schemaVersion: 1,
        commandDeadlineMs: 5_000,
        timeoutSignal: 'SIGKILL',
      }),
    );
    const ownedChildren: Promise<unknown>[] = [];
    const deadlineFailure = new Error('multi-child scope deadline');
    const execution = runWithHermeticGitExecutionDeadline(1_000, deadlineFailure, () => {
      for (const fifoName of fifoNames) {
        ownedChildren.push(
          runtime
            .runBufferAsync(root, ['hash-object', '--', fifoName])
            .catch((error: unknown) => error),
        );
      }
      return new Promise<never>(() => undefined);
    });
    const rejection = assert.rejects(execution, (error: unknown) => error === deadlineFailure);
    const writers = await Promise.all(
      fifoNames.map((fifoName) => openFifoWriterAfterReader(join(root, fifoName))),
    );
    await rejection;
    await Promise.allSettled(ownedChildren);
    for (const writer of writers) closeSync(writer);
    for (const fifoName of fifoNames) {
      assert.throws(
        () => openSync(join(root, fifoName), constants.O_WRONLY | constants.O_NONBLOCK),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
      );
    }
    runtime.close();
  });

  void it('drains on real close and terminates the complete owned process group', async () => {
    const root = fixture();
    const runtime = testOnlyCreateHermeticGitRuntime(
      defineHermeticExecutableExecutionPolicyV1({
        schemaVersion: 1,
        commandDeadlineMs: 5_000,
        timeoutSignal: 'SIGKILL',
      }),
    );
    let closeBoundChild: Promise<unknown> | undefined;
    const closeStartedAt = performance.now();
    const settled = await runWithHermeticGitExecutionDeadline(
      2_000,
      new Error('close-bound child exceeded its coordinator deadline'),
      () => {
        closeBoundChild = runtime
          .runTextAsync(root, ['-c', 'alias.hold=!/bin/sh -c "sleep 0.4 &"', 'hold'])
          .catch((error: unknown) => error);
        return 'settled';
      },
    );
    const closeElapsedMs = performance.now() - closeStartedAt;
    assert.equal(settled, 'settled');
    assert.ok(
      closeElapsedMs >= 300,
      `coordinator settled before close: ${String(closeElapsedMs)}ms`,
    );
    await closeBoundChild;

    const detachedPidPath = join(root, 'detached-descendant.pid');
    const detachedSpawnerPath = join(root, 'spawn-detached-descendant.sh');
    writeFileSync(
      detachedSpawnerPath,
      `#!/bin/sh\nsleep 30 </dev/null >/dev/null 2>&1 &\nprintf '%s\\n' "$!" > "$1"\n`,
      'utf8',
    );
    chmodSync(detachedSpawnerPath, 0o700);
    await runtime.runTextAsync(root, [
      '-c',
      `alias.spawn-detached=!${detachedSpawnerPath} ${detachedPidPath}`,
      'spawn-detached',
    ]);
    const detachedPid = Number.parseInt(readFileSync(detachedPidPath, 'utf8').trim(), 10);
    assert.ok(Number.isSafeInteger(detachedPid) && detachedPid > 1);
    let descendantCleanupError: Error | undefined;
    try {
      const descendantDeadline = performance.now() + 1_000;
      for (;;) {
        try {
          process.kill(detachedPid, 0);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break;
          throw error;
        }
        if (performance.now() >= descendantDeadline) {
          assert.fail(`successful Git child left process-group descendant ${String(detachedPid)}`);
        }
        await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      }
    } finally {
      try {
        process.kill(detachedPid, 'SIGKILL');
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') {
          descendantCleanupError =
            error instanceof Error
              ? error
              : new Error('Detached Git descendant cleanup failed', { cause: error });
        }
      }
    }
    if (descendantCleanupError !== undefined) throw descendantCleanupError;

    const groupDeadline = new Error('owned process-group deadline');
    const groupStartedAt = performance.now();
    await assert.rejects(
      runWithHermeticGitExecutionDeadline(300, groupDeadline, () =>
        runtime.runTextAsync(root, ['-c', 'alias.hold=!/bin/sh -c "sleep 30 &"', 'hold']),
      ),
      (error: unknown) => error === groupDeadline,
    );
    assert.ok(performance.now() - groupStartedAt < 1_500);
    runtime.close();
  });

  void it('lets an outer scope continue only after its shorter inner scope has reaped', async () => {
    const root = fixture();
    const fifoName = 'inner-deadline-owner';
    const fifoPath = join(root, fifoName);
    execFileSync('/usr/bin/mkfifo', [fifoPath]);
    const runtime = testOnlyCreateHermeticGitRuntime(
      defineHermeticExecutableExecutionPolicyV1({
        schemaVersion: 1,
        commandDeadlineMs: 5_000,
        timeoutSignal: 'SIGKILL',
      }),
    );
    const outerFailure = new Error('unexpected outer deadline');
    const innerFailure = new Error('expected inner deadline');
    let resolveDetachedInner!: (outcome: unknown) => void;
    const detachedInnerOutcome = new Promise<unknown>((resolve) => {
      resolveDetachedInner = resolve;
    });
    const head = await runWithHermeticGitExecutionDeadline(3_000, outerFailure, async () => {
      const innerExecution = runWithHermeticGitExecutionDeadline(500, innerFailure, () => {
        setTimeout(() => {
          void runtime.runTextAsync(root, ['rev-parse', '--verify', 'HEAD']).then(
            () => resolveDetachedInner(new Error('sealed inner continuation unexpectedly ran')),
            (error: unknown) => resolveDetachedInner(error),
          );
        }, 700);
        return runtime.runBufferAsync(root, ['hash-object', '--', fifoName]);
      });
      const innerRejection = assert.rejects(
        innerExecution,
        (error: unknown) => error === innerFailure,
      );
      const writer = await openFifoWriterAfterReader(fifoPath);
      await innerRejection;
      closeSync(writer);
      assert.throws(
        () => openSync(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
      );
      assert.equal(await detachedInnerOutcome, innerFailure);
      return (await runtime.runTextAsync(root, ['rev-parse', '--verify', 'HEAD'])).stdout.trim();
    });
    assert.equal(head, git(root, 'rev-parse', '--verify', 'HEAD'));
    runtime.close();
  });

  void it('shares one async buffered kernel for stdin, limits, and live execution', async () => {
    const root = fixture();
    const runtime = testOnlyCreateHermeticGitRuntime(
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

  void it('exposes one pathless repository session and derives every child FD coordinate', async () => {
    const root = fixture();
    assert.equal('runText' in HERMETIC_GIT_RUNTIME, false);
    assert.equal('parseConfig' in HERMETIC_GIT_RUNTIME, false);
    assert.deepEqual(REPOSITORY_CHILD_FD_COORDINATES_V1, [
      { role: 'WORKTREE', childFd: 3, environmentKey: 'GIT_WORK_TREE', useAsCwd: true },
      { role: 'GIT_DIR', childFd: 4, environmentKey: 'GIT_DIR', useAsCwd: false },
      { role: 'COMMON_DIR', childFd: 5, environmentKey: 'GIT_COMMON_DIR', useAsCwd: false },
    ]);
    const coordinates = await HERMETIC_GIT_RUNTIME.withRepository(root, async (session) => ({
      commonDir: (
        await session.readTextAsync({
          kind: 'REPOSITORY_COORDINATE',
          coordinate: 'COMMON_DIR',
        })
      ).stdout.trim(),
      gitDir: (
        await session.readTextAsync({ kind: 'REPOSITORY_COORDINATE', coordinate: 'GIT_DIR' })
      ).stdout.trim(),
      sessionKeys: Object.keys(session).sort(),
      worktree: (
        await session.readTextAsync({ kind: 'REPOSITORY_COORDINATE', coordinate: 'TOP_LEVEL' })
      ).stdout.trim(),
    }));
    assert.deepEqual(coordinates.sessionKeys, ['readAsync', 'readTextAsync']);
    assert.equal(realpathSync(coordinates.worktree), root);
    assert.equal(realpathSync(coordinates.gitDir), join(root, '.git'));
    assert.equal(realpathSync(coordinates.commonDir), join(root, '.git'));
    const sync = HERMETIC_GIT_RUNTIME.withRepositorySync(root, (session) => ({
      head: session
        .readText({ kind: 'RESOLVE_OBJECT', revision: 'HEAD', peel: 'COMMIT' })
        .stdout.trim(),
      sessionKeys: Object.keys(session).sort(),
    }));
    assert.equal(sync.head, git(root, 'rev-parse', '--verify', 'HEAD'));
    assert.deepEqual(sync.sessionKeys, ['read', 'readText']);

    const escaped = await HERMETIC_GIT_RUNTIME.withRepository(root, (session) => session);
    await assert.rejects(
      escaped.readTextAsync({ kind: 'RESOLVE_OBJECT', revision: 'HEAD', peel: 'COMMIT' }),
      /session is already settled|session escaped its descriptor authority/,
    );
    assert.throws(
      () =>
        Reflect.apply(HERMETIC_GIT_RUNTIME.withRepositorySync, HERMETIC_GIT_RUNTIME, [
          root,
          () => Promise.resolve('escaped'),
        ]),
      /synchronous repository action returned a Promise\/thenable/,
    );
  });

  void it('executes one bounded ordered commit-object batch with explicit missing observations', () => {
    const root = fixture();
    const fullOid = git(root, 'rev-parse', 'HEAD');
    const shortOid = fullOid.slice(0, 8);
    const missingOid = '0000000000000000000000000000000000000000';

    HERMETIC_GIT_RUNTIME.withRepositorySync(root, (session) => {
      const output = session.read({
        kind: 'READ_COMMIT_BATCH',
        oids: [shortOid, missingOid, fullOid],
      }).stdout;
      const firstHeader = Buffer.from(`${fullOid} commit `, 'ascii');
      const missingHeader = Buffer.from(`${missingOid}^{commit} missing\n`, 'ascii');
      const first = output.indexOf(firstHeader);
      const missing = output.indexOf(missingHeader, first + firstHeader.length);
      const repeated = output.indexOf(firstHeader, missing + missingHeader.length);
      assert.equal(first, 0);
      assert.ok(missing > first);
      assert.ok(repeated > missing);

      assert.throws(
        () => session.read({ kind: 'READ_COMMIT_BATCH', oids: [] }),
        /requires 1\.\.4096 object IDs/,
      );
      assert.throws(
        () => session.read({ kind: 'READ_COMMIT_BATCH', oids: ['abcdef'] }),
        /must be HEAD or one canonical local\/origin ref/,
      );
    });
  });

  void it('compiles every public path field as one literal top-level pathspec', async () => {
    const root = fixture();
    const magicPath = ':(glob)magic*.txt';
    const globPath = 'literal[ab]?*.txt';
    const decoyPath = 'magic-decoy.txt';
    for (const path of [magicPath, globPath, decoyPath]) {
      writeFileSync(join(root, path), `base ${path}\n`, 'utf8');
    }
    git(root, 'add', '--all');
    git(
      root,
      '-c',
      'user.name=Hermetic Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'literal pathspec fixture',
    );
    const revision = git(root, 'rev-parse', 'HEAD');
    for (const path of [magicPath, globPath, decoyPath]) {
      writeFileSync(join(root, path), `changed ${path}\n`, 'utf8');
    }

    const selected = await HERMETIC_GIT_RUNTIME.withRepository(root, async (session) => {
      const paths = [magicPath, globPath] as const;
      const [index, tree, diff] = await Promise.all([
        session.readAsync({ kind: 'LIST_INDEX_PATHS', selection: 'TRACKED', roots: paths }),
        session.readAsync({
          kind: 'LIST_TREE',
          revision,
          projection: 'PATHS',
          recursive: true,
          paths,
        }),
        session.readAsync({
          kind: 'DIFF',
          projection: 'NAME_ONLY',
          base: revision,
          paths,
        }),
      ]);
      const decode = (raw: Buffer): string[] =>
        raw
          .toString('utf8')
          .split('\0')
          .filter((path) => path.length > 0)
          .sort();
      return {
        diff: decode(diff.stdout),
        index: decode(index.stdout),
        tree: decode(tree.stdout),
      };
    });
    const expected = [globPath, magicPath].sort();
    assert.deepEqual(selected.index, expected);
    assert.deepEqual(selected.tree, expected);
    assert.deepEqual(selected.diff, expected);
  });

  void it('seals, interrupts, and reaps an unawaited async-session operation', async () => {
    const root = fixture();
    const refPath = join(root, '.git', 'refs', 'heads', 'main');

    const operationOutcomes: Promise<unknown>[] = [];
    const deadlineFailure = new Error('unawaited repository session deadline');
    const execution = runWithHermeticGitExecutionDeadline(500, deadlineFailure, () =>
      HERMETIC_GIT_RUNTIME.withRepository(root, (session) => {
        renameSync(refPath, `${refPath}.original`);
        execFileSync('/usr/bin/mkfifo', [refPath]);
        operationOutcomes.push(
          session
            .readTextAsync({ kind: 'RESOLVE_OBJECT', revision: 'HEAD', peel: 'COMMIT' })
            .catch((error: unknown) => error),
        );
        return 'action-settled';
      }),
    );
    const rejection = assert.rejects(execution, (error: unknown) => error === deadlineFailure);
    const writer = await openFifoWriterAfterReader(refPath);
    await rejection;
    await Promise.all(operationOutcomes);
    closeSync(writer);
    assert.throws(
      () => openSync(refPath, constants.O_WRONLY | constants.O_NONBLOCK),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENXIO',
    );
  });

  void it('preserves simultaneous async-session action and operation failures', async () => {
    const root = fixture();
    const actionFailure = new Error('repository action sentinel');
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(root, (session) => {
        void session.readTextAsync({ kind: 'RAW', args: ['status'] } as never);
        throw actionFailure;
      }),
      (error: unknown) =>
        error instanceof AggregateError &&
        errorTreeContains(error, /repository action sentinel/) &&
        errorTreeContains(error, /query kind is not governed/),
    );
  });

  void it('rejects raw command-shaped queries and retains config topology across every read', async () => {
    const rawRoot = fixture();
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(rawRoot, (session) =>
        session.readTextAsync({ kind: 'RAW', args: ['status'] } as never),
      ),
      /query kind is not governed/,
    );

    const changedRoot = fixture();
    const configPath = join(changedRoot, '.git', 'config');
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(changedRoot, async (session) => {
        await session.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
        writeFileSync(configPath, `${readFileSync(configPath, 'utf8')}# changed\n`, 'utf8');
        await session.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
      }),
      (error: unknown) => errorTreeContains(error, /config|generation|changed/i),
    );

    const finalRoot = fixture();
    const finalConfigPath = join(finalRoot, '.git', 'config');
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(finalRoot, async (session) => {
        await session.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
        writeFileSync(
          finalConfigPath,
          `${readFileSync(finalConfigPath, 'utf8')}# final drift\n`,
          'utf8',
        );
      }),
      (error: unknown) => errorTreeContains(error, /config|generation|changed/i),
    );
  });

  void it('rejects A-B-A config replacement and absent topology authorities', async () => {
    const replacementRoot = fixture();
    const configPath = join(replacementRoot, '.git', 'config');
    const originalConfig = readFileSync(configPath);
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(replacementRoot, async (session) => {
        await session.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
        const priorPath = `${configPath}.prior`;
        renameSync(configPath, priorPath);
        writeFileSync(configPath, originalConfig);
        rmSync(priorPath);
        await session.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
      }),
      (error: unknown) => errorTreeContains(error, /config|generation|changed/i),
    );

    for (const relativePath of [
      '.git/objects/info/alternates',
      '.git/shallow',
      '.git/info/grafts',
    ]) {
      const root = fixture();
      await assert.rejects(
        HERMETIC_GIT_RUNTIME.withRepository(root, async (session) => {
          await session.readTextAsync({
            kind: 'RESOLVE_OBJECT',
            revision: 'HEAD',
            peel: 'COMMIT',
          });
          writeFileSync(join(root, relativePath), '', 'utf8');
          await session.readTextAsync({
            kind: 'RESOLVE_OBJECT',
            revision: 'HEAD',
            peel: 'COMMIT',
          });
        }),
        (error: unknown) => errorTreeContains(error, /parent|generation|changed/i),
      );
    }

    const replaceRefRoot = fixture();
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(replaceRefRoot, async (session) => {
        await session.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
        mkdirSync(join(replaceRefRoot, '.git', 'refs', 'replace'));
        await session.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
      }),
      (error: unknown) => errorTreeContains(error, /replace refs|parent|generation|changed/i),
    );
  });

  void it('shares the outer topology baseline with nested sessions and preserves dual failures', async () => {
    const nestedRoot = fixture();
    const nestedConfig = join(nestedRoot, '.git', 'config');
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(nestedRoot, async (outer) => {
        await outer.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
        writeFileSync(nestedConfig, `${readFileSync(nestedConfig, 'utf8')}# nested drift\n`);
        await HERMETIC_GIT_RUNTIME.withRepository(nestedRoot, async (inner) =>
          inner.readTextAsync({
            kind: 'RESOLVE_OBJECT',
            revision: 'HEAD',
            peel: 'COMMIT',
          }),
        );
      }),
      (error: unknown) => errorTreeContains(error, /config|generation|changed/i),
    );

    const nestedEvidenceRoot = fixture();
    const nestedEvidenceConfig = join(nestedEvidenceRoot, '.git', 'config');
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(nestedEvidenceRoot, async (outer) => {
        await outer.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
        writeFileSync(
          nestedEvidenceConfig,
          `${readFileSync(nestedEvidenceConfig, 'utf8')}# nested evidence drift\n`,
        );
        await computeCanonicalGitWorktreeEvidence(nestedEvidenceRoot);
      }),
      (error: unknown) => errorTreeContains(error, /config|generation|changed/i),
    );

    const failureRoot = fixture();
    const failureConfig = join(failureRoot, '.git', 'config');
    const sentinel = new Error('sentinel repository action failure');
    await assert.rejects(
      HERMETIC_GIT_RUNTIME.withRepository(failureRoot, async (session) => {
        await session.readTextAsync({
          kind: 'RESOLVE_OBJECT',
          revision: 'HEAD',
          peel: 'COMMIT',
        });
        writeFileSync(failureConfig, `${readFileSync(failureConfig, 'utf8')}# failure drift\n`);
        throw sentinel;
      }),
      (error: unknown) =>
        error instanceof AggregateError &&
        errorTreeContains(error, /sentinel repository action failure/) &&
        errorTreeContains(error, /config|generation|changed/i),
    );
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

  void it('fingerprints inactive worktree config and rejects its common-config activation', async () => {
    const root = fixture();
    const worktreeConfigPath = join(root, '.git', 'config.worktree');
    const baseline = await computeCanonicalGitWorktreeEvidence(root);

    writeFileSync(worktreeConfigPath, '[credential]\n\thelper = store\n', 'utf8');
    const firstInactiveGeneration = await computeCanonicalGitWorktreeEvidence(root);
    assert.notEqual(firstInactiveGeneration.contentSha256, baseline.contentSha256);
    assert.notEqual(
      firstInactiveGeneration.substrateAttestationSha256,
      baseline.substrateAttestationSha256,
    );

    writeFileSync(worktreeConfigPath, '[credential]\n\thelper = cache\n', 'utf8');
    const secondInactiveGeneration = await computeCanonicalGitWorktreeEvidence(root);
    assert.notEqual(secondInactiveGeneration.contentSha256, firstInactiveGeneration.contentSha256);
    assert.notEqual(
      secondInactiveGeneration.substrateAttestationSha256,
      firstInactiveGeneration.substrateAttestationSha256,
    );

    writeFileSync(
      join(root, '.git', 'config'),
      `${readFileSync(join(root, '.git', 'config'), 'utf8')}\n[extensions]\n\tworktreeConfig = true\n`,
      'utf8',
    );
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(root),
      /refuses ungoverned local config extensions\.worktreeconfig/,
    );
  });

  void it('binds linked-worktree config identity below the exact per-worktree git directory', async () => {
    const root = fixture();
    const linkedRoot = `${root}-linked`;
    fixtureRoots.push(linkedRoot);
    git(root, 'worktree', 'add', '--detach', linkedRoot, 'HEAD');
    const linkedGitDirectory = resolve(linkedRoot, git(linkedRoot, 'rev-parse', '--git-dir'));
    const linkedWorktreeConfig = join(linkedGitDirectory, 'config.worktree');
    const baseline = await computeCanonicalGitWorktreeEvidence(linkedRoot);

    writeFileSync(linkedWorktreeConfig, '[credential]\n\thelper = store\n', 'utf8');
    const firstInactiveGeneration = await computeCanonicalGitWorktreeEvidence(linkedRoot);
    assert.notEqual(firstInactiveGeneration.contentSha256, baseline.contentSha256);
    assert.notEqual(
      firstInactiveGeneration.substrateAttestationSha256,
      baseline.substrateAttestationSha256,
    );

    writeFileSync(linkedWorktreeConfig, '[credential]\n\thelper = cache\n', 'utf8');
    const secondInactiveGeneration = await computeCanonicalGitWorktreeEvidence(linkedRoot);
    assert.notEqual(secondInactiveGeneration.contentSha256, firstInactiveGeneration.contentSha256);
    assert.notEqual(
      secondInactiveGeneration.substrateAttestationSha256,
      firstInactiveGeneration.substrateAttestationSha256,
    );

    writeFileSync(
      join(root, '.git', 'config'),
      `${readFileSync(join(root, '.git', 'config'), 'utf8')}\n[extensions]\n\tworktreeConfig = true\n`,
      'utf8',
    );
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(linkedRoot),
      /refuses ungoverned local config extensions\.worktreeconfig/,
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

  void it('accepts inert config for branch names containing ref path separators', async () => {
    const root = fixture();
    git(root, 'config', 'branch.codex/authority-hardening.remote', 'origin');
    git(
      root,
      'config',
      'branch.codex/authority-hardening.merge',
      'refs/heads/codex/authority-hardening',
    );

    const evidence = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(evidence.dirty, false);
  });

  void it('masks the installed hook authority inside every hermetic Git child', async () => {
    const root = fixture();
    git(root, 'config', 'core.hooksPath', '.husky');
    const runtime = testOnlyCreateHermeticGitRuntime(HERMETIC_GIT_EXECUTION_POLICY_V1);
    try {
      const configuredHooksPath = runtime.runText(root, ['config', '--get', 'core.hooksPath']);
      assert.equal(configuredHooksPath.status, 0);
      assert.equal(configuredHooksPath.stdout.trim(), '/dev/null');
    } finally {
      runtime.close();
    }

    const evidence = await computeCanonicalGitWorktreeEvidence(root);
    assert.equal(evidence.dirty, false);
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
    chmodSync(looseObject, 0o600);
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
      (error: unknown) =>
        errorTreeContains(
          error,
          /parent.*changed|entry-generation|repository-topology observation/,
        ),
    );
  });

  void it('does not cache object proofs across independent full evidence generations', async () => {
    const root = fixture();
    await computeCanonicalGitWorktreeEvidence(root);
    const objectId = git(root, 'rev-parse', 'HEAD:tracked/payload.txt');
    const looseObject = join(root, '.git', 'objects', objectId.slice(0, 2), objectId.slice(2));
    chmodSync(looseObject, 0o600);
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
      (error: unknown) => errorTreeContains(error, /symlink|ELOOP|changed/),
    );
  });

  void it('rejects an A-B-A worktree locator swap against the retained descriptor authority', async () => {
    const original = fixture();
    const replacement = fixture();
    const held = `${original}-held`;
    let swapped = false;
    await assert.rejects(
      computeCanonicalGitWorktreeEvidence(original, {
        beforeSnapshotVerification: () => {
          renameSync(original, held);
          renameSync(replacement, original);
          renameSync(original, replacement);
          renameSync(held, original);
          swapped = true;
        },
      }),
      (error: unknown) => errorTreeContains(error, /retained descriptor|topology|changed/),
    );
    assert.equal(swapped, true);
  });

  void it('sandwich-attests linked-worktree redirect, commondir, and backlink bytes', async () => {
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
      (error: unknown) =>
        errorTreeContains(error, /repository-topology observation|generation|changed/),
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
