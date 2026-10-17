import { validateFarmEvent, validateSensorEvent } from '../validator';

/**
 * Trust-boundary validation of the additive `siteId` the alarm-raising
 * signals carry (ALERT-MEDIUM-010). alert-engine places the alarm it records
 * on that site. Every wire schema is `additionalProperties: false`, so a
 * field the schema does not name would drop the whole event at the boundary
 * — a life-safety alarm lost for a label. These tests pin both directions:
 * the site passes, an event without it still passes (minted before the
 * field), and a site that is not a UUID is refused.
 */
const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UNIT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLAN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MEAL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function base(eventType: string): Record<string, unknown> {
  return {
    eventId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    eventType,
    timestamp: '2026-10-17T08:00:00.000Z',
    tenantId: TENANT,
    version: 1,
  };
}

const FARM_SIGNALS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  [
    'MealUnderfed',
    {
      ...base('MealUnderfed'),
      scope: 'meal',
      unitId: UNIT,
      unitCode: 'T1',
      dayPlanId: PLAN,
      mealId: MEAL,
      plannedKg: 10,
      actualKg: 6,
      variancePercent: -40,
      thresholdPercent: 15,
    },
  ],
  [
    'MealMissed',
    {
      ...base('MealMissed'),
      unitId: UNIT,
      unitCode: 'T1',
      mealId: MEAL,
      dayPlanId: PLAN,
      scheduledAt: '2026-10-17T06:00:00.000Z',
    },
  ],
  [
    'FeedTypeTransitioned',
    {
      ...base('FeedTypeTransitioned'),
      unitId: UNIT,
      unitCode: 'T1',
      assignmentId: PLAN,
      toFeedId: MEAL,
      toFeedCode: 'G4',
      bandIndex: 1,
      avgWeightG: 120,
      automatic: true,
    },
  ],
  [
    'MortalityAlertRaised',
    {
      ...base('MortalityAlertRaised'),
      batchId: UNIT,
      alertType: 'daily_rate',
      severity: 'critical',
      message: 'Daily mortality rate 3.00% exceeds critical threshold',
      mortalityRate: 3,
      reason: 'DISEASE',
      recordedAt: '2026-10-17T07:00:00.000Z',
    },
  ],
];

describe('alarm-raising farm signals carry an optional site (ALERT-MEDIUM-010)', () => {
  it.each(FARM_SIGNALS)('%s accepts a site UUID', (eventType, event) => {
    expect(validateFarmEvent(eventType, { ...event, siteId: SITE }).valid).toBe(true);
  });

  it.each(FARM_SIGNALS)('%s still accepts an event minted without one', (eventType, event) => {
    expect(validateFarmEvent(eventType, event).valid).toBe(true);
  });

  it.each(FARM_SIGNALS)('%s refuses a site that is not a UUID', (eventType, event) => {
    expect(validateFarmEvent(eventType, { ...event, siteId: 'site-1' }).valid).toBe(false);
  });
});

describe('FeedingWindowReadiness carries the DO sensor’s optional site (ALERT-MEDIUM-010)', () => {
  const readiness = {
    ...base('FeedingWindowReadiness'),
    unitId: UNIT,
    unitCode: 'T1',
    mealId: MEAL,
    dayPlanId: PLAN,
    scheduledAt: '2026-10-17T08:00:00.000Z',
    status: 'no_reading',
    minDissolvedOxygen: 6,
  };

  it('accepts a site UUID and an event without one', () => {
    expect(
      validateSensorEvent('FeedingWindowReadiness', { ...readiness, siteId: SITE }).valid,
    ).toBe(true);
    expect(validateSensorEvent('FeedingWindowReadiness', readiness).valid).toBe(true);
  });

  it('refuses a site that is not a UUID', () => {
    expect(
      validateSensorEvent('FeedingWindowReadiness', { ...readiness, siteId: 'nope' }).valid,
    ).toBe(false);
  });
});
