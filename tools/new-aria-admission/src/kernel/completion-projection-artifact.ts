import type { CompletionProjection } from '../domain/progress-contracts';

import { canonicalJsonBytes } from './canonical-json';
import { requireIdentifier } from './identifiers';
import { parseStrictJson } from './strict-json';
import type { JsonValue } from './strict-json';

const keys = [
  'schema_version',
  'contract_id',
  'program_id',
  'sprint_id',
  'state',
  'status',
  'freshness',
  'verdict',
  'verified_at',
  'valid_from',
  'valid_until',
  'head_sha',
  'authority_sha256',
  'evidence_sha256',
  'event_chain_sha256',
  'attestation_sha256',
  'tail_event_hash',
] as const;
const sha40 = /^[a-f0-9]{40}$/u;
const sha64 = /^[a-f0-9]{64}$/u;
const exactUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
type JsonRecord = { [key: string]: JsonValue };

function requiredString(value: JsonRecord, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new TypeError(`completion projection ${key} is invalid`);
  return field;
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (
    !exactUtc.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new TypeError(`completion projection ${label} is invalid`);
  }
  return parsed;
}

function validate(value: CompletionProjection): readonly [number, number] {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-completion-projection-v1' ||
    value.state !== 'DONE' ||
    value.status !== 'OK' ||
    value.freshness !== 'VALID_AT' ||
    value.verdict !== 'ACCEPTED'
  ) {
    throw new TypeError('completion projection schema or terminal state is invalid');
  }
  requireIdentifier(value.program_id, 'completion program identifier');
  requireIdentifier(value.sprint_id, 'completion sprint identifier');
  if (!sha40.test(value.head_sha)) throw new TypeError('completion head SHA is invalid');
  const verifiedAt = timestamp(value.verified_at, 'verification time');
  const validFrom = timestamp(value.valid_from, 'validity start');
  const validUntil = timestamp(value.valid_until, 'validity deadline');
  if (verifiedAt > validFrom || validFrom > validUntil) {
    throw new TypeError('completion projection validity interval is invalid');
  }
  const digests = [
    value.authority_sha256,
    value.evidence_sha256,
    value.event_chain_sha256,
    value.attestation_sha256,
    value.tail_event_hash,
  ];
  if (digests.some((digest) => !sha64.test(digest))) {
    throw new TypeError('completion projection digest is invalid');
  }
  return [validFrom, validUntil];
}

export function serializeCompletionProjectionArtifact(value: CompletionProjection): Buffer {
  validate(value);
  return Buffer.concat([canonicalJsonBytes(value), Buffer.from('\n')]);
}

export function loadCompletionProjectionArtifact(bytes: Uint8Array): CompletionProjection {
  const artifact = Buffer.from(bytes);
  if (artifact.byteLength < 2 || artifact.at(-1) !== 0x0a) {
    throw new TypeError('completion projection artifact framing is invalid');
  }
  const body = artifact.subarray(0, -1);
  const parsed = parseStrictJson(body);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(parsed, key)) ||
    !canonicalJsonBytes(parsed).equals(body)
  ) {
    throw new TypeError('completion projection artifact is not canonical');
  }
  const value = parsed;
  if (
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-completion-projection-v1' ||
    value.state !== 'DONE' ||
    value.status !== 'OK' ||
    value.freshness !== 'VALID_AT' ||
    value.verdict !== 'ACCEPTED'
  ) {
    throw new TypeError('completion projection artifact identity is invalid');
  }
  const projection: CompletionProjection = Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-completion-projection-v1',
    program_id: requiredString(value, 'program_id'),
    sprint_id: requiredString(value, 'sprint_id'),
    state: 'DONE',
    status: 'OK',
    freshness: 'VALID_AT',
    verdict: 'ACCEPTED',
    verified_at: requiredString(value, 'verified_at'),
    valid_from: requiredString(value, 'valid_from'),
    valid_until: requiredString(value, 'valid_until'),
    head_sha: requiredString(value, 'head_sha'),
    authority_sha256: requiredString(value, 'authority_sha256'),
    evidence_sha256: requiredString(value, 'evidence_sha256'),
    event_chain_sha256: requiredString(value, 'event_chain_sha256'),
    attestation_sha256: requiredString(value, 'attestation_sha256'),
    tail_event_hash: requiredString(value, 'tail_event_hash'),
  });
  if (!serializeCompletionProjectionArtifact(projection).equals(artifact)) {
    throw new TypeError('completion projection artifact bytes are not canonical');
  }
  return projection;
}

export function assertCompletionProjectionCurrent(value: CompletionProjection, now: number): void {
  const [validFrom, validUntil] = validate(value);
  if (!Number.isSafeInteger(now) || now < validFrom || now > validUntil) {
    throw new TypeError('completion projection is no longer current');
  }
}
