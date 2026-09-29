/**
 * WaterQualityCritical trust-boundary schema (ALERT-MEDIUM-007).
 *
 * The event is the life-safety alarm's input and now carries the `siteId` that
 * decides who is paged. These cases pin the wire contract the bus enforces
 * through `validateEventBySubject` for every consumer:
 *   - the maximal event (site + actor) and the site-less event both pass;
 *   - a malformed site, an unknown field, or a missing unit field is refused;
 *   - the check is anchored to the SUBJECT, as the bus runs it.
 */
import { validateEventBySubject } from '../validator';
import { WATER_QUALITY_EVENT_SCHEMAS } from '../water-quality-events.schema';

const SUBJECT = 'events.11111111-1111-4111-8111-111111111111.WaterQualityCritical';

function critical(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: '55555555-5555-4555-8555-555555555555',
    eventType: 'WaterQualityCritical',
    timestamp: '2026-09-29T04:12:00.000Z',
    tenantId: '11111111-1111-4111-8111-111111111111',
    version: 1,
    aggregateId: '66666666-6666-4666-8666-666666666666',
    aggregateType: 'WaterQualityMeasurement',
    userId: '77777777-7777-4777-8777-777777777777',
    measurementId: '66666666-6666-4666-8666-666666666666',
    equipmentId: '22222222-2222-4222-8222-222222222222',
    tankId: null,
    criticalParametersJson: JSON.stringify([
      { code: 'do', name: 'do', value: 2.1, threshold: 4, direction: 'below', unit: 'mg/L' },
    ]),
    criticalParameterCount: 1,
    measuredAt: '2026-09-29T04:10:00.000Z',
    siteId: '33333333-3333-4333-8333-333333333333',
    ...overrides,
  };
}

describe('WaterQualityCritical schema (ALERT-MEDIUM-007)', () => {
  it('is registered for the bus-level subject check', () => {
    // SCENARIO: the bus validates by subject before any handler runs.
    // EXPECTS: WaterQualityCritical has a compiled schema (not the pass-through).
    expect(Object.keys(WATER_QUALITY_EVENT_SCHEMAS)).toEqual(['WaterQualityCritical']);
    expect(validateEventBySubject(SUBJECT, { anything: true }).valid).toBe(false);
  });

  it('accepts the event with its site and actor', () => {
    // SCENARIO: a manual critical DO reading on a unit whose department has a site.
    // EXPECTS: valid — every field the producer sets is declared.
    expect(validateEventBySubject(SUBJECT, critical())).toEqual({ valid: true });
  });

  it('accepts a site-less event (older producer, or a unit with no site)', () => {
    // SCENARIO: the event predates siteId, or the unit resolves to no site.
    // EXPECTS: valid — recipients then widen to the tenant downstream.
    const { siteId: _site, userId: _user, ...siteless } = critical();
    expect(validateEventBySubject(SUBJECT, siteless)).toEqual({ valid: true });
  });

  it('refuses a site that is not a uuid', () => {
    // SCENARIO: a corrupted or hand-made site id.
    // EXPECTS: invalid — a wrong site would page the wrong people.
    const result = validateEventBySubject(SUBJECT, critical({ siteId: 'site-a' }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('/siteId');
  });

  it('refuses an undeclared field and a missing unit field', () => {
    // SCENARIO: a producer drifts from the contract.
    // EXPECTS: invalid both ways — the event stays flat and complete.
    expect(validateEventBySubject(SUBJECT, critical({ severity: 'critical' })).valid).toBe(false);
    const { equipmentId: _unit, ...missingUnit } = critical();
    expect(validateEventBySubject(SUBJECT, missingUnit).valid).toBe(false);
  });
});
