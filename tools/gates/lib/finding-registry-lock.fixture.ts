#!/usr/bin/env ts-node

import {
  RegistryLockError,
  testOnlyWithRegistryFileLock,
  testOnlyWithRegistryFileLockAsync,
} from '../finding-registry-store';

import {
  assertStoreSpecEntrypointDispatchSetEqualityV1,
  bootstrapStoreSpecChildProcess,
  parseStoreSpecChildModeForEntrypointV1,
  type StoreSpecChildProtocolSessionV1,
  type StoreSpecChildModeForEntrypointV1,
} from './finding-registry-store-child.fixture-protocol';

class StoreSpecLockFixtureViolationV1 extends Error {
  readonly code = 'STORE_SPEC_LOCK_FIXTURE_VIOLATION_V1' as const;

  constructor(message: string) {
    super(message);
    this.name = 'StoreSpecLockFixtureViolationV1';
  }
}

function requiredArgument(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`Finding registry lock fixture requires ${label}`);
  }
  return value;
}

async function runKernelLockHolder(
  resourcePath: string,
  session: StoreSpecChildProtocolSessionV1,
): Promise<void> {
  await testOnlyWithRegistryFileLockAsync(
    resourcePath,
    async () => {
      await session.emitPhase('LOCK_ACQUIRED');
    },
    { timeoutMs: 5_000, pollIntervalMs: 10 },
  );
  await session.emitPhase('LOCK_RELEASED');
}

async function runKernelLockContender(
  resourcePath: string,
  session: StoreSpecChildProtocolSessionV1,
): Promise<void> {
  try {
    testOnlyWithRegistryFileLock(
      resourcePath,
      () => {
        throw new Error('Kernel-lock contender entered while the owner barrier was closed');
      },
      { timeoutMs: 100, pollIntervalMs: 10 },
    );
    throw new StoreSpecLockFixtureViolationV1(
      'Kernel-lock contender was admitted while the owner barrier remained closed',
    );
  } catch (error) {
    if (!(error instanceof RegistryLockError) || error.code !== 'LOCK_TIMEOUT') throw error;
  }
  await session.emitPhase('CONTENTION_CONFIRMED');
  await session.emitPhase('BLOCKING_ACQUIRE_STARTED');
  await testOnlyWithRegistryFileLockAsync(
    resourcePath,
    async () => {
      await session.emitPhase('LOCK_ACQUIRED');
    },
    {
      timeoutMs: 5_000,
      pollIntervalMs: 10,
    },
  );
  await session.emitPhase('LOCK_RELEASED');
}

type StoreSpecLockFixtureModeV1 = StoreSpecChildModeForEntrypointV1<'LOCK_FIXTURE'>;
type StoreSpecLockFixtureHandlerV1 = (
  resourcePath: string,
  session: StoreSpecChildProtocolSessionV1,
) => Promise<void>;

const STORE_SPEC_LOCK_FIXTURE_DISPATCH_V1 = Object.freeze({
  '--kernel-lock-contender': runKernelLockContender,
  '--kernel-lock-holder': runKernelLockHolder,
} satisfies Record<StoreSpecLockFixtureModeV1, StoreSpecLockFixtureHandlerV1>);

assertStoreSpecEntrypointDispatchSetEqualityV1('LOCK_FIXTURE', STORE_SPEC_LOCK_FIXTURE_DISPATCH_V1);

async function main(): Promise<void> {
  const fixtureMode = parseStoreSpecChildModeForEntrypointV1('LOCK_FIXTURE', process.argv[2]);
  const resourcePath = requiredArgument(3, 'resource path');
  const session = await bootstrapStoreSpecChildProcess(fixtureMode);
  await STORE_SPEC_LOCK_FIXTURE_DISPATCH_V1[fixtureMode](resourcePath, session);
  session.assertTerminal();
  process.exitCode = 0;
  if (process.connected) process.disconnect();
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
