import {
  verifyCurrentEpochSnapshot,
  type VerifiedCurrentEpochSnapshot,
} from '../kernel/current-epoch-provider';
import { ImmutableStringMap } from '../kernel/immutable-string-map';
import type { AuthorizedS01ProgressAuthority } from '../kernel/operator-progress-authority';
import { loadOperatorProgressTrustKeys } from '../kernel/operator-progress-trust-root';

import { readCheckpointFile } from './file-checkpoint-directory-io';
import type { BoundCurrentEpochDirectory } from './file-current-epoch-binding';
import {
  bindCurrentEpochDirectory,
  closeBoundCurrentEpochDirectory,
  currentEpochSnapshotFileName,
  verifyBoundCurrentEpochDirectory,
} from './file-current-epoch-binding';
import { commitCurrentEpochState } from './file-current-epoch-state';

export interface CurrentEpochProviderSnapshot {
  readonly provider_identity_sha256: string;
  readonly sha256: string;
  readonly revision: number;
  readonly observed_at: string;
  readonly valid_until: string;
  readonly read_at: string;
  readonly epochs: ReadonlyMap<string, string>;
}

export interface FileCurrentEpochProviderInput {
  readonly state_root: string;
  readonly genesis_identity_bytes?: Uint8Array;
  readonly provider_id: string;
  readonly operator_trust_root_bytes: Uint8Array;
  readonly expected_operator_trust_root_sha256: string;
}

interface ProviderState {
  readonly binding: BoundCurrentEpochDirectory;
  readonly operatorTrustRootBytes: Buffer;
  readonly expectedOperatorTrustRootSha256: string;
}

const providerStates = new WeakMap<object, ProviderState>();

export class FileCurrentEpochProvider {
  constructor(input: FileCurrentEpochProviderInput) {
    if (!(input.operator_trust_root_bytes instanceof Uint8Array)) {
      throw new TypeError('current epoch operator trust root must be bytes');
    }
    if (
      typeof SharedArrayBuffer !== 'undefined' &&
      input.operator_trust_root_bytes.buffer instanceof SharedArrayBuffer
    ) {
      throw new TypeError('current epoch operator trust root cannot use shared memory');
    }
    const binding = bindCurrentEpochDirectory(input.state_root, input.genesis_identity_bytes);
    try {
      const keys = loadOperatorProgressTrustKeys(
        input.operator_trust_root_bytes,
        input.expected_operator_trust_root_sha256,
      );
      const identity = binding.identity;
      if (
        identity.provider_id !== input.provider_id ||
        identity.operator_trust_root_sha256 !== input.expected_operator_trust_root_sha256 ||
        !keys.some(
          (key) =>
            key.principalId === identity.signer_principal_id &&
            key.keySha256 === identity.signer_key_sha256,
        )
      ) {
        throw new TypeError('current epoch store identity does not match operator trust root');
      }
      providerStates.set(this, {
        binding,
        operatorTrustRootBytes: Buffer.from(input.operator_trust_root_bytes),
        expectedOperatorTrustRootSha256: input.expected_operator_trust_root_sha256,
      });
    } catch (error) {
      closeBoundCurrentEpochDirectory(binding);
      throw error;
    }
    Object.freeze(this);
  }

  close(): void {
    const state = providerStates.get(this);
    if (state === undefined) return;
    closeBoundCurrentEpochDirectory(state.binding);
    providerStates.delete(this);
  }
}

function stateFor(value: unknown): ProviderState {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('current epoch provider is not a trusted file adapter');
  }
  const state = providerStates.get(value);
  if (state === undefined) {
    throw new TypeError('current epoch provider is not a trusted file adapter');
  }
  return state;
}

function immutableSnapshot(
  value: VerifiedCurrentEpochSnapshot,
  providerIdentitySha256: string,
  readAt: string,
): CurrentEpochProviderSnapshot {
  return Object.freeze({
    provider_identity_sha256: providerIdentitySha256,
    sha256: value.sha256,
    revision: value.revision,
    observed_at: value.observed_at,
    valid_until: value.valid_until,
    read_at: readAt,
    epochs: new ImmutableStringMap(value.epochs),
  });
}

export function assertTrustedCurrentEpochProvider(
  value: unknown,
): asserts value is FileCurrentEpochProvider {
  verifyBoundCurrentEpochDirectory(stateFor(value).binding);
}

export function readCurrentEpochSnapshot(
  provider: FileCurrentEpochProvider,
  authority: AuthorizedS01ProgressAuthority,
): CurrentEpochProviderSnapshot {
  const state = stateFor(provider);
  verifyBoundCurrentEpochDirectory(state.binding);
  if (
    state.binding.identity.signer_principal_id !== authority.signer_principal_id ||
    state.binding.identity.signer_key_sha256 !== authority.signer_key_sha256
  ) {
    throw new TypeError('current epoch provider identity does not match authority signer');
  }
  const snapshotBytes = readCheckpointFile(state.binding, currentEpochSnapshotFileName, 64 * 1024);
  const now = Date.now();
  const snapshot = verifyCurrentEpochSnapshot({
    snapshot_bytes: snapshotBytes,
    operator_trust_root_bytes: state.operatorTrustRootBytes,
    expected_operator_trust_root_sha256: state.expectedOperatorTrustRootSha256,
    provider_id: state.binding.identity.provider_id,
    provider_identity_sha256: state.binding.identity_sha256,
    authority,
    now,
  });
  verifyBoundCurrentEpochDirectory(state.binding);
  commitCurrentEpochState(state.binding, state.binding.identity_sha256, snapshot);
  verifyBoundCurrentEpochDirectory(state.binding);
  return immutableSnapshot(snapshot, state.binding.identity_sha256, new Date(now).toISOString());
}

Object.freeze(FileCurrentEpochProvider.prototype);
Object.freeze(FileCurrentEpochProvider);
