import { generateKeyPairSync, KeyObject } from 'node:crypto';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';

export interface ExecutionTestSigner {
  readonly principalId: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

export const createExecutionTestSigner = (
  principalId = 'execution-attestor-1',
): ExecutionTestSigner => ({ principalId, ...generateKeyPairSync('ed25519') });

export const trustedExecutionSigner = createExecutionTestSigner();
export const attackerExecutionSigner = createExecutionTestSigner('execution-attacker-1');

export function executionTrustRootBytes(
  signer: ExecutionTestSigner = trustedExecutionSigner,
  capability = 'ATTEST_EXECUTION',
  extra: Readonly<Record<string, unknown>> = {},
  keyExtra: Readonly<Record<string, unknown>> = {},
): Buffer {
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-execution-trust-root-v1',
    keys: [
      {
        principal_id: signer.principalId,
        capability,
        execution_session_id: 'execution-session-s01-0001',
        status: 'ACTIVE',
        valid_from: '2026-09-02T12:00:00.000Z',
        valid_until: '2026-09-02T14:00:00.000Z',
        revocation_epoch: 1,
        public_key_spki_der_base64: signer.publicKey
          .export({ format: 'der', type: 'spki' })
          .toString('base64'),
        ...keyExtra,
      },
    ],
    ...extra,
  });
}

export const executionPrivateKeyBytes = (
  signer: ExecutionTestSigner = trustedExecutionSigner,
): Buffer => signer.privateKey.export({ format: 'der', type: 'pkcs8' });
