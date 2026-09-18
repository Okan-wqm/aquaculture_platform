/**
 * SensorTemperatureProjectionListener — projects SensorReading events into the
 * farm sensor_temperature_latest read model (Phase 2b).
 */
import { createBaseEvent } from '@platform/event-contracts';
import type { BaseEvent, SensorReadingEvent } from '@platform/event-contracts';
import type { DataSource } from 'typeorm';

const managerQuery = jest.fn().mockResolvedValue(undefined);
const runInTenantTransaction = jest.fn(
  async (
    _ds: unknown,
    _schema: string,
    _tenantId: string,
    cb: (qr: { manager: { query: typeof managerQuery } }) => Promise<void>,
  ) => cb({ manager: { query: managerQuery } }),
);

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (
    ds: unknown,
    schema: string,
    tenantId: string,
    cb: (qr: { manager: { query: typeof managerQuery } }) => Promise<void>,
  ) => runInTenantTransaction(ds, schema, tenantId, cb),
}));

import { deriveEventId } from '@platform/event-contracts';

import { SensorTemperatureProjectionListener } from '../sensor-temperature-projection.listener';

const TENANT = 'aaaaaaaa-1111-4222-8333-444444444444';
const SENSOR = 'cccccccc-3333-4444-8555-666666666666';

function makeEvent(overrides: Partial<SensorReadingEvent> = {}): BaseEvent {
  return {
    ...createBaseEvent<SensorReadingEvent>('SensorReading', TENANT, {
      aggregateId: SENSOR,
      aggregateType: 'Sensor',
    }),
    timestamp: '2026-07-04T10:00:00.000Z',
    sensorId: SENSOR,
    readingTemperature: 13.2,
    ...overrides,
  };
}

describe('SensorTemperatureProjectionListener', () => {
  const listener = new SensorTemperatureProjectionListener({} as DataSource);

  beforeEach(() => {
    managerQuery.mockClear();
    runInTenantTransaction.mockClear();
  });

  it('upserts the latest temperature for the sensor (newest-wins guard in SQL)', async () => {
    await listener.handle(makeEvent({}));
    expect(runInTenantTransaction).toHaveBeenCalledTimes(1);
    // Two writes in the one transaction: latest read-model + daily rollup.
    expect(managerQuery).toHaveBeenCalledTimes(2);
    const [sql, params] = managerQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "sensor_temperature_latest"');
    expect(sql).toContain('ON CONFLICT ("tenantId", "sensorId") DO UPDATE');
    expect(sql).toContain('"sensor_temperature_latest"."measuredAt" < EXCLUDED."measuredAt"');
    // Equal-millisecond distinct events still advance (identity tie-break).
    expect(sql).toContain('IS DISTINCT FROM EXCLUDED."lastEventId"');
    expect(params).toEqual([
      TENANT,
      SENSOR,
      13.2,
      new Date('2026-07-04T10:00:00.000Z'),
      expect.any(String),
    ]);
  });

  it('deduplicates by EVENT IDENTITY, not just time (Task 1.5)', async () => {
    const event = makeEvent({ eventId: deriveEventId('tenant\u0000sensor\u0000ts\u0000sha') });
    await listener.handle(event);

    const latestSql = String(managerQuery.mock.calls[0]![0]);
    const dailySql = String(managerQuery.mock.calls[1]![0]);
    // Identity watermark: a redelivered event (same eventId) is a no-op; a
    // DIFFERENT event at the same millisecond still counts.
    expect(latestSql).toContain('"lastEventId"');
    expect(latestSql).toContain('IS DISTINCT FROM EXCLUDED."lastEventId"');
    expect(dailySql).toContain(
      '"sensor_temperature_daily"."lastEventId" IS DISTINCT FROM EXCLUDED."lastEventId"',
    );
    expect(managerQuery.mock.calls[1]![1]).toContain((event as SensorReadingEvent).eventId);
  });

  it('accumulates the daily rollup with an event-identity watermark (RPT-005 / Task 1.5)', async () => {
    await listener.handle(makeEvent({}));
    const [sql, params] = managerQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "sensor_temperature_daily"');
    expect(sql).toContain('"sampleCount" = "sensor_temperature_daily"."sampleCount" + 1');
    expect(sql).toContain('LEAST("sensor_temperature_daily"."minC", EXCLUDED."minC")');
    expect(sql).toContain('GREATEST("sensor_temperature_daily"."maxC", EXCLUDED."maxC")');
    // Identity watermark (Task 1.5): the same eventId never counts twice.
    expect(sql).toContain(
      '"sensor_temperature_daily"."lastEventId" IS DISTINCT FROM EXCLUDED."lastEventId"',
    );
    // day bucket is the UTC date of the reading; value + measuredAt + the
    // event's own deterministic identity follow.
    expect(params).toEqual([
      TENANT,
      SENSOR,
      '2026-07-04',
      13.2,
      new Date('2026-07-04T10:00:00.000Z'),
      expect.any(String),
    ]);
  });

  it('skips readings with no temperature', async () => {
    await listener.handle(makeEvent({ readingTemperature: undefined }));
    expect(runInTenantTransaction).not.toHaveBeenCalled();
  });

  it('skips events with an invalid tenantId (fail-closed)', async () => {
    await listener.handle(makeEvent({ tenantId: 'not-a-uuid' }));
    expect(runInTenantTransaction).not.toHaveBeenCalled();
  });

  it('skips events whose sensorId is not a UUID', async () => {
    await listener.handle(makeEvent({ sensorId: 'bad' }));
    expect(runInTenantTransaction).not.toHaveBeenCalled();
  });

  it('drops readings outside the plausible temperature bounds (GSEC-MEDIUM-002)', async () => {
    await listener.handle(makeEvent({ readingTemperature: 87 }));
    await listener.handle(makeEvent({ readingTemperature: -40 }));
    await listener.handle(makeEvent({ readingTemperature: Number.POSITIVE_INFINITY }));
    expect(runInTenantTransaction).not.toHaveBeenCalled();
  });

  it('drops readings with a far-future timestamp so newest-wins cannot be pinned (GSEC-MEDIUM-002)', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString(); // +1h > 5min skew
    await listener.handle(makeEvent({ timestamp: future }));
    expect(runInTenantTransaction).not.toHaveBeenCalled();
  });

  it('exposes SensorReading as its subscribed event type', () => {
    expect(listener.getEventType()).toBe('SensorReading');
  });
});
