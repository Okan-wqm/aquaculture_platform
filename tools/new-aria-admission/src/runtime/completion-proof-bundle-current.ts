import {
  FileCurrentEpochProvider,
  readCurrentEpochSnapshot,
} from '../adapters/file-current-epoch-provider';
import { FileEvidenceCheckpointStore } from '../adapters/file-evidence-checkpoint-store';
import { recoverCommittedCompletionProjection } from '../application/completion-publication-recovery';
import { revalidateExecutableRepositoryTarget } from '../application/repository-target-verifier';
import type { VerifiedRepositoryTarget } from '../application/repository-target-verifier';
import type {
  AuthorizedS01ProgressAuthority,
  HistoricallyVerifiedS01ProgressAuthority,
} from '../kernel/operator-progress-authority';

import { assertCompletionProofBundleCommit } from './completion-proof-bundle-promotion';
import type { VerifiedCompletionProofBundle } from './completion-proof-bundle-verifier';

export interface CurrentlyVerifiedCompletionProofBundle
  extends Omit<VerifiedCompletionProofBundle, 'contract_id' | 'current'> {
  readonly contract_id: 'new-aria-currently-verified-completion-proof-bundle-v1';
  readonly current: true;
  readonly current_verdict: 'CURRENT';
}

const currentBundles = new WeakSet<object>();

export interface CurrentCompletionBundleInput {
  readonly proof: VerifiedCompletionProofBundle;
  readonly current_authority: AuthorizedS01ProgressAuthority;
  readonly historical_authority: HistoricallyVerifiedS01ProgressAuthority;
  readonly target: VerifiedRepositoryTarget;
  readonly checkpoint_root: string;
  readonly current_epoch_root: string;
  readonly operator_trust_root_bytes: Uint8Array;
  readonly operator_trust_root_sha256: string;
}

function assertCurrentWindow(
  proof: Pick<VerifiedCompletionProofBundle, 'valid_from' | 'valid_until'>,
  now: number,
): void {
  if (
    !Number.isSafeInteger(now) ||
    now < Date.parse(proof.valid_from) ||
    now > Date.parse(proof.valid_until)
  )
    throw new TypeError('completion proof bundle is not currently valid');
}

export function observeCurrentCompletionWindow<T>(
  proof: Pick<VerifiedCompletionProofBundle, 'valid_from' | 'valid_until'>,
  operation: () => T,
): T {
  const startedAt = Date.now();
  assertCurrentWindow(proof, startedAt);
  const result = operation();
  const finishedAt = Date.now();
  if (finishedAt < startedAt) throw new TypeError('completion verification clock rolled back');
  assertCurrentWindow(proof, finishedAt);
  return result;
}

export function assertCurrentCompletionProofBundle(
  input: CurrentCompletionBundleInput,
): CurrentlyVerifiedCompletionProofBundle {
  const checkpointStore = new FileEvidenceCheckpointStore(input.checkpoint_root);
  try {
    const recovered = recoverCommittedCompletionProjection({
      authority: input.historical_authority,
      checkpoint_store: checkpointStore,
    });
    if (recovered === null) {
      throw new TypeError('completion bundle has no committed checkpoint tip');
    }
    assertCompletionProofBundleCommit(input.proof, recovered);
  } finally {
    checkpointStore.close();
  }
  const provider = new FileCurrentEpochProvider({
    state_root: input.current_epoch_root,
    provider_id: input.current_authority.authority.document.invalidation_epoch_provider_id,
    operator_trust_root_bytes: input.operator_trust_root_bytes,
    expected_operator_trust_root_sha256: input.operator_trust_root_sha256,
  });
  try {
    const before = readCurrentEpochSnapshot(provider, input.current_authority);
    if (
      before.provider_identity_sha256 !== input.proof.current_epoch_provider_identity_sha256 ||
      before.sha256 !== input.proof.current_epoch_snapshot_sha256 ||
      before.revision !== input.proof.current_epoch_revision
    )
      throw new TypeError('completion proof bundle was invalidated by the current epoch');
    observeCurrentCompletionWindow(input.proof, () => {
      revalidateExecutableRepositoryTarget(input.target);
      const after = readCurrentEpochSnapshot(provider, input.current_authority);
      if (
        before.sha256 !== after.sha256 ||
        before.revision !== after.revision ||
        after.sha256 !== input.proof.current_epoch_snapshot_sha256
      )
        throw new TypeError('completion epoch changed during bundle verification');
    });
  } finally {
    provider.close();
  }
  const result: CurrentlyVerifiedCompletionProofBundle = Object.freeze({
    ...input.proof,
    contract_id: 'new-aria-currently-verified-completion-proof-bundle-v1',
    current: true,
    current_verdict: 'CURRENT',
  });
  currentBundles.add(result);
  return result;
}

export function assertCurrentlyVerifiedCompletionProofBundle(
  value: unknown,
): asserts value is CurrentlyVerifiedCompletionProofBundle {
  if (value === null || typeof value !== 'object' || !currentBundles.has(value)) {
    throw new TypeError('current completion proof bundle was not verifier-issued');
  }
}
