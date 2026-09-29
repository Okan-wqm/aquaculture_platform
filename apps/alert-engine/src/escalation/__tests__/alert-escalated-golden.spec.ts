/**
 * GOLDEN (V-S1a-8): the AlertEscalated alert-engine PRODUCES is, field for
 * field, the one notification-service is proven to CONSUME.
 *
 * WHY: the two halves of the alarm path are tested in two services that cannot
 * import each other; they meet at `libs/event-contracts/fixtures/
 * alert-escalated.json` — notification-service's Postgres spec delivers
 * exactly that fixture. A hand-written fixture only proves the two halves
 * agree with the file, not with each other: the builder could drift
 * semantically (a renamed role array, a lost site) and both halves would still
 * pass. This spec runs the REAL escalation path (planner + builder + claim) on
 * the fixture's incident and compares the enqueued event with the fixture,
 * masking only the per-event identity (`eventId`, `timestamp`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  buildEscalationHarness,
  firstEnqueued,
  incident,
} from '../../__tests__/support/escalation-manager.harness';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

const FIXTURE = resolve(
  __dirname,
  '../../../../../libs/event-contracts/fixtures/alert-escalated.json',
);

function masked(event: unknown): Record<string, unknown> {
  const wire = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  return { ...wire, eventId: '<eventId>', timestamp: '<timestamp>' };
}

describe('AlertEscalated golden — producer output equals the consumed fixture (V-S1a-8)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('builds exactly the fixture from the fixture incident through the default policy', async () => {
    // SCENARIO: the fixture's incident (a critical DO excursion at site S, keyed by
    //           its equipment) escalates through the seeded default policy.
    // EXPECTS: the enqueued event equals the fixture, ids masked.
    const fixture: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const expected = masked(fixture);
    const harness = await buildEscalationHarness();

    await harness.service.startEscalation(
      incident({
        id: String(expected['alertId']),
        tenantId: String(expected['tenantId']),
        signalKey: String(expected['signalKey']),
        siteId: String(expected['siteId']),
        title: String(expected['title']),
        description: String(expected['description']),
        severity: AlertSeverity.CRITICAL,
      }),
      { severity: AlertSeverity.CRITICAL },
    );

    expect(masked(firstEnqueued(harness.outbox))).toEqual(expected);
  });
});
