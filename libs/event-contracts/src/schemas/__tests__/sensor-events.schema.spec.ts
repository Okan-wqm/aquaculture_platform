/**
 * SensorMetricIngestedEvent JSON Schema validator tests.
 *
 * Pins the contract:
 *   - Happy path with the minimal required fields.
 *   - Happy path with the optional farm/pond fields.
 *   - Rejects on unknown event type.
 *   - Rejects on extra field (additionalProperties: false).
 *   - Rejects on missing required field.
 *   - Rejects on wrong-type value (qualityCode > 3).
 *   - Rejects on out-of-range producerTs (pre-2024 or post-2100).
 *   - Rejects on non-UUID id fields.
 *   - Returns a one-line error string suitable for a warn log.
 */

import { validateSensorEvent, type SensorEventValidationResult } from '../validator';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const SENSOR_ID = '22222222-2222-2222-2222-222222222222';
const CHANNEL_ID = '33333333-3333-3333-3333-333333333333';
const EVENT_ID = '44444444-4444-4444-4444-444444444444';
const FARM_ID = '55555555-5555-5555-5555-555555555555';
const POND_ID = '66666666-6666-6666-6666-666666666666';
const PRODUCER_TS = 1_730_000_000_000; // 2024-10-27, in window
const UNIT_ID = '77777777-7777-7777-7777-777777777777';
const MEAL_ID = '88888888-8888-8888-8888-888888888888';
const DAY_PLAN_ID = '99999999-9999-9999-9999-999999999999';

function baseEvent(): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    eventType: 'SensorMetricIngested',
    timestamp: '2026-04-21T12:00:00.000Z',
    tenantId: TENANT_ID,
    version: 1,
    sensorId: SENSOR_ID,
    channelId: CHANNEL_ID,
    rawValue: 24.5,
    value: 24.5,
    qualityCode: 1,
    producerTs: PRODUCER_TS,
  };
}

function expectValid(result: SensorEventValidationResult): void {
  if (!result.valid) {
    throw new Error(`expected valid, got: ${result.errors}`);
  }
  expect(result.valid).toBe(true);
}

function expectInvalid(result: SensorEventValidationResult): {
  errors: string;
} {
  if (result.valid) {
    throw new Error('expected invalid, got valid');
  }
  return result;
}

describe('validateSensorEvent — SensorMetricIngested', () => {
  describe('happy path', () => {
    it('accepts the minimal required shape', () => {
      const result = validateSensorEvent('SensorMetricIngested', baseEvent());
      expectValid(result);
    });

    it('accepts the shape with optional farm + pond present', () => {
      const ev = { ...baseEvent(), farmId: FARM_ID, pondId: POND_ID };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectValid(result);
    });

    it('accepts the shape with optional aggregateId / aggregateType', () => {
      const ev = {
        ...baseEvent(),
        aggregateId: SENSOR_ID,
        aggregateType: 'Sensor',
      };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectValid(result);
    });
  });

  describe('rejection — discriminator + boundary', () => {
    it('rejects an unknown sensor event type', () => {
      const result = validateSensorEvent('SomethingElse', baseEvent());
      const { errors } = expectInvalid(result);
      expect(errors).toContain('Unknown sensor event type');
    });

    it('rejects when the discriminator field carries a wrong constant', () => {
      const ev = { ...baseEvent(), eventType: 'SensorReading' as unknown };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectInvalid(result);
    });

    it('rejects payload that is not a JSON object', () => {
      const result = validateSensorEvent('SensorMetricIngested', 'a string' as unknown);
      const { errors } = expectInvalid(result);
      expect(errors).toContain('JSON object');
    });
  });

  describe('rejection — extra / missing fields', () => {
    it('rejects an extra field (additionalProperties: false)', () => {
      const ev = { ...baseEvent(), htmlPayload: '<script>x</script>' };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      const { errors } = expectInvalid(result);
      // AJV reports the violating field path; the warn-log format keeps
      // the message short.
      expect(errors.length).toBeGreaterThan(0);
    });

    it.each([
      'eventId',
      'eventType',
      'timestamp',
      'tenantId',
      'version',
      'sensorId',
      'channelId',
      'rawValue',
      'value',
      'qualityCode',
      'producerTs',
    ])('rejects when required field "%s" is missing', (field) => {
      const ev = baseEvent();
      delete (ev as Record<string, unknown>)[field];
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectInvalid(result);
    });
  });

  describe('rejection — value bounds', () => {
    it.each([-1, 4, 1.5])('rejects qualityCode = %s (must be integer 0..=3)', (q) => {
      const ev = { ...baseEvent(), qualityCode: q };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectInvalid(result);
    });

    it('rejects producerTs before 2024-01-01', () => {
      const ev = { ...baseEvent(), producerTs: 1_703_999_999_999 };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectInvalid(result);
    });

    it('rejects producerTs after 2100-01-01', () => {
      const ev = { ...baseEvent(), producerTs: 4_102_444_800_001 };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectInvalid(result);
    });
  });

  describe('rejection — UUID format', () => {
    it.each(['eventId', 'tenantId', 'sensorId', 'channelId'])(
      'rejects non-UUID for "%s"',
      (field) => {
        const ev = { ...baseEvent(), [field]: 'not-a-uuid' };
        const result = validateSensorEvent('SensorMetricIngested', ev);
        expectInvalid(result);
      },
    );

    it('rejects non-UUID for the optional farmId when present', () => {
      const ev = { ...baseEvent(), farmId: 'not-a-uuid' };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectInvalid(result);
    });

    it('rejects non-UUID for the optional pondId when present', () => {
      const ev = { ...baseEvent(), pondId: 'not-a-uuid' };
      const result = validateSensorEvent('SensorMetricIngested', ev);
      expectInvalid(result);
    });
  });

  describe('error string contract', () => {
    it('returns a single-line error suitable for a warn log', () => {
      const ev = { ...baseEvent(), qualityCode: 99 };
      const { errors } = expectInvalid(validateSensorEvent('SensorMetricIngested', ev));
      // No newlines — keeps log pipelines tidy.
      expect(errors).not.toContain('\n');
    });
  });
});

function readinessEvent(): Record<string, unknown> {
  return {
    eventId: EVENT_ID,
    eventType: 'FeedingWindowReadiness',
    timestamp: '2026-04-21T12:00:00.000Z',
    tenantId: TENANT_ID,
    version: 1,
    schemaVersion: 'feeding-window-readiness/v1',
    sourceWindowEventId: FARM_ID,
    windowStart: '2026-04-21T12:05:00.000Z',
    windowEnd: '2026-04-21T12:20:00.000Z',
    evaluatedAt: '2026-04-21T12:00:00.000Z',
    batchIndex: 0,
    batchCount: 1,
    verdicts: [
      {
        unitId: UNIT_ID,
        unitCode: 'TANK-01',
        mealId: MEAL_ID,
        dayPlanId: DAY_PLAN_ID,
        scheduledAt: '2026-04-21T12:10:00.000Z',
        status: 'low_oxygen',
        minDissolvedOxygen: 5.5,
        observedDissolvedOxygen: 4.8,
        observedAt: '2026-04-21T11:58:00.000Z',
        lowOxygenReductionPercent: 50,
      },
    ],
  };
}

describe('validateSensorEvent — FeedingWindowReadiness v1', () => {
  it('accepts the complete batched verdict contract', () => {
    expectValid(validateSensorEvent('FeedingWindowReadiness', readinessEvent()));
  });

  it.each([
    ['schemaVersion', 'feeding-window-readiness/v0'],
    ['sourceWindowEventId', 'not-a-uuid'],
    ['batchIndex', -1],
    ['batchCount', 0],
  ])('rejects invalid envelope field %s', (field, value) => {
    expectInvalid(
      validateSensorEvent('FeedingWindowReadiness', {
        ...readinessEvent(),
        [field]: value,
      }),
    );
  });

  it('rejects a verdict with an unknown field or status', () => {
    const event = readinessEvent();
    const [verdict] = event['verdicts'] as Array<Record<string, unknown>>;
    expectInvalid(
      validateSensorEvent('FeedingWindowReadiness', {
        ...event,
        verdicts: [{ ...verdict, status: 'unknown', localGuess: true }],
      }),
    );
  });

  it('rejects an empty or oversized batch', () => {
    expectInvalid(
      validateSensorEvent('FeedingWindowReadiness', {
        ...readinessEvent(),
        verdicts: [],
      }),
    );
    expectInvalid(
      validateSensorEvent('FeedingWindowReadiness', {
        ...readinessEvent(),
        verdicts: Array.from({ length: 501 }, () => ({
          unitId: UNIT_ID,
          unitCode: 'TANK-01',
          mealId: MEAL_ID,
          dayPlanId: DAY_PLAN_ID,
          scheduledAt: '2026-04-21T12:10:00.000Z',
          status: 'ready',
          minDissolvedOxygen: 5.5,
        })),
      }),
    );
  });

  it.each([
    {
      name: 'batch coordinate outside the declared count',
      mutate: (event: Record<string, unknown>): Record<string, unknown> => ({
        ...event,
        batchIndex: 1,
      }),
    },
    {
      name: 'duplicate meal verdict',
      mutate: (event: Record<string, unknown>): Record<string, unknown> => ({
        ...event,
        verdicts: [
          ...(event['verdicts'] as Array<Record<string, unknown>>),
          ...(event['verdicts'] as Array<Record<string, unknown>>),
        ],
      }),
    },
    {
      name: 'ready verdict without an observation',
      mutate: (event: Record<string, unknown>): Record<string, unknown> => {
        const [verdict] = event['verdicts'] as Array<Record<string, unknown>>;
        const readyVerdict: Record<string, unknown> = { ...verdict, status: 'ready' };
        delete readyVerdict['observedDissolvedOxygen'];
        delete readyVerdict['observedAt'];
        return {
          ...event,
          verdicts: [readyVerdict],
        };
      },
    },
    {
      name: 'oxygen status contradicting the observed value',
      mutate: (event: Record<string, unknown>): Record<string, unknown> => {
        const [verdict] = event['verdicts'] as Array<Record<string, unknown>>;
        return {
          ...event,
          verdicts: [{ ...verdict, status: 'ready' }],
        };
      },
    },
  ])('rejects semantic contradiction: $name', ({ mutate }) => {
    expectInvalid(validateSensorEvent('FeedingWindowReadiness', mutate(readinessEvent())));
  });
});
