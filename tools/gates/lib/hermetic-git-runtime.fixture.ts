import { type BigIntStats } from 'node:fs';
import { type FileHandle } from 'node:fs/promises';

import { type HermeticExecutableExecutionPolicyV1 } from './anchored-filesystem';
import {
  testOnlyCloseHermeticGitDescriptors as closeHermeticGitDescriptors,
  testOnlyCreateHermeticGitRuntime as createHermeticGitRuntime,
  testOnlyFingerprintHermeticGitRegularFile as fingerprintHermeticGitRegularFile,
  type HermeticGitRuntimeV1,
} from './hermetic-git-runtime.kernel';

/** Closed test-only façade; the writer authority permits this module as the kernel's sole caller. */
export function testOnlyCreateHermeticGitRuntime(
  policy: HermeticExecutableExecutionPolicyV1,
): HermeticGitRuntimeV1 {
  return createHermeticGitRuntime(policy);
}

export function testOnlyCloseHermeticGitDescriptors(descriptors: readonly number[]): void {
  closeHermeticGitDescriptors(descriptors);
}

export function testOnlyFingerprintHermeticGitRegularFile(
  path: string,
  pathObservation: BigIntStats,
  closeHandle: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  return fingerprintHermeticGitRegularFile(path, pathObservation, closeHandle);
}
