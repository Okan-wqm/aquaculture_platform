import { createPublicKey, KeyObject, sign, verify } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json';
import { hasExactKeys, requiredSha256, requiredText } from './evidence-object';
import type { JsonRecord } from './evidence-object';
import { decodeCanonicalBase64 } from './evidence-trust-root';
import { assertExecutionTrustKeyAuthority, loadExecutionTrustKey } from './execution-trust-root';
import type { AuthorizedS01ProgressAuthority } from './operator-progress-authority';
import { assertAuthorizedS01ProgressAuthority } from './operator-progress-authority';

export interface ExecutionSigningCapability {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-execution-signing-capability-v1';
  readonly capability: 'ATTEST_EXECUTION';
  readonly authority_sha256: string;
  readonly authority_envelope_sha256: string;
  readonly execution_session_id: string;
  readonly principal_id: string;
  readonly key_sha256: string;
  readonly trust_root_sha256: string;
  readonly possession_proof_base64: string;
}

export type ExecutionSigningCapabilityClaims = Omit<
  ExecutionSigningCapability,
  'possession_proof_base64'
>;

export interface ExecutionSigningCapabilityIssuance {
  readonly claims: ExecutionSigningCapabilityClaims;
  readonly authority: AuthorizedS01ProgressAuthority;
  readonly trust_root_bytes: Uint8Array;
  readonly private_key: KeyObject;
}

export interface ExecutionSigningReservation {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-execution-signing-reservation-v1';
  readonly authority_sha256: string;
  readonly execution_session_id: string;
}

const capabilityKeys = [
  'schema_version',
  'contract_id',
  'capability',
  'authority_sha256',
  'authority_envelope_sha256',
  'execution_session_id',
  'principal_id',
  'key_sha256',
  'trust_root_sha256',
  'possession_proof_base64',
] as const;
interface CapabilityState {
  readonly authority: AuthorizedS01ProgressAuthority;
  phase: 'ISSUED' | 'RESERVED' | 'CONSUMED';
  reservation?: ExecutionSigningReservation;
}

const capabilityStates = new WeakMap<object, CapabilityState>();
const authorityCapabilities = new WeakMap<object, object>();
const reservationCapabilities = new WeakMap<object, object>();

function isCapabilityRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function executionCapabilityPossessionPayload(
  capability: ExecutionSigningCapabilityClaims,
): object {
  return {
    schema_version: '1.0.0',
    contract_id: 'new-aria-execution-capability-possession-v1',
    capability: 'ATTEST_EXECUTION',
    authority_sha256: capability.authority_sha256,
    authority_envelope_sha256: capability.authority_envelope_sha256,
    execution_session_id: capability.execution_session_id,
    principal_id: capability.principal_id,
    key_sha256: capability.key_sha256,
    trust_root_sha256: capability.trust_root_sha256,
  };
}

export function issueExecutionSigningCapability(
  input: ExecutionSigningCapabilityIssuance,
): ExecutionSigningCapability {
  assertAuthorizedS01ProgressAuthority(input.authority);
  if (authorityCapabilities.has(input.authority)) {
    throw new TypeError('execution signing capability was already issued for this authority');
  }
  const document = input.authority.authority.document;
  const key = loadExecutionTrustKey(input.trust_root_bytes, document.execution_trust_root_sha256);
  assertExecutionTrustKeyAuthority(key, input.authority);
  const publicKey = createPublicKey(input.private_key).export({ format: 'der', type: 'spki' });
  if (
    input.private_key.asymmetricKeyType !== 'ed25519' ||
    input.claims.authority_sha256 !== input.authority.authority.sha256 ||
    input.claims.authority_envelope_sha256 !== input.authority.envelope_sha256 ||
    input.claims.execution_session_id !== document.execution_session_id ||
    input.claims.principal_id !== key.principalId ||
    input.claims.key_sha256 !== key.keySha256 ||
    input.claims.trust_root_sha256 !== document.execution_trust_root_sha256 ||
    requiredSha256(input.claims.key_sha256, 'execution capability key digest') !==
      requiredSha256(key.keySha256, 'execution trust key digest') ||
    !Buffer.from(publicKey).equals(
      Buffer.from(key.publicKey.export({ format: 'der', type: 'spki' })),
    )
  )
    throw new TypeError('execution signing capability issuance does not match its private key');
  const capability = Object.freeze({
    ...input.claims,
    possession_proof_base64: sign(
      null,
      canonicalJsonBytes(executionCapabilityPossessionPayload(input.claims)),
      input.private_key,
    ).toString('base64'),
  });
  capabilityStates.set(capability, { authority: input.authority, phase: 'ISSUED' });
  authorityCapabilities.set(input.authority, capability);
  return capability;
}

export function verifyExecutionSigningCapability(
  value: unknown,
  authority: AuthorizedS01ProgressAuthority,
  trustRootBytes: Uint8Array,
): asserts value is ExecutionSigningCapability {
  assertAuthorizedS01ProgressAuthority(authority);
  if (!isCapabilityRecord(value) || !hasExactKeys(value, capabilityKeys))
    throw new TypeError('execution signing capability schema is invalid');
  const state = capabilityStates.get(value);
  if (state === undefined) {
    throw new TypeError('execution signing capability was not runtime-issued');
  }
  if (state.authority !== authority) {
    throw new TypeError('execution signing capability belongs to another authority object');
  }
  const document = authority.authority.document;
  const key = loadExecutionTrustKey(trustRootBytes, document.execution_trust_root_sha256);
  assertExecutionTrustKeyAuthority(key, authority);
  const now = Date.now();
  if (
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-execution-signing-capability-v1' ||
    value.capability !== 'ATTEST_EXECUTION' ||
    value.authority_sha256 !== authority.authority.sha256 ||
    value.authority_envelope_sha256 !== authority.envelope_sha256 ||
    value.execution_session_id !== document.execution_session_id ||
    value.principal_id !== key.principalId ||
    value.key_sha256 !== key.keySha256 ||
    value.trust_root_sha256 !== document.execution_trust_root_sha256 ||
    !Number.isSafeInteger(now) ||
    now < Date.parse(authority.observed_at) ||
    now > Date.parse(authority.valid_until)
  )
    throw new TypeError('execution signing capability does not match current authority');
  requiredSha256(value.key_sha256, 'execution capability key digest');
  requiredSha256(value.trust_root_sha256, 'execution capability root digest');
  const capability: ExecutionSigningCapabilityClaims = {
    schema_version: value.schema_version,
    contract_id: value.contract_id,
    capability: value.capability,
    authority_sha256: requiredSha256(value.authority_sha256, 'execution capability authority'),
    authority_envelope_sha256: requiredSha256(
      value.authority_envelope_sha256,
      'execution capability authority envelope',
    ),
    execution_session_id: requiredText(value.execution_session_id, 'execution capability session'),
    principal_id: requiredText(value.principal_id, 'execution capability principal'),
    key_sha256: requiredSha256(value.key_sha256, 'execution capability key digest'),
    trust_root_sha256: requiredSha256(value.trust_root_sha256, 'execution capability root digest'),
  };
  const proof = decodeCanonicalBase64(
    value.possession_proof_base64,
    'execution capability possession proof',
  );
  const payload = executionCapabilityPossessionPayload(capability);
  if (proof.length !== 64 || !verify(null, canonicalJsonBytes(payload), key.publicKey, proof)) {
    throw new TypeError('execution signing capability possession proof is invalid');
  }
}

export function reserveExecutionSigningCapability(
  value: unknown,
  authority: AuthorizedS01ProgressAuthority,
  trustRootBytes: Uint8Array,
): ExecutionSigningReservation {
  verifyExecutionSigningCapability(value, authority, trustRootBytes);
  const state = capabilityStates.get(value);
  if (state === undefined || state.phase !== 'ISSUED') {
    throw new TypeError('execution signing capability lifecycle is already reserved or consumed');
  }
  const reservation: ExecutionSigningReservation = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-execution-signing-reservation-v1',
    authority_sha256: authority.authority.sha256,
    execution_session_id: authority.authority.document.execution_session_id,
  });
  state.phase = 'RESERVED';
  state.reservation = reservation;
  reservationCapabilities.set(reservation, value);
  return reservation;
}

function reservedState(reservation: ExecutionSigningReservation): CapabilityState {
  const capability = reservationCapabilities.get(reservation);
  const state = capability === undefined ? undefined : capabilityStates.get(capability);
  if (state === undefined || state.phase !== 'RESERVED' || state.reservation !== reservation) {
    throw new TypeError('execution signing reservation is absent or inactive');
  }
  return state;
}

export function commitExecutionSigningReservation(reservation: ExecutionSigningReservation): void {
  const state = reservedState(reservation);
  state.phase = 'CONSUMED';
  delete state.reservation;
  reservationCapabilities.delete(reservation);
}

export function abortExecutionSigningReservation(reservation: ExecutionSigningReservation): void {
  const state = reservedState(reservation);
  state.phase = 'ISSUED';
  delete state.reservation;
  reservationCapabilities.delete(reservation);
}
