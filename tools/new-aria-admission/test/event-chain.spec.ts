import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJsonBytes } from '../src/kernel/canonical-json';
import { computeEventHash, EventRecord, verifyEventChain } from '../src/kernel/event-chain';
import { loadEventPolicy } from '../src/kernel/policy';

const policy = loadEventPolicy(readFileSync(join(__dirname, '../policy/event-policy.json')));
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

interface EventFixture extends EventRecord {
  actor_id: string;
  authority_sha256: string;
  contract_id: string;
  event_hash: string;
  event_id: string;
  evidence_sha256: string;
  evidence_uri: string;
  from_state: string;
  occurred_at: string;
  previous_hash: string;
  program_id: string;
  schema_version: string;
  sequence: number;
  sprint_id: string;
  target_sha: string;
  to_state: string;
}

function eventAt(events: readonly EventFixture[], index: number): EventFixture {
  const value = events[index];
  if (value === undefined) throw new Error(`fixture event ${index} is missing`);
  return value;
}

function event(
  sequence: number,
  fromState: string,
  toState: string,
  previousHash: string,
): EventFixture {
  const value = {
    schema_version: '1.0.0',
    contract_id: 'aria-event-cjson-v1',
    program_id: 'new-aria-autonomous-engineering',
    event_id: `s01-${sequence.toString().padStart(4, '0')}`,
    sequence,
    sprint_id: 'S01',
    from_state: fromState,
    to_state: toState,
    occurred_at: `2026-09-02T12:00:0${sequence}.000Z`,
    actor_id: 's01-controller',
    target_sha: 'a'.repeat(40),
    authority_sha256: 'b'.repeat(64),
    evidence_uri: `aria-evidence://sha256/${'c'.repeat(64)}`,
    evidence_sha256: 'c'.repeat(64),
    previous_hash: previousHash,
    event_hash: '',
  };
  value.event_hash = computeEventHash(value);
  return value;
}

function chain(): ReturnType<typeof event>[] {
  const first = event(1, 'PLANNED', 'READY', '0'.repeat(64));
  const second = event(2, 'READY', 'IN_PROGRESS', first.event_hash);
  return [first, second];
}

function bytes(events: ReturnType<typeof event>[]): Buffer {
  return Buffer.from(`${events.map((value) => canonicalJsonBytes(value)).join('\n')}\n`);
}

describe('progress event chain', () => {
  it('accepts a canonical genesis and uninterrupted chain without mutating input', () => {
    const input = bytes(chain());
    const before = Buffer.from(input);
    const verified = verifyEventChain(input, policy);
    expect(verified).toHaveLength(2);
    expect(input).toEqual(before);
    expect(Object.isFrozen(verified)).toBe(true);
    const first = verified[0];
    if (first === undefined) throw new Error('verified genesis event is missing');
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, 'to_state', 'DONE')).toBe(false);
  });

  it.each([
    [
      'sequence gap',
      /sequence/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).sequence = 3),
    ],
    [
      'duplicate ID',
      /duplicate event ID/,
      (events: ReturnType<typeof chain>) =>
        (eventAt(events, 1).event_id = eventAt(events, 0).event_id),
    ],
    [
      'decreasing ID',
      /strictly increasing/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).event_id = 'a'),
    ],
    [
      'broken previous hash',
      /chain hash gap/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).previous_hash = 'd'.repeat(64)),
    ],
    [
      'unknown state',
      /unknown/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).to_state = 'SKIPPED'),
    ],
    [
      'reverse transition',
      /illegal event transition/,
      (events: ReturnType<typeof chain>) => {
        eventAt(events, 1).from_state = 'READY';
        eventAt(events, 1).to_state = 'PLANNED';
      },
    ],
    [
      'evidence URI mismatch',
      /content-addressed/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).evidence_sha256 = 'e'.repeat(64)),
    ],
    [
      'target SHA mismatch',
      /target SHA/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).target_sha = 'short'),
    ],
    [
      'authority digest mismatch',
      /authority digest/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).authority_sha256 = 'short'),
    ],
    [
      'target continuity gap',
      /target_sha continuity/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).target_sha = 'd'.repeat(40)),
    ],
    [
      'program continuity gap',
      /program_id continuity/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).program_id = 'other'),
    ],
    [
      'invalid calendar timestamp',
      /timestamp/,
      (events: ReturnType<typeof chain>) =>
        (eventAt(events, 1).occurred_at = '2026-02-30T12:00:00.000Z'),
    ],
    [
      'unknown field',
      /schema/,
      (events: ReturnType<typeof chain>) => Object.assign(eventAt(events, 1), { unknown: true }),
    ],
    [
      'control character ID',
      /identifier/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).actor_id = 'agent\u0000hidden'),
    ],
    [
      'Bidi event ID',
      /identifier/,
      (events: ReturnType<typeof chain>) => (eventAt(events, 1).event_id = 's01-\u202e0002'),
    ],
  ])('rejects %s for the named invariant', (_name, error, mutate) => {
    const events = chain();
    mutate(events);
    events.forEach((value) => (value.event_hash = computeEventHash(value)));
    expect(() => verifyEventChain(bytes(events), policy)).toThrow(error);
  });

  it('rejects corrupt/truncated tails and missing final newline', () => {
    const valid = bytes(chain());
    expect(() => verifyEventChain(Buffer.concat([valid, Buffer.from('{')]), policy)).toThrow();
    expect(() => verifyEventChain(valid.subarray(0, -1), policy)).toThrow(/newline/);
  });

  it('rejects changed event bytes when the attacker does not recompute the hash', () => {
    const events = chain();
    eventAt(events, 1).actor_id = 'attacker';
    expect(() => verifyEventChain(bytes(events), policy)).toThrow(/event hash mismatch/);
  });

  it('removes only top-level event_hash when hashing', () => {
    const value = event(1, 'PLANNED', 'READY', '0'.repeat(64));
    const nested = { ...value, nested: { event_hash: 'must-remain' } } as typeof value & {
      nested: { event_hash: string };
    };
    const { event_hash: _ignored, ...payload } = nested;
    expect(computeEventHash(nested)).toBe(digest(canonicalJsonBytes(payload).toString()));
  });

  it('does not use UTF-16 ordering as an event identity authority', () => {
    const events = chain();
    const first = eventAt(events, 0);
    const second = eventAt(events, 1);
    first.event_id = `id-${String.fromCodePoint(0x10000)}`;
    second.event_id = `id-${String.fromCodePoint(0xe000)}`;
    events.forEach((value) => (value.event_hash = computeEventHash(value)));
    second.previous_hash = first.event_hash;
    second.event_hash = computeEventHash(second);
    expect(() => verifyEventChain(bytes(events), policy)).toThrow(/identifier/);
  });
});
