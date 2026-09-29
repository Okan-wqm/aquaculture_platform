import { createPublicKey, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json';
import {
  digestBytes,
  hasExactKeys,
  isJsonRecord,
  requiredSha256,
  requiredText,
} from './evidence-object';
import type { JsonRecord } from './evidence-object';
import { decodeCanonicalBase64 } from './evidence-trust-root';
import type {
  CurrentExecutionReceiptVerificationInput,
  ExecutionReceiptVerificationInput,
  HistoricalExecutionReceiptVerificationInput,
  VerifiedExecutionReceipt,
} from './execution-receipt-contract';
import { validateExecutionReceiptPayload } from './execution-receipt-contract';
import { requireIdentifier } from './identifiers';
import type {
  AuthorizedS01ProgressAuthority,
  VerifiedS01ProgressAuthority,
} from './operator-progress-authority';
import {
  assertAuthorizedS01ProgressAuthority,
  assertHistoricallyVerifiedS01ProgressAuthority,
} from './operator-progress-authority';
import { parseStrictJson } from './strict-json';
import type { JsonValue } from './strict-json';

export type {
  ExecutionReceiptDocument,
  CurrentExecutionReceiptVerificationInput,
  ExecutionReceiptVerificationInput,
  HistoricalExecutionReceiptVerificationInput,
  VerifiedExecutionReceipt,
} from './execution-receipt-contract';

export interface ExecutionTrustKey {
  readonly principalId: string;
  readonly publicKey: KeyObject;
  readonly encodedKey: string;
  readonly keySha256: string;
  readonly executionSessionId: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly revocationEpoch: number;
}

const rootKeys = ['schema_version', 'contract_id', 'keys'];
const trustKeyKeys = [
  'principal_id',
  'capability',
  'execution_session_id',
  'status',
  'valid_from',
  'valid_until',
  'revocation_epoch',
  'public_key_spki_der_base64',
];
const envelopeKeys = ['schema_version', 'contract_id', 'payload', 'signature'];
const signatureKeys = ['principal_id', 'capability', 'signature_base64'];
const exactUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const verifiedReceipts = new WeakSet<object>();

function canonicalRecord(bytes: Uint8Array, label: string): JsonRecord {
  const value = parseStrictJson(bytes);
  if (!isJsonRecord(value) || !canonicalJsonBytes(value).equals(Buffer.from(bytes))) {
    throw new TypeError(`${label} must be a canonical JSON record`);
  }
  return value;
}

export function loadExecutionTrustKey(
  bytes: Uint8Array,
  expectedDigest: string,
): ExecutionTrustKey {
  if (digestBytes(bytes) !== requiredSha256(expectedDigest, 'execution trust root pin')) {
    throw new TypeError('execution trust root digest mismatch');
  }
  const root = canonicalRecord(bytes, 'execution trust root');
  if (
    !hasExactKeys(root, rootKeys) ||
    root.schema_version !== '1.0.0' ||
    root.contract_id !== 'new-aria-execution-trust-root-v1' ||
    !Array.isArray(root.keys) ||
    root.keys.length !== 1
  ) {
    throw new TypeError('execution trust root schema or key set is invalid');
  }
  const value = root.keys[0];
  if (
    !isJsonRecord(value) ||
    !hasExactKeys(value, trustKeyKeys) ||
    value.capability !== 'ATTEST_EXECUTION'
  ) {
    throw new TypeError('execution trust key schema or capability is invalid');
  }
  const principalId = requireIdentifier(value.principal_id, 'execution trust key principal');
  const executionSessionId = requireIdentifier(value.execution_session_id, 'execution key session');
  const [validFrom, validFromMs] = timestamp(value.valid_from, 'execution key valid_from');
  const [validUntil, validUntilMs] = timestamp(value.valid_until, 'execution key valid_until');
  if (
    value.status !== 'ACTIVE' ||
    !Number.isSafeInteger(value.revocation_epoch) ||
    (value.revocation_epoch as number) < 1 ||
    validUntilMs <= validFromMs
  )
    throw new TypeError('execution trust key status, epoch, or validity window is invalid');
  const keyBytes = decodeCanonicalBase64(value.public_key_spki_der_base64, 'execution public key');
  const publicKey = createPublicKey({ key: keyBytes, format: 'der', type: 'spki' });
  if (publicKey.asymmetricKeyType !== 'ed25519')
    throw new TypeError('execution public key is not Ed25519');
  const canonicalKey = publicKey.export({ format: 'der', type: 'spki' });
  if (!canonicalKey.equals(keyBytes))
    throw new TypeError('execution public key is not canonical SPKI DER');
  return Object.freeze({
    principalId,
    publicKey,
    encodedKey: canonicalKey.toString('base64'),
    keySha256: digestBytes(canonicalKey),
    executionSessionId,
    validFrom,
    validUntil,
    revocationEpoch: Number(value.revocation_epoch),
  });
}

export function assertExecutionTrustKeyAuthority(
  key: ExecutionTrustKey,
  authority: VerifiedS01ProgressAuthority,
): void {
  const document = authority.authority.document;
  if (
    key.executionSessionId !== document.execution_session_id ||
    key.validFrom !== authority.observed_at ||
    key.validUntil !== authority.valid_until
  )
    throw new TypeError('execution trust key does not match the authority session or window');
}

function assertVerifiedProgressAuthority(authority: VerifiedS01ProgressAuthority): void {
  if (authority.authorization_kind === 'CURRENT') {
    assertAuthorizedS01ProgressAuthority(authority);
    return;
  }
  assertHistoricallyVerifiedS01ProgressAuthority(authority);
}

export function assertVerifiedExecutionReceipt(
  value: unknown,
): asserts value is VerifiedExecutionReceipt {
  if (value === null || typeof value !== 'object' || !verifiedReceipts.has(value)) {
    throw new TypeError('execution receipt was not issued by the cryptographic verifier');
  }
}

function timestamp(value: JsonValue | undefined, label: string): [string, number] {
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

export function verifyExecutionReceipt(
  input: ExecutionReceiptVerificationInput,
): VerifiedExecutionReceipt {
  assertVerifiedProgressAuthority(input.authority);
  const expectedRoot = input.authority.authority.document.execution_trust_root_sha256;
  const key = loadExecutionTrustKey(input.trust_root_bytes, expectedRoot);
  assertExecutionTrustKeyAuthority(key, input.authority);
  const envelope = canonicalRecord(input.receipt_bytes, 'execution receipt envelope');
  if (
    !hasExactKeys(envelope, envelopeKeys) ||
    envelope.schema_version !== '1.0.0' ||
    envelope.contract_id !== 'new-aria-execution-receipt-envelope-v1' ||
    !isJsonRecord(envelope.payload) ||
    !isJsonRecord(envelope.signature) ||
    !hasExactKeys(envelope.signature, signatureKeys)
  )
    throw new TypeError('execution receipt envelope schema or identity is invalid');
  const signature = decodeCanonicalBase64(
    envelope.signature.signature_base64,
    'execution signature',
  );
  if (
    envelope.signature.principal_id !== key.principalId ||
    envelope.signature.capability !== 'ATTEST_EXECUTION' ||
    signature.length !== 64 ||
    !verify(null, canonicalJsonBytes(envelope.payload), key.publicKey, signature)
  )
    throw new TypeError('execution receipt signature or signer identity is invalid');
  const document = validateExecutionReceiptPayload(envelope.payload, input, key);
  const receipt = Object.freeze({ sha256: digestBytes(input.receipt_bytes), document });
  verifiedReceipts.add(receipt);
  return receipt;
}

export function verifyCurrentExecutionReceipt(
  input: CurrentExecutionReceiptVerificationInput,
): VerifiedExecutionReceipt {
  assertAuthorizedS01ProgressAuthority(input.authority);
  const receipt = verifyExecutionReceipt(input);
  const now = Date.now();
  if (
    !Number.isSafeInteger(now) ||
    now < Date.parse(input.authority.observed_at) ||
    now > Date.parse(input.authority.valid_until) ||
    Date.parse(receipt.document.issued_at) > now
  ) {
    throw new TypeError('execution receipt is outside the current authority window');
  }
  return receipt;
}

export function verifyHistoricalExecutionReceipt(
  input: HistoricalExecutionReceiptVerificationInput,
): VerifiedExecutionReceipt {
  assertHistoricallyVerifiedS01ProgressAuthority(input.authority);
  return verifyExecutionReceipt(input);
}
