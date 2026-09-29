import { createHash } from 'node:crypto';

import { JsonValue, parseStrictJson } from './strict-json';

export interface EventPolicy {
  readonly schema_version: '1.0.0';
  readonly contract_id: 'new-aria-progress-event-policy-v1';
  readonly event_contract_id: 'aria-event-cjson-v1';
  readonly states: readonly string[];
  readonly transitions: Readonly<Record<string, readonly string[]>>;
}

const requiredStates = Object.freeze([
  'PLANNED',
  'READY',
  'IN_PROGRESS',
  'VERIFYING',
  'DONE',
  'BLOCKED',
  'SUPERSEDED',
] as const);
const requiredTransitions: Readonly<Record<string, readonly string[]>> = Object.freeze({
  PLANNED: Object.freeze(['READY', 'BLOCKED', 'SUPERSEDED']),
  READY: Object.freeze(['IN_PROGRESS', 'BLOCKED', 'SUPERSEDED']),
  IN_PROGRESS: Object.freeze(['VERIFYING', 'BLOCKED', 'SUPERSEDED']),
  VERIFYING: Object.freeze(['DONE', 'BLOCKED', 'SUPERSEDED']),
  DONE: Object.freeze([]),
  BLOCKED: Object.freeze(['READY', 'SUPERSEDED']),
  SUPERSEDED: Object.freeze([]),
});

const exactKeys = (value: Record<string, JsonValue>, expected: readonly string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

const isRecord = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function loadEventPolicy(bytes: Uint8Array): EventPolicy {
  const value = parseStrictJson(bytes);
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schema_version',
      'contract_id',
      'event_contract_id',
      'states',
      'transitions',
    ])
  ) {
    throw new TypeError('event policy schema is open or incomplete');
  }
  if (
    value.schema_version !== '1.0.0' ||
    value.contract_id !== 'new-aria-progress-event-policy-v1' ||
    value.event_contract_id !== 'aria-event-cjson-v1' ||
    !Array.isArray(value.states) ||
    value.states.length === 0 ||
    value.states.some((state) => typeof state !== 'string' || state.length === 0) ||
    new Set(value.states).size !== value.states.length ||
    !isRecord(value.transitions as JsonValue) ||
    !exactKeys(value.transitions as { [key: string]: JsonValue }, value.states as string[])
  ) {
    throw new TypeError('event policy identity, states, or transitions are invalid');
  }
  const states = new Set(value.states as string[]);
  for (const destinations of Object.values(value.transitions as { [key: string]: JsonValue })) {
    if (
      !Array.isArray(destinations) ||
      destinations.some((state) => typeof state !== 'string' || !states.has(state)) ||
      new Set(destinations).size !== destinations.length
    ) {
      throw new TypeError('event policy transition target is invalid');
    }
  }
  if (
    JSON.stringify(value.states) !== JSON.stringify(requiredStates) ||
    requiredStates.some(
      (state) =>
        JSON.stringify((value.transitions as Record<string, JsonValue>)[state]) !==
        JSON.stringify(requiredTransitions[state]),
    )
  ) {
    throw new TypeError('event policy literal states or transitions drifted');
  }
  return Object.freeze({
    schema_version: '1.0.0',
    contract_id: 'new-aria-progress-event-policy-v1',
    event_contract_id: 'aria-event-cjson-v1',
    states: requiredStates,
    transitions: requiredTransitions,
  });
}

export function eventPolicySha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
