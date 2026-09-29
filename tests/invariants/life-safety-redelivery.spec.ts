/**
 * INVARIANT (V-S1a-3): a life-safety event outlives an outage before it is
 * dead-lettered, and a dead-lettered one pages the operator.
 *
 * WHY: farm alarms and escalated pages were consumed with the bus default —
 * five deliveries, dead-lettered after ~30 seconds — so an auth-service
 * restart or the notification rate-limit window (60 s) was enough to lose a
 * page. `LIFE_SAFETY_REDELIVERY` (applied by the bus to every event type the
 * contract marks `requiresLifeSafetyRedelivery`) spans an hour; this spec
 * keeps three things from drifting apart:
 *
 *   1. the budget really spans at least an hour;
 *   2. the dead-letter alert selects EXACTLY the life-safety event types — a
 *      type added to the contract but not to the alert would dead-letter
 *      silently, a type in the alert but not the contract would page on
 *      events that never had the long budget;
 *   3. SensorReading (continuous telemetry) is not in the set.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

import {
  LIFE_SAFETY_REDELIVERY_EVENT_TYPES,
  requiresLifeSafetyRedelivery,
} from '../../libs/event-contracts/src/event-delivery-semantics';
import {
  LIFE_SAFETY_REDELIVERY,
  redeliverySpanMs,
} from '../../platform/libs/event-bus/src/interfaces/redelivery-policy';

const RULES = resolve(
  __dirname,
  '..',
  '..',
  'infrastructure/monitoring/droplet/rules/60-dataflow-integrity.yml',
);

interface Rule {
  alert?: string;
  expr: string;
}

function deadLetterAlertEventTypes(): string[] {
  const doc = yaml.load(readFileSync(RULES, 'utf8')) as { groups: Array<{ rules?: Rule[] }> };
  const rule = doc.groups
    .flatMap((group) => group.rules ?? [])
    .find((candidate) => candidate.alert === 'LifeSafetyAlarmDeadLettered');
  expect(rule).toBeDefined();
  const match = /event_type=~"([^"]+)"/.exec(rule?.expr ?? '');
  expect(match).not.toBeNull();
  return (match?.[1] ?? '').split('|');
}

describe('INVARIANT: life-safety redelivery budget and its dead-letter alert (V-S1a-3)', () => {
  it('spans at least one hour of capped exponential backoff', () => {
    // SCENARIO: the derived budget. EXPECTS: ≥ 60 minutes between first and last delivery.
    expect(redeliverySpanMs(LIFE_SAFETY_REDELIVERY)).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(LIFE_SAFETY_REDELIVERY.maxBackoffMs).toBeGreaterThan(60 * 1000);
  });

  it('pages on dead letters of exactly the life-safety event types', () => {
    // SCENARIO: the alert's event_type regex vs the contract's set.
    // EXPECTS: the same set, both ways.
    expect([...deadLetterAlertEventTypes()].sort()).toEqual(
      [...LIFE_SAFETY_REDELIVERY_EVENT_TYPES].sort(),
    );
  });

  it('keeps continuous telemetry out and the alarm hand-offs in', () => {
    expect(requiresLifeSafetyRedelivery('SensorReading')).toBe(false);
    for (const eventType of ['AlertEscalated', 'AlertTriggered', 'WaterQualityCritical']) {
      expect(requiresLifeSafetyRedelivery(eventType)).toBe(true);
    }
  });
});
