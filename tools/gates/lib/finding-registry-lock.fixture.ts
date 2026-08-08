#!/usr/bin/env ts-node

import { existsSync, writeFileSync } from 'node:fs';

import { RegistryLockError, withRegistryFileLock } from '../finding-registry-store';

function requiredArgument(index: number, label: string): string {
  const value = process.argv[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`Finding registry lock fixture requires ${label}`);
  }
  return value;
}

function runKernelLockHolder(): never {
  const resourcePath = requiredArgument(3, 'resource path');
  const readyPath = requiredArgument(4, 'ready barrier path');
  const releasePath = requiredArgument(5, 'release barrier path');
  withRegistryFileLock(
    resourcePath,
    () => {
      writeFileSync(readyPath, 'ready\n', 'utf8');
      const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      while (!existsSync(releasePath)) Atomics.wait(waitCell, 0, 0, 25);
    },
    { timeoutMs: 5_000, pollIntervalMs: 10 },
  );
  process.exit(0);
}

function runKernelLockContender(): never {
  const resourcePath = requiredArgument(3, 'resource path');
  const blockedPath = requiredArgument(4, 'blocked barrier path');
  const enteredPath = requiredArgument(5, 'entered barrier path');
  try {
    withRegistryFileLock(
      resourcePath,
      () => {
        throw new Error('Kernel-lock contender entered while the owner barrier was closed');
      },
      { timeoutMs: 100, pollIntervalMs: 10 },
    );
    process.exit(65);
  } catch (error) {
    if (!(error instanceof RegistryLockError) || error.code !== 'LOCK_TIMEOUT') throw error;
  }
  writeFileSync(blockedPath, 'blocked\n', 'utf8');
  withRegistryFileLock(resourcePath, () => writeFileSync(enteredPath, 'entered\n', 'utf8'), {
    timeoutMs: 5_000,
    pollIntervalMs: 10,
  });
  process.exit(0);
}

try {
  switch (process.argv[2]) {
    case '--kernel-lock-holder':
      runKernelLockHolder();
    case '--kernel-lock-contender':
      runKernelLockContender();
    default:
      throw new Error(`Unknown finding registry lock fixture mode: ${String(process.argv[2])}`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
}
