import type { ProgressAuthorityDocument } from '../src/domain/progress-contracts';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { authorizeS01ProgressAuthority } from '../src/kernel/operator-progress-authority';

import { trustRootBytes, trustRootDocument } from './attestation-fixture';
import { executionTrustRootBytes, trustedExecutionSigner } from './execution-key-fixture';
import {
  digest,
  operatorEnvelopeBytes,
  operatorTrustRootBytes,
  s01ProgressAuthorityBytes,
} from './operator-authority-fixture';

export {
  attackerExecutionSigner,
  createExecutionTestSigner,
  executionPrivateKeyBytes,
  executionTrustRootBytes,
  trustedExecutionSigner,
} from './execution-key-fixture';
export type { ExecutionTestSigner } from './execution-key-fixture';

export function evidenceRootUsingExecutionKey(signer = trustedExecutionSigner): Buffer {
  const document = trustRootDocument();
  return canonicalJsonBytes({
    ...document,
    keys: document.keys.map((key) =>
      key.capability === 'PRODUCE'
        ? {
            ...key,
            public_key_spki_der_base64: signer.publicKey
              .export({ format: 'der', type: 'spki' })
              .toString('base64'),
          }
        : key,
    ),
  });
}

export function authorizedExecutionAuthority(
  overrides: Partial<ProgressAuthorityDocument> = {},
  window: Readonly<{
    observed_at: string;
    valid_until: string;
  }> = {
    observed_at: '2026-09-02T12:00:00.000Z',
    valid_until: '2026-09-02T14:00:00.000Z',
  },
): ReturnType<typeof authorizeS01ProgressAuthority> {
  const executionRoot = executionTrustRootBytes();
  const evidenceRoot = trustRootBytes();
  const authorityBytes = s01ProgressAuthorityBytes({
    execution_trust_root_sha256: digest(executionRoot),
    evidence_trust_root_sha256: digest(evidenceRoot),
    execution_session_id: 'execution-session-s01-0001',
    ...overrides,
  });
  const operatorRoot = operatorTrustRootBytes();
  return authorizeS01ProgressAuthority({
    envelope_bytes: operatorEnvelopeBytes({
      authorityBytes,
      observedAt: window.observed_at,
      validUntil: window.valid_until,
    }),
    trust_root_bytes: operatorRoot,
    expected_trust_root_sha256: digest(operatorRoot),
  });
}
