import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import type { EvidenceTip } from '../application/evidence-checkpoint';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import { parseStrictJson } from '../kernel/strict-json';

import {
  readCheckpointFile,
  recoverCheckpointFilePublication,
} from './file-checkpoint-directory-io';
import type { CheckpointDirectoryAccess } from './file-checkpoint-directory-io';
import { parseStoredCheckpointTip } from './file-checkpoint-record';
import { checkpointTransitionClaimName } from './file-checkpoint-transition-claim';
import { boundedDirectoryEntryNames } from './bounded-directory-entries';

export interface HistoricalCheckpointIdentity {
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly version: number;
}

const recordTemp =
  /^\.([a-f0-9]{64})-([0-9]{10})-([a-f0-9]{64})\.json\.[0-9]+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;
const claimKeys = [
  'contract_id',
  'expected',
  'next',
  'schema_version',
  'scope_sha256',
  'valid_from',
  'valid_until',
] as const;

function readFinal(
  directory: CheckpointDirectoryAccess,
  name: string,
  maximumBytes: number,
): { readonly bytes: Buffer; readonly linked: boolean } {
  const links = lstatSync(join(directory.descriptor_path, name)).nlink;
  if (links !== 1 && links !== 2) throw new TypeError('checkpoint final link count is invalid');
  const bytes = readCheckpointFile(directory, name, maximumBytes, links);
  return { bytes, linked: links === 2 };
}

function assertClaim(bytes: Uint8Array, scope: string, tip: EvidenceTip): void {
  const value = parseStrictJson(bytes);
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...claimKeys].sort()) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-checkpoint-transition-claim-v1' ||
    value.scope_sha256 !== scope ||
    value.expected !== null ||
    typeof value.valid_from !== 'string' ||
    typeof value.valid_until !== 'string' ||
    !canonicalJsonBytes(value.next).equals(canonicalJsonBytes(tip)) ||
    !canonicalJsonBytes(value).equals(bytes)
  )
    throw new TypeError('historical checkpoint transition claim is invalid');
  const validFrom = Date.parse(value.valid_from);
  const validUntil = Date.parse(value.valid_until);
  if (
    !Number.isFinite(validFrom) ||
    new Date(validFrom).toISOString() !== value.valid_from ||
    !Number.isFinite(validUntil) ||
    new Date(validUntil).toISOString() !== value.valid_until ||
    validFrom > validUntil
  )
    throw new TypeError('historical checkpoint transition validity is invalid');
}

export function recoverLinkedCheckpointClaim(
  directory: CheckpointDirectoryAccess,
  scope: string,
  tip: EvidenceTip,
): void {
  const claimName = checkpointTransitionClaimName(scope);
  const prefix = `.${claimName}.`;
  const names = boundedDirectoryEntryNames(
    directory.descriptor_path,
    4_096,
    'checkpoint directory',
  );
  const matches = names.filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'));
  if (matches.length === 0) return;
  if (matches.length !== 1) throw new TypeError('historical checkpoint claim temp is ambiguous');
  const claim = readFinal(directory, claimName, 128 * 1024);
  if (!claim.linked) throw new TypeError('historical checkpoint claim temp is not linked');
  assertClaim(claim.bytes, scope, tip);
  recoverCheckpointFilePublication(directory, claimName, claim.bytes, false);
}

export function recoverLinkedFinalCheckpoint(
  directory: CheckpointDirectoryAccess,
  scope: string,
  identity: HistoricalCheckpointIdentity,
): void {
  const names = boundedDirectoryEntryNames(
    directory.descriptor_path,
    4_096,
    'checkpoint directory',
  );
  const matches = names.flatMap((name) => {
    const match = recordTemp.exec(name);
    return match?.[1] === scope ? [{ match, name }] : [];
  });
  if (matches.length === 0) return;
  if (matches.length !== 1) throw new TypeError('historical checkpoint temp roster is ambiguous');
  const match = matches[0]?.match;
  const versionText = match?.[2];
  const manifestSha256 = match?.[3];
  if (versionText === undefined || manifestSha256 === undefined) {
    throw new TypeError('historical checkpoint temp identity is invalid');
  }
  const version = Number(versionText);
  if (version !== identity.version) return;
  const finalName = `${scope}-${versionText}-${manifestSha256}.json`;
  let finalLinks: number;
  try {
    finalLinks = lstatSync(join(directory.descriptor_path, finalName)).nlink;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (finalLinks !== 2) {
    throw new TypeError('historical checkpoint temp is not the linked final inode');
  }
  const recordBytes = readCheckpointFile(directory, finalName, 128 * 1024, 2);
  const tip = parseStoredCheckpointTip(recordBytes, version, manifestSha256);
  if (
    tip.authority_sha256 !== identity.authority_sha256 ||
    tip.evidence_id !== identity.evidence_id
  )
    throw new TypeError('historical checkpoint temp differs from requested identity');
  const claimName = checkpointTransitionClaimName(scope);
  const claim = readFinal(directory, claimName, 128 * 1024);
  assertClaim(claim.bytes, scope, tip);
  if (claim.linked) recoverCheckpointFilePublication(directory, claimName, claim.bytes, false);
  recoverCheckpointFilePublication(directory, finalName, recordBytes, false);
}
