import { createHash } from 'node:crypto';

import { canonicalJsonBytes } from './canonical-json';
import { deepFreezeJson } from './deep-freeze-json';
import { requireIdentifier } from './identifiers';
import { EventPolicy } from './policy';
import { JsonValue, parseStrictJson } from './strict-json';

const eventKeys = [
  'schema_version',
  'contract_id',
  'program_id',
  'event_id',
  'sequence',
  'sprint_id',
  'from_state',
  'to_state',
  'occurred_at',
  'actor_id',
  'target_sha',
  'authority_sha256',
  'evidence_uri',
  'evidence_sha256',
  'previous_hash',
  'event_hash',
] as const;

export type EventRecord = { [key: string]: JsonValue };

const isRecord = (value: JsonValue): value is EventRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (event: EventRecord): boolean =>
  JSON.stringify(Object.keys(event).sort()) === JSON.stringify([...eventKeys].sort());

const sha40 = /^[a-f0-9]{40}$/u;
const sha64 = /^[a-f0-9]{64}$/u;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function stringField(event: EventRecord, field: string): string {
  const value = event[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`event ${field} must be a non-empty string`);
  }
  return value;
}

function validateShape(event: EventRecord, policy: EventPolicy): void {
  if (!hasExactKeys(event)) throw new TypeError('event schema is open or incomplete');
  if (event.schema_version !== '1.0.0' || event.contract_id !== policy.event_contract_id) {
    throw new TypeError('event contract identity mismatch');
  }
  for (const field of ['program_id', 'event_id', 'sprint_id', 'actor_id']) {
    requireIdentifier(event[field], `event ${field} identifier`);
  }
  if (!Number.isSafeInteger(event.sequence) || (event.sequence as number) < 1) {
    throw new TypeError('event sequence must be a positive safe integer');
  }
  if (!sha40.test(stringField(event, 'target_sha'))) {
    throw new TypeError('event target SHA is invalid');
  }
  if (!sha64.test(stringField(event, 'authority_sha256'))) {
    throw new TypeError('event authority digest is invalid');
  }
  const evidenceDigest = stringField(event, 'evidence_sha256');
  if (
    !sha64.test(evidenceDigest) ||
    event.evidence_uri !== `aria-evidence://sha256/${evidenceDigest}`
  ) {
    throw new TypeError('event evidence URI and digest are not content-addressed');
  }
  const occurredAt = stringField(event, 'occurred_at');
  const parsedTimestamp = Date.parse(occurredAt);
  if (
    !timestamp.test(occurredAt) ||
    !Number.isFinite(parsedTimestamp) ||
    new Date(parsedTimestamp).toISOString() !== occurredAt
  ) {
    throw new TypeError('event timestamp is invalid');
  }
  const from = stringField(event, 'from_state');
  const to = stringField(event, 'to_state');
  if (!policy.states.includes(from) || !policy.states.includes(to)) {
    throw new TypeError('event state is unknown');
  }
  if (!policy.transitions[from]?.includes(to)) {
    throw new TypeError(`illegal event transition ${from} -> ${to}`);
  }
  if (!sha64.test(stringField(event, 'event_hash'))) {
    throw new TypeError('event hash is invalid');
  }
}

export function computeEventHash(event: EventRecord): string {
  const { event_hash: _ignored, ...payload } = event;
  return createHash('sha256').update(canonicalJsonBytes(payload)).digest('hex');
}

function decodeLines(bytes: Uint8Array): string[] {
  if (bytes.length === 0 || bytes.at(-1) !== 0x0a) {
    throw new TypeError('event chain must be non-empty and newline-terminated');
  }
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TypeError('event chain is not valid UTF-8');
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) throw new TypeError('event chain has an empty row');
  return lines;
}

export function verifyEventChain(bytes: Uint8Array, policy: EventPolicy): readonly EventRecord[] {
  const events = decodeLines(bytes).map((line) => {
    const event = parseStrictJson(Buffer.from(line, 'utf8'));
    if (!isRecord(event)) throw new TypeError('event row must be an object');
    if (!canonicalJsonBytes(event).equals(Buffer.from(line, 'utf8'))) {
      throw new TypeError('event row must use canonical JSON');
    }
    validateShape(event, policy);
    if (computeEventHash(event) !== event.event_hash) throw new TypeError('event hash mismatch');
    return event;
  });
  const ids = new Set<string>();
  events.forEach((event, index) => {
    const previous = events[index - 1];
    if (event.sequence !== index + 1) throw new TypeError('event sequence gap or duplicate');
    if (ids.has(event.event_id as string)) throw new TypeError('duplicate event ID');
    ids.add(event.event_id as string);
    if (index === 0 && event.previous_hash !== '0'.repeat(64)) {
      throw new TypeError('genesis event previous hash must be zero SHA-256');
    }
    if (index === 0 && event.from_state !== 'PLANNED') {
      throw new TypeError('genesis event must begin from PLANNED');
    }
    if (previous) {
      if (event.previous_hash !== previous.event_hash) throw new TypeError('event chain hash gap');
      if (event.from_state !== previous.to_state) throw new TypeError('event state continuity gap');
      for (const field of ['program_id', 'sprint_id', 'target_sha', 'authority_sha256']) {
        if (event[field] !== previous[field]) throw new TypeError(`event ${field} continuity gap`);
      }
      if ((event.event_id as string) <= (previous.event_id as string)) {
        throw new TypeError('event IDs are not strictly increasing');
      }
      if (Date.parse(event.occurred_at as string) <= Date.parse(previous.occurred_at as string)) {
        throw new TypeError('event timestamps are not strictly increasing');
      }
    }
  });
  events.forEach(deepFreezeJson);
  return Object.freeze(events);
}
