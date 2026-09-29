import { verify } from 'node:crypto';

import type { LoadedProgressAuthority } from '../domain/progress-contracts';

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
import { requireIdentifier } from './identifiers';
import {
  loadOperatorProgressTrustKeys,
  parseCanonicalOperatorRecord,
} from './operator-progress-trust-root';
import type { OperatorProgressTrustKey } from './operator-progress-trust-root';
import { loadProgressAuthority } from './progress-authority';
import { assertExactS01ProgressAuthorityScope } from './s01-progress-authority-scope';
import type { JsonValue } from './strict-json';

export { S01_PROGRESS_AUTHORITY_SCOPE } from './s01-progress-authority-scope';

export interface OperatorProgressAuthorityInput {
  readonly envelope_bytes: Uint8Array;
  readonly trust_root_bytes: Uint8Array;
  readonly expected_trust_root_sha256: string;
}

interface VerifiedProgressAuthorityFields {
  readonly authority: LoadedProgressAuthority;
  readonly envelope_sha256: string;
  readonly trust_root_sha256: string;
  readonly signer_principal_id: string;
  readonly signer_key_sha256: string;
  readonly observed_at: string;
  readonly valid_until: string;
}

export interface AuthorizedS01ProgressAuthority extends VerifiedProgressAuthorityFields {
  readonly authorization_kind: 'CURRENT';
}

export interface HistoricallyVerifiedS01ProgressAuthority extends VerifiedProgressAuthorityFields {
  readonly authorization_kind: 'HISTORICAL';
}

export type VerifiedS01ProgressAuthority =
  | AuthorizedS01ProgressAuthority
  | HistoricallyVerifiedS01ProgressAuthority;

interface ParsedPayload {
  readonly authorityBytes: Uint8Array;
  readonly authoritySha256: string;
  readonly signerPrincipalId: string;
  readonly observedAt: string;
  readonly observedAtMs: number;
  readonly validUntil: string;
  readonly validUntilMs: number;
}

const envelopeKeys = ['schema_version', 'contract_id', 'payload', 'signatures'];
const payloadKeys = [
  'schema_version',
  'contract_id',
  'signer_principal_id',
  'capability',
  'progress_authority_base64',
  'progress_authority_sha256',
  'observed_at',
  'valid_until',
];
const signatureKeys = ['principal_id', 'capability', 'signature_base64'];
const exactUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const issuedAuthorities = new WeakSet<object>();
const historicalAuthorities = new WeakSet<object>();

export function assertAuthorizedS01ProgressAuthority(
  value: unknown,
): asserts value is AuthorizedS01ProgressAuthority {
  if (typeof value !== 'object' || value === null || !issuedAuthorities.has(value)) {
    throw new TypeError('S01 progress authority capability was not issued by the trusted verifier');
  }
}

export function assertHistoricallyVerifiedS01ProgressAuthority(
  value: unknown,
): asserts value is HistoricallyVerifiedS01ProgressAuthority {
  if (typeof value !== 'object' || value === null || !historicalAuthorities.has(value)) {
    throw new TypeError('historical S01 authority was not issued by the trusted verifier');
  }
}

function parseTimestamp(value: JsonValue | undefined, label: string): [string, number] {
  const timestamp = requiredText(value, label);
  const milliseconds = Date.parse(timestamp);
  if (
    !exactUtc.test(timestamp) ||
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== timestamp
  ) {
    throw new TypeError(`${label} timestamp is not canonical UTC`);
  }
  return [timestamp, milliseconds];
}

function parsePayload(value: JsonValue | undefined): ParsedPayload {
  if (!isJsonRecord(value) || !hasExactKeys(value, payloadKeys)) {
    throw new TypeError('operator progress authority payload schema is invalid');
  }
  if (
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-operator-progress-authority-payload-v1' ||
    value.capability !== 'AUTHORIZE_PROGRESS'
  ) {
    throw new TypeError('operator progress authority payload identity is invalid');
  }
  const authorityBytes = decodeCanonicalBase64(
    value.progress_authority_base64,
    'operator progress authority bytes',
  );
  const authoritySha256 = requiredSha256(
    value.progress_authority_sha256,
    'operator progress authority digest',
  );
  if (digestBytes(authorityBytes) !== authoritySha256) {
    throw new TypeError('operator progress authority digest mismatch');
  }
  const [observedAt, observedAtMs] = parseTimestamp(value.observed_at, 'operator observation');
  const [validUntil, validUntilMs] = parseTimestamp(value.valid_until, 'operator validity');
  if (validUntilMs <= observedAtMs) {
    throw new TypeError('operator progress authority validity interval is invalid');
  }
  return {
    authorityBytes,
    authoritySha256,
    signerPrincipalId: requireIdentifier(value.signer_principal_id, 'operator signer principal'),
    observedAt,
    observedAtMs,
    validUntil,
    validUntilMs,
  };
}

function verifyEnvelopeSignature(
  envelope: JsonRecord,
  payload: ParsedPayload,
  trustKeys: readonly OperatorProgressTrustKey[],
): OperatorProgressTrustKey {
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) {
    throw new TypeError('operator progress authority requires one unique signer');
  }
  const signature = envelope.signatures[0];
  if (!isJsonRecord(signature) || !hasExactKeys(signature, signatureKeys)) {
    throw new TypeError('operator progress authority signature schema is invalid');
  }
  if (signature.capability !== 'AUTHORIZE_PROGRESS') {
    throw new TypeError('operator progress authority signature capability is invalid');
  }
  const principalId = requireIdentifier(signature.principal_id, 'operator signature principal');
  if (principalId !== payload.signerPrincipalId) {
    throw new TypeError('operator progress authority signer does not match signed payload');
  }
  const trustKey = trustKeys.find((key) => key.principalId === principalId);
  const signatureBytes = decodeCanonicalBase64(signature.signature_base64, 'operator signature');
  if (
    trustKey === undefined ||
    signatureBytes.length !== 64 ||
    !verify(null, canonicalJsonBytes(envelope.payload), trustKey.publicKey, signatureBytes)
  ) {
    throw new TypeError('operator progress authority signature verification failed');
  }
  return trustKey;
}

type VerifiedAuthorityEnvelope = Omit<AuthorizedS01ProgressAuthority, 'authorization_kind'>;

function verifyAuthorityEnvelope(input: OperatorProgressAuthorityInput): VerifiedAuthorityEnvelope {
  const trustKeys = loadOperatorProgressTrustKeys(
    input.trust_root_bytes,
    input.expected_trust_root_sha256,
  );
  const envelope = parseCanonicalOperatorRecord(
    input.envelope_bytes,
    'operator progress authority envelope',
  );
  if (
    !hasExactKeys(envelope, envelopeKeys) ||
    envelope.schema_version !== '1.0.0' ||
    envelope.contract_id !== 'new-aria-operator-progress-authority-envelope-v1'
  ) {
    throw new TypeError('operator progress authority envelope schema or identity is invalid');
  }
  const payload = parsePayload(envelope.payload);
  const signer = verifyEnvelopeSignature(envelope, payload, trustKeys);
  const authority = loadProgressAuthority(payload.authorityBytes);
  if (authority.sha256 !== payload.authoritySha256) {
    throw new TypeError('operator progress authority loaded digest mismatch');
  }
  assertExactS01ProgressAuthorityScope(authority);
  return Object.freeze({
    authority,
    envelope_sha256: digestBytes(input.envelope_bytes),
    trust_root_sha256: input.expected_trust_root_sha256,
    signer_principal_id: signer.principalId,
    signer_key_sha256: signer.keySha256,
    observed_at: payload.observedAt,
    valid_until: payload.validUntil,
  });
}

export function authorizeS01ProgressAuthority(
  input: OperatorProgressAuthorityInput,
): AuthorizedS01ProgressAuthority {
  const verified = verifyAuthorityEnvelope(input);
  const now = Date.now();
  if (!Number.isSafeInteger(now)) {
    throw new TypeError('trusted clock did not return a valid UTC instant');
  }
  if (Date.parse(verified.observed_at) > now) {
    throw new TypeError('operator progress authority observation is in the future');
  }
  if (now > Date.parse(verified.valid_until)) {
    throw new TypeError('operator progress authority is stale');
  }
  const authorized: AuthorizedS01ProgressAuthority = Object.freeze({
    authorization_kind: 'CURRENT',
    ...verified,
  });
  issuedAuthorities.add(authorized);
  return authorized;
}

export function verifyHistoricalS01ProgressAuthority(
  input: OperatorProgressAuthorityInput,
): HistoricallyVerifiedS01ProgressAuthority {
  const historical: HistoricallyVerifiedS01ProgressAuthority = Object.freeze({
    authorization_kind: 'HISTORICAL',
    ...verifyAuthorityEnvelope(input),
  });
  historicalAuthorities.add(historical);
  return historical;
}
