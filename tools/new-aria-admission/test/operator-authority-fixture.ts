import { createHash, generateKeyPairSync, KeyObject, sign } from 'node:crypto';

import { ProgressAuthorityDocument } from '../src/domain/progress-contracts';
import { canonicalJsonBytes } from '../src/kernel/canonical-json';

import { progressAuthority } from './progress-fixture';

export interface TestOperatorSigner {
  readonly principalId: string;
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
}

export interface OperatorEnvelopeOptions {
  readonly authorityBytes?: Uint8Array;
  readonly authoritySha256?: string;
  readonly observedAt?: string;
  readonly validUntil?: string;
  readonly signer?: TestOperatorSigner;
  readonly capability?: string;
  readonly signatureBase64?: string;
  readonly duplicateSignature?: boolean;
  readonly payloadExtra?: Readonly<Record<string, unknown>>;
  readonly signatureExtra?: Readonly<Record<string, unknown>>;
  readonly envelopeExtra?: Readonly<Record<string, unknown>>;
}

export interface OperatorTrustRootOptions {
  readonly signers?: readonly TestOperatorSigner[];
  readonly capability?: string;
  readonly rootExtra?: Readonly<Record<string, unknown>>;
  readonly keyExtra?: Readonly<Record<string, unknown>>;
}

const createSigner = (principalId: string): TestOperatorSigner => {
  const keys = generateKeyPairSync('ed25519');
  return { principalId, publicKey: keys.publicKey, privateKey: keys.privateKey };
};

export const trustedOperatorSigner = createSigner('operator-progress-1');
export const attackerOperatorSigner = createSigner('operator-attacker-1');
export const duplicatePrincipalSigner = createSigner('operator-progress-1');

export const s01FindingIds: readonly string[] = [
  'ARIA-AUDIT-001',
  'ARIA-AUDIT-002',
  'ARIA-AUDIT-003',
  'ARIA-AUDIT-004',
  'ARIA-AUDIT-005',
  'ARIA-AUDIT-006',
  'ARIA-AUDIT-007',
  'ARIA-AUDIT-008',
  'ARIA-AUDIT-009',
  'ARIA-AUDIT-010',
  'ARIA-AUDIT-026',
  'ARIA-AUDIT-066',
  'ARIA-AUDIT-067',
  'ARIA-AUDIT-081',
];

export const digest = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

export const signerPublicKeyDigest = (signer: TestOperatorSigner): string =>
  digest(signer.publicKey.export({ format: 'der', type: 'spki' }));

const encodedPublicKey = (key: KeyObject): string =>
  key.export({ format: 'der', type: 'spki' }).toString('base64');

export function s01ProgressAuthority(
  overrides: Partial<ProgressAuthorityDocument> = {},
): ProgressAuthorityDocument {
  return {
    ...progressAuthority(),
    acceptance_ids: ['ACC-EVD-001', 'ACC-S01'],
    finding_ids: s01FindingIds,
    ...overrides,
  };
}

export const s01ProgressAuthorityBytes = (
  overrides: Partial<ProgressAuthorityDocument> = {},
): Buffer => canonicalJsonBytes(s01ProgressAuthority(overrides));

export function operatorTrustRootBytes(options: OperatorTrustRootOptions = {}): Buffer {
  const signers = options.signers ?? [trustedOperatorSigner];
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-operator-progress-trust-root-v1',
    keys: signers.map((signer) => ({
      principal_id: signer.principalId,
      capability: options.capability ?? 'AUTHORIZE_PROGRESS',
      public_key_spki_der_base64: encodedPublicKey(signer.publicKey),
      ...options.keyExtra,
    })),
    ...options.rootExtra,
  });
}

export function operatorEnvelopeBytes(options: OperatorEnvelopeOptions = {}): Buffer {
  const authorityBytes = options.authorityBytes ?? s01ProgressAuthorityBytes();
  const signer = options.signer ?? trustedOperatorSigner;
  const payload = {
    schema_version: '1.0.0',
    contract_id: 'new-aria-operator-progress-authority-payload-v1',
    signer_principal_id: signer.principalId,
    capability: options.capability ?? 'AUTHORIZE_PROGRESS',
    progress_authority_base64: Buffer.from(authorityBytes).toString('base64'),
    progress_authority_sha256: options.authoritySha256 ?? digest(authorityBytes),
    observed_at: options.observedAt ?? '2026-09-02T12:00:00.000Z',
    valid_until: options.validUntil ?? '2026-09-02T13:00:00.000Z',
    ...options.payloadExtra,
  };
  const signedBytes = canonicalJsonBytes(payload);
  const signature = {
    principal_id: signer.principalId,
    capability: options.capability ?? 'AUTHORIZE_PROGRESS',
    signature_base64:
      options.signatureBase64 ?? sign(null, signedBytes, signer.privateKey).toString('base64'),
    ...options.signatureExtra,
  };
  return canonicalJsonBytes({
    schema_version: '1.0.0',
    contract_id: 'new-aria-operator-progress-authority-envelope-v1',
    payload,
    signatures: options.duplicateSignature ? [signature, signature] : [signature],
    ...options.envelopeExtra,
  });
}
