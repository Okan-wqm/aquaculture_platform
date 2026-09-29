import { validateEventBySubject } from '@platform/event-contracts';

import {
  ParameterStatus,
  WaterQualityMeasurement,
  WaterQualityStatus,
} from '../entities/water-quality-measurement.entity';
import { buildWaterQualityCriticalEvent } from '../services/water-quality-critical-event.builder';

/**
 * ALERT-MEDIUM-007 — the life-safety WaterQualityCritical event names the site
 * the measured unit belongs to and the person who took the reading, and is the
 * ONE shape both create paths enqueue.
 */
const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const EQUIPMENT_ID = '22222222-2222-4222-8222-222222222222';

function measurement(overrides: Partial<WaterQualityMeasurement> = {}): WaterQualityMeasurement {
  return Object.assign(new WaterQualityMeasurement(), {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT_ID,
    equipmentId: EQUIPMENT_ID,
    tankId: undefined,
    measuredAt: new Date('2026-09-29T04:10:00.000Z'),
    measuredBy: 'operator-7',
    hasAlarm: true,
    overallStatus: WaterQualityStatus.CRITICAL,
    summary: {
      overallStatus: WaterQualityStatus.CRITICAL,
      criticalCount: 1,
      warningCount: 0,
      optimalCount: 1,
      recommendations: [],
      evaluations: [
        {
          parameter: 'dissolved_oxygen',
          value: 2.1,
          unit: 'mg/L',
          status: ParameterStatus.CRITICAL_LOW,
          criticalMin: 4,
        },
        { parameter: 'ph', value: 7.2, unit: '', status: ParameterStatus.OPTIMAL },
      ],
    },
    ...overrides,
  });
}

describe('buildWaterQualityCriticalEvent', () => {
  it('names the site and the actor, and carries only the critical parameters', () => {
    // SCENARIO: a manual reading with dissolved oxygen below its critical floor.
    // EXPECTS: siteId from the resolved unit site, userId = who measured, one
    //          critical parameter serialized flat (ARCH-C01).
    const event = buildWaterQualityCriticalEvent({
      tenantId: TENANT_ID,
      measurement: measurement(),
      siteId: SITE_ID,
    });

    expect(event).toMatchObject({
      eventType: 'WaterQualityCritical',
      tenantId: TENANT_ID,
      userId: 'operator-7',
      siteId: SITE_ID,
      equipmentId: EQUIPMENT_ID,
      tankId: null,
      criticalParameterCount: 1,
      measuredAt: '2026-09-29T04:10:00.000Z',
    });
    expect(JSON.parse(event?.criticalParametersJson ?? '[]')).toEqual([
      expect.objectContaining({ code: 'dissolved_oxygen', threshold: 4, direction: 'below' }),
    ]);
  });

  it('omits siteId when the unit resolves to no site (pond-only / site-less department)', () => {
    // SCENARIO: the site resolver returned null.
    // EXPECTS: no siteId key at all — the alert engine then widens site roles.
    const event = buildWaterQualityCriticalEvent({
      tenantId: TENANT_ID,
      measurement: measurement(),
      siteId: null,
    });
    expect(event).not.toBeNull();
    expect(event && 'siteId' in event).toBe(false);
  });

  it('always satisfies the bus-level trust-boundary schema, with and without a site', () => {
    // SCENARIO: the builder is the ONE producer; the bus validates the subject's
    //           schema on the consumer side before alert-engine sees the event.
    // EXPECTS: the wire form (JSON round trip, as the outbox ships it) is valid in
    //          both shapes — a producer/schema drift would dead-letter a real alarm.
    const subject = `events.${TENANT_ID}.WaterQualityCritical`;
    for (const siteId of [SITE_ID, null]) {
      const event = buildWaterQualityCriticalEvent({
        tenantId: TENANT_ID,
        measurement: measurement({ measuredBy: '44444444-4444-4444-8444-444444444444' }),
        siteId,
      });
      const wire: unknown = JSON.parse(JSON.stringify(event));
      expect({ siteId, result: validateEventBySubject(subject, wire) }).toEqual({
        siteId,
        result: { valid: true },
      });
    }
  });

  it('raises nothing when no parameter is critical', () => {
    // SCENARIO: an alarm flag without a critical evaluation, or no alarm at all.
    // EXPECTS: null — the life-safety event is reserved for critical bands.
    const warningOnly = measurement({
      summary: {
        overallStatus: WaterQualityStatus.WARNING,
        criticalCount: 0,
        warningCount: 1,
        optimalCount: 0,
        recommendations: [],
        evaluations: [{ parameter: 'ph', value: 6.4, unit: '', status: ParameterStatus.LOW }],
      },
    });
    expect(
      buildWaterQualityCriticalEvent({
        tenantId: TENANT_ID,
        measurement: warningOnly,
        siteId: SITE_ID,
      }),
    ).toBeNull();
    expect(
      buildWaterQualityCriticalEvent({
        tenantId: TENANT_ID,
        measurement: measurement({ hasAlarm: false }),
        siteId: SITE_ID,
      }),
    ).toBeNull();
  });
});
