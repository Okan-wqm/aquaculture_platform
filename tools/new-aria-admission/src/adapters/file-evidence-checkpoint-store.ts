import type {
  EvidenceCheckpointRequest,
  EvidenceCheckpointResult,
  EvidenceCheckpointStore,
} from '../application/evidence-checkpoint';
import { evidenceCheckpointScopeSha256 } from '../application/evidence-checkpoint';
import { canonicalJsonBytes } from '../kernel/canonical-json';
import type { CheckpointStoreIdentity } from '../kernel/checkpoint-store-identity';
import { requireIdentifier } from '../kernel/identifiers';

import { writeNewCheckpointFile } from './file-checkpoint-directory-io';
import {
  recoverLinkedCheckpointClaim,
  recoverLinkedFinalCheckpoint,
} from './file-checkpoint-historical-recovery';
import { recoverCheckpointPublication } from './file-checkpoint-publication-recovery';
import {
  checkpointProjectionArtifactBytes,
  readStoredCheckpointTip,
  sameCheckpointTip,
} from './file-checkpoint-record';
import {
  bindCheckpointDirectory,
  closeBoundCheckpointDirectory,
  verifyBoundCheckpointDirectory,
} from './file-checkpoint-store-binding';
import type { BoundCheckpointDirectory } from './file-checkpoint-store-binding';
import {
  claimCheckpointTransition,
  verifyCheckpointTransitionClaim,
} from './file-checkpoint-transition-claim';

export { checkpointIdentityFileName } from './file-checkpoint-store-binding';

const trustedStores = new WeakMap<object, BoundCheckpointDirectory>();

export function assertTrustedEvidenceCheckpointStore(
  value: EvidenceCheckpointStore,
): asserts value is FileEvidenceCheckpointStore {
  const binding = trustedStores.get(value);
  if (binding === undefined) {
    throw new TypeError('evidence checkpoint store is not a trusted checkpoint adapter');
  }
  verifyBoundCheckpointDirectory(binding);
}

export function checkpointStoreIdentityFor(
  value: EvidenceCheckpointStore,
): CheckpointStoreIdentity {
  assertTrustedEvidenceCheckpointStore(value);
  const binding = trustedStores.get(value);
  if (binding === undefined) throw new TypeError('checkpoint store identity is unavailable');
  return binding.identity;
}

export interface CommittedCheckpointProjectionQuery {
  readonly repository_id: string;
  readonly workspace_id: string;
  readonly program_id: string;
  readonly sprint_id: string;
  readonly authority_sha256: string;
  readonly evidence_id: string;
  readonly version: number;
}

export interface CommittedCheckpointProjection {
  readonly sha256: string;
  readonly bytes: Buffer;
  readonly manifest_sha256: string;
  readonly history_sha256: string;
}

export function recoverCommittedCheckpointProjection(
  store: EvidenceCheckpointStore,
  query: CommittedCheckpointProjectionQuery,
): CommittedCheckpointProjection | null {
  assertTrustedEvidenceCheckpointStore(store);
  const binding = trustedStores.get(store);
  if (binding === undefined) throw new TypeError('checkpoint store binding is unavailable');
  for (const [value, label] of [
    [query.repository_id, 'repository'],
    [query.workspace_id, 'workspace'],
    [query.program_id, 'program'],
    [query.sprint_id, 'sprint'],
    [query.evidence_id, 'evidence'],
  ] as const)
    requireIdentifier(value, `checkpoint recovery ${label} identifier`);
  if (
    !Number.isSafeInteger(query.version) ||
    query.version < 1 ||
    !/^[a-f0-9]{64}$/u.test(query.authority_sha256)
  )
    throw new TypeError('checkpoint recovery tip identity is invalid');
  const scope = evidenceCheckpointScopeSha256(query);
  recoverLinkedFinalCheckpoint(binding, scope, query);
  const tip = readStoredCheckpointTip(binding, scope);
  if (tip === null) return null;
  if (
    tip.authority_sha256 !== query.authority_sha256 ||
    tip.evidence_id !== query.evidence_id ||
    tip.version !== query.version
  )
    throw new TypeError('checkpoint recovery query differs from the immutable final tip');
  recoverLinkedCheckpointClaim(binding, scope, tip);
  const bytes = checkpointProjectionArtifactBytes(tip);
  verifyBoundCheckpointDirectory(binding);
  return Object.freeze({
    sha256: tip.projection_sha256,
    bytes: Buffer.from(bytes),
    manifest_sha256: tip.manifest_sha256,
    history_sha256: tip.history_sha256,
  });
}

export class FileEvidenceCheckpointStore implements EvidenceCheckpointStore {
  private readonly binding: BoundCheckpointDirectory;

  constructor(directory: string, genesisIdentityBytes?: Uint8Array) {
    this.binding = bindCheckpointDirectory(directory, genesisIdentityBytes);
    trustedStores.set(this, this.binding);
    Object.freeze(this);
  }

  compareAndSet(request: EvidenceCheckpointRequest): Promise<EvidenceCheckpointResult> {
    return Promise.resolve().then(() => this.compareAndSetBound(request));
  }

  close(): void {
    closeBoundCheckpointDirectory(this.binding);
    trustedStores.delete(this);
  }

  private compareAndSetBound(request: EvidenceCheckpointRequest): EvidenceCheckpointResult {
    verifyBoundCheckpointDirectory(this.binding);
    const directory = this.binding;
    const scope = evidenceCheckpointScopeSha256(request);
    recoverCheckpointPublication(directory, scope, request, false);
    const current = readStoredCheckpointTip(directory, scope);
    if (sameCheckpointTip(current, request.next)) {
      return verifyCheckpointTransitionClaim(directory, scope, request)
        ? 'ALREADY_COMMITTED'
        : 'CONFLICT';
    }
    const validFrom = Date.parse(request.valid_from);
    const validUntil = Date.parse(request.valid_until);
    const now = Date.now();
    if (
      !Number.isFinite(validFrom) ||
      new Date(validFrom).toISOString() !== request.valid_from ||
      !Number.isFinite(validUntil) ||
      new Date(validUntil).toISOString() !== request.valid_until ||
      validFrom > validUntil ||
      !Number.isSafeInteger(now) ||
      now < validFrom ||
      now > validUntil
    ) {
      return 'CONFLICT';
    }
    verifyBoundCheckpointDirectory(this.binding);
    if (!sameCheckpointTip(current, request.expected)) return 'CONFLICT';
    const freshNow = Date.now();
    if (
      !Number.isSafeInteger(freshNow) ||
      freshNow < now ||
      freshNow < validFrom ||
      freshNow > validUntil
    ) {
      return 'CONFLICT';
    }
    if (claimCheckpointTransition(directory, scope, request) === 'CONFLICT') {
      return 'CONFLICT';
    }
    recoverCheckpointPublication(directory, scope, request, true);
    verifyBoundCheckpointDirectory(this.binding);
    const resumed = readStoredCheckpointTip(directory, scope);
    if (sameCheckpointTip(resumed, request.next)) return 'ALREADY_COMMITTED';
    if (!sameCheckpointTip(resumed, request.expected)) return 'CONFLICT';
    const durableNow = Date.now();
    if (
      !Number.isSafeInteger(durableNow) ||
      durableNow < freshNow ||
      durableNow < validFrom ||
      durableNow > validUntil
    ) {
      return 'CONFLICT';
    }
    const version = request.next.version.toString().padStart(10, '0');
    const name = `${scope}-${version}-${request.next.manifest_sha256}.json`;
    try {
      writeNewCheckpointFile(directory, name, canonicalJsonBytes(request.next));
    } catch (error) {
      const code =
        error !== null && typeof error === 'object' && 'code' in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== 'EEXIST') throw error;
      return sameCheckpointTip(readStoredCheckpointTip(directory, scope), request.next)
        ? 'ALREADY_COMMITTED'
        : 'CONFLICT';
    }
    verifyBoundCheckpointDirectory(this.binding);
    return 'COMMITTED';
  }
}

Object.freeze(FileEvidenceCheckpointStore.prototype);
Object.freeze(FileEvidenceCheckpointStore);
