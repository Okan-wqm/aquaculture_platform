import type { HistoricallyVerifiedS01ProgressAuthority } from '../kernel/operator-progress-authority';

import { readCanonicalFile } from './canonical-files';
import type { CompletionAdmissionDescriptor } from './completion-admission-request';
import { loadRepositoryTargetRequest } from './repository-target-request';
import { assertRepositoryTargetRequestAuthority } from './verifier-invocation-authority';

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const { code } = error as { readonly code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

export interface CompletionRecoveryTarget {
  readonly bytes: Buffer;
  readonly request: ReturnType<typeof loadRepositoryTargetRequest>;
}

export function loadCompletionRecoveryTarget(
  descriptor: CompletionAdmissionDescriptor,
  authority: HistoricallyVerifiedS01ProgressAuthority,
): CompletionRecoveryTarget | undefined {
  let bytes: Buffer;
  try {
    bytes = readCanonicalFile(descriptor.target_request_path, 'repository target request');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  }
  const request = loadRepositoryTargetRequest(bytes);
  assertRepositoryTargetRequestAuthority(authority, request, descriptor.git_sha256);
  return Object.freeze({ bytes, request });
}
