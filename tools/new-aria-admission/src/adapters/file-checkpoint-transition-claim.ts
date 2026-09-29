import type { EvidenceCheckpointRequest } from '../application/evidence-checkpoint';
import { canonicalJsonBytes } from '../kernel/canonical-json';

import {
  readCheckpointFile,
  recoverCheckpointFilePublication,
  writeNewCheckpointFile,
} from './file-checkpoint-directory-io';
import type { CheckpointDirectoryAccess } from './file-checkpoint-directory-io';

export type CheckpointTransitionClaimResult = 'CLAIMED' | 'RECOVERABLE' | 'CONFLICT';

function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const { code } = error as { readonly code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function claimBytes(scopeSha256: string, request: EvidenceCheckpointRequest): Buffer {
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-checkpoint-transition-claim-v1',
    scope_sha256: scopeSha256,
    valid_from: request.valid_from,
    valid_until: request.valid_until,
    expected: request.expected,
    next: request.next,
  });
}

export function checkpointTransitionClaimName(scopeSha256: string): string {
  if (!/^[a-f0-9]{64}$/u.test(scopeSha256)) {
    throw new TypeError('checkpoint transition claim scope is invalid');
  }
  return `${scopeSha256}.claim`;
}

export function verifyCheckpointTransitionClaim(
  directory: string | CheckpointDirectoryAccess,
  scopeSha256: string,
  request: EvidenceCheckpointRequest,
): boolean {
  const name = checkpointTransitionClaimName(scopeSha256);
  const expectedBytes = claimBytes(scopeSha256, request);
  try {
    recoverCheckpointFilePublication(directory, name, expectedBytes, false);
    return readCheckpointFile(directory, name, 128 * 1024).equals(expectedBytes);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export function claimCheckpointTransition(
  directory: string | CheckpointDirectoryAccess,
  scopeSha256: string,
  request: EvidenceCheckpointRequest,
): CheckpointTransitionClaimResult {
  if (
    !/^[a-f0-9]{64}$/u.test(scopeSha256) ||
    !Number.isSafeInteger(request.next.version) ||
    request.next.version < 1 ||
    request.next.version > 9_999_999_999
  ) {
    throw new TypeError('checkpoint transition claim identity is invalid');
  }
  const name = checkpointTransitionClaimName(scopeSha256);
  const expectedBytes = claimBytes(scopeSha256, request);
  const recovery = recoverCheckpointFilePublication(directory, name, expectedBytes, true);
  if (recovery !== 'NONE') return 'RECOVERABLE';
  try {
    writeNewCheckpointFile(directory, name, expectedBytes);
    return 'CLAIMED';
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  return verifyCheckpointTransitionClaim(directory, scopeSha256, request)
    ? 'RECOVERABLE'
    : 'CONFLICT';
}
