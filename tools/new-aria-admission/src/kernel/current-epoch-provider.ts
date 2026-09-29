import { verify } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json';
import { digestBytes, hasExactKeys, isJsonRecord, requiredText } from './evidence-object';
import { decodeCanonicalBase64 } from './evidence-trust-root';
import type {
  AuthorizedS01ProgressAuthority,
  HistoricallyVerifiedS01ProgressAuthority,
  VerifiedS01ProgressAuthority,
} from './operator-progress-authority';
import {
  assertAuthorizedS01ProgressAuthority,
  assertHistoricallyVerifiedS01ProgressAuthority,
} from './operator-progress-authority';
import {
  loadOperatorProgressTrustKeys,
  parseCanonicalOperatorRecord,
} from './operator-progress-trust-root';

export interface VerifiedCurrentEpochSnapshot {
  readonly sha256: string;
  readonly revision: number;
  readonly observed_at: string;
  readonly valid_until: string;
  readonly epochs: readonly (readonly [string, string])[];
}

export interface CurrentEpochSnapshotVerificationInput {
  readonly snapshot_bytes: Uint8Array;
  readonly operator_trust_root_bytes: Uint8Array;
  readonly expected_operator_trust_root_sha256: string;
  readonly provider_id: string;
  readonly provider_identity_sha256: string;
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly now: number;
}

export interface HistoricalCurrentEpochSnapshotVerificationInput
  extends Omit<CurrentEpochSnapshotVerificationInput, 'authority' | 'now'> {
  readonly authority: HistoricallyVerifiedS01ProgressAuthority;
  readonly receipt_epoch_read_at: string;
}

type EpochSnapshotVerificationInput = Omit<CurrentEpochSnapshotVerificationInput, 'authority'> & {
  readonly authority: VerifiedS01ProgressAuthority;
};

const envelopeKeys = ['schema_version', 'contract_id', 'payload', 'signature'];
const payloadKeys = [
  'schema_version',
  'contract_id',
  'provider_id',
  'authority_sha256',
  'signer_principal_id',
  'capability',
  'revision',
  'observed_at',
  'valid_until',
  'invalidation_epochs',
];
const signatureKeys = ['principal_id', 'capability', 'signature_base64'];
const epochKeys = ['authority', 'dependency', 'policy', 'toolchain', 'verifier'] as const;
const exactUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const prefixedSha256 = /^sha256:[a-f0-9]{64}$/u;

function timestamp(value: unknown, label: string): [string, number] {
  const text = requiredText(value, label);
  const milliseconds = Date.parse(text);
  if (
    !exactUtc.test(text) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== text
  ) {
    throw new TypeError(`${label} is not canonical UTC`);
  }
  return [text, milliseconds];
}

function epochEntries(
  value: unknown,
  authoritySha256: string,
): readonly (readonly [string, string])[] {
  if (!Array.isArray(value) || value.length !== epochKeys.length) {
    throw new TypeError('current epoch snapshot requires the exact epoch roster');
  }
  const entries = value.map((item, index): readonly [string, string] => {
    const expectedKey = epochKeys[index];
    if (
      expectedKey === undefined ||
      !isJsonRecord(item) ||
      !hasExactKeys(item, ['key', 'epoch']) ||
      item.key !== expectedKey ||
      typeof item.epoch !== 'string' ||
      !prefixedSha256.test(item.epoch)
    ) {
      throw new TypeError('current epoch snapshot roster is malformed or out of order');
    }
    return Object.freeze([expectedKey, item.epoch] as const);
  });
  if (entries[0]?.[1] !== `sha256:${authoritySha256}`) {
    throw new TypeError('current authority epoch does not match the signed authority');
  }
  return Object.freeze(entries);
}

function verifyEpochSnapshot(input: EpochSnapshotVerificationInput): VerifiedCurrentEpochSnapshot {
  const authority = input.authority;
  const document = authority.authority.document;
  const trustKeys = loadOperatorProgressTrustKeys(
    input.operator_trust_root_bytes,
    input.expected_operator_trust_root_sha256,
  );
  const signer = trustKeys.find(
    (key) =>
      key.principalId === authority.signer_principal_id &&
      key.keySha256 === authority.signer_key_sha256,
  );
  if (
    signer === undefined ||
    authority.trust_root_sha256 !== input.expected_operator_trust_root_sha256 ||
    document.invalidation_epoch_provider_id !== input.provider_id ||
    document.invalidation_epoch_provider_identity_sha256 !== input.provider_identity_sha256
  ) {
    throw new TypeError('current epoch provider identity does not match operator authority');
  }
  const envelope = parseCanonicalOperatorRecord(input.snapshot_bytes, 'current epoch snapshot');
  if (
    !hasExactKeys(envelope, envelopeKeys) ||
    envelope.schema_version !== '1.0.0' ||
    envelope.contract_id !== 'new-aria-current-epoch-snapshot-envelope-v1' ||
    !isJsonRecord(envelope.payload) ||
    !isJsonRecord(envelope.signature)
  ) {
    throw new TypeError('current epoch snapshot envelope is invalid');
  }
  const payload = envelope.payload;
  const signature = envelope.signature;
  if (
    !hasExactKeys(payload, payloadKeys) ||
    !hasExactKeys(signature, signatureKeys) ||
    payload.schema_version !== '1.0.0' ||
    payload.contract_id !== 'new-aria-current-epoch-snapshot-payload-v1' ||
    payload.provider_id !== input.provider_id ||
    payload.authority_sha256 !== authority.authority.sha256 ||
    payload.signer_principal_id !== signer.principalId ||
    payload.capability !== 'ATTEST_CURRENT_EPOCHS' ||
    signature.principal_id !== signer.principalId ||
    signature.capability !== 'ATTEST_CURRENT_EPOCHS' ||
    !Number.isSafeInteger(payload.revision) ||
    (payload.revision as number) < 1
  ) {
    throw new TypeError('current epoch snapshot payload identity is invalid');
  }
  const signatureBytes = decodeCanonicalBase64(
    signature.signature_base64,
    'current epoch signature',
  );
  if (
    signatureBytes.length !== 64 ||
    !verify(null, canonicalJsonBytes(payload), signer.publicKey, signatureBytes)
  ) {
    throw new TypeError('current epoch snapshot signature verification failed');
  }
  const [observedAt, observedAtMs] = timestamp(payload.observed_at, 'current epoch observation');
  const [validUntil, validUntilMs] = timestamp(payload.valid_until, 'current epoch validity');
  if (
    !Number.isSafeInteger(input.now) ||
    observedAtMs < Date.parse(authority.observed_at) ||
    observedAtMs > input.now ||
    input.now > validUntilMs ||
    validUntilMs > Date.parse(authority.valid_until)
  ) {
    throw new TypeError('current epoch snapshot is outside the operator authority window');
  }
  return Object.freeze({
    sha256: digestBytes(input.snapshot_bytes),
    revision: Number(payload.revision),
    observed_at: observedAt,
    valid_until: validUntil,
    epochs: epochEntries(payload.invalidation_epochs, authority.authority.sha256),
  });
}

export function verifyCurrentEpochSnapshot(
  input: CurrentEpochSnapshotVerificationInput,
): VerifiedCurrentEpochSnapshot {
  assertAuthorizedS01ProgressAuthority(input.authority);
  return verifyEpochSnapshot(input);
}

export function verifyHistoricalCurrentEpochSnapshot(
  input: HistoricalCurrentEpochSnapshotVerificationInput,
): VerifiedCurrentEpochSnapshot {
  assertHistoricallyVerifiedS01ProgressAuthority(input.authority);
  const { receipt_epoch_read_at: receiptEpochReadAt, ...verification } = input;
  const [, readAtMs] = timestamp(receiptEpochReadAt, 'historical receipt epoch read');
  return verifyEpochSnapshot({ ...verification, now: readAtMs });
}
