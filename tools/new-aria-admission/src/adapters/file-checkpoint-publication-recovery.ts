import type { EvidenceCheckpointRequest } from '../application/evidence-checkpoint';
import { canonicalJsonBytes } from '../kernel/canonical-json';

import {
  inspectCheckpointFilePublication,
  recoverCheckpointFilePublication,
  type CheckpointDirectoryAccess,
} from './file-checkpoint-directory-io';
import { verifyCheckpointTransitionClaim } from './file-checkpoint-transition-claim';
import { boundedDirectoryEntryNames } from './bounded-directory-entries';

const temporary =
  /^\.([a-f0-9]{64})-([0-9]{10})-([a-f0-9]{64})\.json\.([0-9]+)\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/u;
export function recoverCheckpointPublication(
  directory: CheckpointDirectoryAccess,
  scopeSha256: string,
  request: EvidenceCheckpointRequest,
  allowPending: boolean,
): 'NONE' | 'PENDING' | 'RECOVERED' {
  const names = boundedDirectoryEntryNames(
    directory.descriptor_path,
    4_096,
    'checkpoint directory',
  );
  const matches = names.flatMap((name) => {
    const match = temporary.exec(name);
    return match?.[1] === scopeSha256 ? [{ match, name }] : [];
  });
  if (matches.length === 0) return 'NONE';
  if (matches.length !== 1) throw new TypeError('checkpoint publication has ambiguous temp files');
  const entry = matches[0];
  if (entry === undefined) throw new TypeError('checkpoint publication temp is unavailable');
  const { match } = entry;
  const versionText = match[2];
  const manifestSha256 = match[3];
  if (versionText === undefined || manifestSha256 === undefined) {
    throw new TypeError('checkpoint publication temp identity is invalid');
  }
  const finalName = `${scopeSha256}-${versionText}-${manifestSha256}.json`;
  const expectedName =
    `${scopeSha256}-${request.next.version.toString().padStart(10, '0')}` +
    `-${request.next.manifest_sha256}.json`;
  if (finalName !== expectedName) {
    throw new TypeError('checkpoint publication temp differs from requested transition');
  }
  const expectedBytes = canonicalJsonBytes(request.next);
  const state = inspectCheckpointFilePublication(directory, finalName, expectedBytes);
  if (state === 'NONE') {
    throw new TypeError('checkpoint publication temp changed during recovery');
  }
  if (state === 'PENDING' && !allowPending) return 'PENDING';
  if (!verifyCheckpointTransitionClaim(directory, scopeSha256, request)) {
    throw new TypeError('checkpoint publication claim is invalid');
  }
  recoverCheckpointFilePublication(directory, finalName, expectedBytes, allowPending);
  return 'RECOVERED';
}
