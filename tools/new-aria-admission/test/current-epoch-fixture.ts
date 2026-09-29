import { sign } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileCurrentEpochProvider } from '../src/adapters/file-current-epoch-provider';
import { currentEpochSnapshotFileName } from '../src/adapters/file-current-epoch-binding';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { currentEpochStoreIdentityBytes } from '../src/kernel/current-epoch-store-identity';
import type { AuthorizedS01ProgressAuthority } from '../src/kernel/operator-progress-authority';

import { digest, signerPublicKeyDigest, trustedOperatorSigner } from './operator-authority-fixture';

export const currentEpochProviderId = 'new-aria-s01-current-epochs';

export interface CurrentEpochStoreFixture {
  readonly root: string;
  readonly identity_bytes: Buffer;
  readonly authority: {
    readonly invalidation_epoch_provider_id: string;
    readonly invalidation_epoch_provider_identity_sha256: string;
  };
}

export function currentEpochStoreFixture(operatorTrustRoot: Uint8Array): CurrentEpochStoreFixture {
  const root = mkdtempSync(join(tmpdir(), 'new-aria-current-epochs-'));
  const identityBytes = currentEpochStoreIdentityBytes({
    provider_id: currentEpochProviderId,
    canonical_root: root,
    operator_trust_root_sha256: digest(operatorTrustRoot),
    signer_principal_id: trustedOperatorSigner.principalId,
    signer_key_sha256: signerPublicKeyDigest(trustedOperatorSigner),
  });
  return {
    root,
    identity_bytes: identityBytes,
    authority: {
      invalidation_epoch_provider_id: currentEpochProviderId,
      invalidation_epoch_provider_identity_sha256: digest(identityBytes),
    },
  };
}

export interface CurrentEpochSnapshotFixtureOptions {
  readonly revision?: number;
  readonly dependency_sha256?: string;
  readonly observed_at?: string;
  readonly valid_until?: string;
}

export function currentEpochSnapshotBytes(
  authority: AuthorizedS01ProgressAuthority,
  options: CurrentEpochSnapshotFixtureOptions = {},
): Buffer {
  const document = authority.authority.document;
  const payload = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-current-epoch-snapshot-payload-v1',
    provider_id: currentEpochProviderId,
    authority_sha256: authority.authority.sha256,
    signer_principal_id: trustedOperatorSigner.principalId,
    capability: 'ATTEST_CURRENT_EPOCHS',
    revision: options.revision ?? 1,
    observed_at: options.observed_at ?? '2026-09-02T12:15:00.000Z',
    valid_until: options.valid_until ?? authority.valid_until,
    invalidation_epochs: [
      { key: 'authority', epoch: `sha256:${authority.authority.sha256}` },
      {
        key: 'dependency',
        epoch: `sha256:${options.dependency_sha256 ?? document.dependency_sha256}`,
      },
      { key: 'policy', epoch: `sha256:${document.policy_epoch_sha256}` },
      { key: 'toolchain', epoch: `sha256:${document.toolchain_sha256}` },
      { key: 'verifier', epoch: `sha256:${document.verifier_sha256}` },
    ],
  };
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-current-epoch-snapshot-envelope-v1',
    payload,
    signature: {
      principal_id: trustedOperatorSigner.principalId,
      capability: 'ATTEST_CURRENT_EPOCHS',
      signature_base64: sign(
        null,
        canonicalJsonBytes(payload),
        trustedOperatorSigner.privateKey,
      ).toString('base64'),
    },
  });
}

export interface CurrentEpochProviderFixture {
  readonly provider: FileCurrentEpochProvider;
  readonly root: string;
  readonly snapshot_path: string;
  readonly writeSnapshot: (options?: CurrentEpochSnapshotFixtureOptions) => void;
}

export function currentEpochProviderFixture(
  authority: AuthorizedS01ProgressAuthority,
  operatorTrustRoot: Uint8Array,
  store: CurrentEpochStoreFixture,
): CurrentEpochProviderFixture {
  const snapshotPath = join(store.root, currentEpochSnapshotFileName);
  const provider = new FileCurrentEpochProvider({
    state_root: store.root,
    genesis_identity_bytes: store.identity_bytes,
    provider_id: currentEpochProviderId,
    operator_trust_root_bytes: operatorTrustRoot,
    expected_operator_trust_root_sha256: digest(operatorTrustRoot),
  });
  const writeSnapshot = (options: CurrentEpochSnapshotFixtureOptions = {}): void => {
    writeFileSync(snapshotPath, currentEpochSnapshotBytes(authority, options), { mode: 0o600 });
  };
  writeSnapshot();
  return {
    provider,
    root: store.root,
    snapshot_path: snapshotPath,
    writeSnapshot,
  };
}
