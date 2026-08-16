/**
 * SensorTemperatureProjectionListener — projects SensorReading events into the
 * farm sensor_temperature_latest read model (Phase 2b).
 */
import { createBaseEvent } from '@platform/event-contracts';
import type { BaseEvent, SensorReadingEvent } from '@platform/event-contracts';
import type { DataSource } from 'typeorm';
import type { SensorTemperatureRecalcAuthority } from '../../../feeding-protocol/services/sensor-temperature-recalc.authority';

function mock<T>(implementation: Partial<T>): T {
  return implementation as T;
}

const managerQuery = jest.fn().mockResolvedValue(undefined);
const transactionSession = Object.freeze({ scope: 'sensor-temperature-test-session' });
const runInTenantTransaction = jest.fn(
  async (
    _ds: unknown,
    _schema: string,
    _tenantId: string,
    cb: (
      qr: { manager: { query: typeof managerQuery } },
      session: typeof transactionSession,
    ) => Promise<void>,
  ) => cb({ manager: { query: managerQuery } }, transactionSession),
);

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (
    ds: unknown,
    schema: string,
    tenantId: string,
    cb: (
      qr: { manager: { query: typeof managerQuery } },
      session: typeof transactionSession,
    ) => Promise<void>,
  ) => runInTenantTransaction(ds, schema, tenantId, cb),
}));

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
  const recalcAffectedUnits = jest.fn().mockResolvedValue(1);
  const recalcAuthority = mock<SensorTemperatureRecalcAuthority>({ recalcAffectedUnits });
  const listener = new SensorTemperatureProjectionListener(mock<DataSource>({}), recalcAuthority);

  beforeEach(() => {
    managerQuery.mockReset();
    managerQuery.mockResolvedValueOnce([{ sensorId: SENSOR }]).mockResolvedValueOnce([]);
    runInTenantTransaction.mockClear();
    recalcAffectedUnits.mockClear();
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
    expect(sql).toContain('RETURNING "sensorId"');
    expect(params).toEqual([TENANT, SENSOR, 13.2, new Date('2026-07-04T10:00:00.000Z')]);
  });

  it('requests one bounded recalc in the same transaction only when latest advances', async () => {
    await listener.handle(makeEvent({}));

    expect(recalcAffectedUnits).toHaveBeenCalledWith(
      expect.objectContaining({ query: managerQuery }),
      transactionSession,
      TENANT,
      SENSOR,
      13.2,
    );
  });

  it('does not reprice current plans when a stale/redelivered reading loses newest-wins CAS', async () => {
    managerQuery.mockReset();
    managerQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    await listener.handle(makeEvent({}));

    expect(managerQuery).toHaveBeenCalledTimes(2);
    expect(recalcAffectedUnits).not.toHaveBeenCalled();
  });

  it('accumulates the daily rollup with a watermark guard for idempotency (RPT-005)', async () => {
    await listener.handle(makeEvent({}));
    const [sql, params] = managerQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "sensor_temperature_daily"');
    expect(sql).toContain('"sampleCount" = "sensor_temperature_daily"."sampleCount" + 1');
    expect(sql).toContain('LEAST("sensor_temperature_daily"."minC", EXCLUDED."minC")');
    expect(sql).toContain('GREATEST("sensor_temperature_daily"."maxC", EXCLUDED."maxC")');
    // Watermark: only advance on a strictly newer reading (redelivery-safe).
    expect(sql).toContain(
      '"sensor_temperature_daily"."lastMeasuredAt" < EXCLUDED."lastMeasuredAt"',
    );
    // day bucket is the UTC date of the reading; value + measuredAt follow.
    expect(params).toEqual([
      TENANT,
      SENSOR,
      '2026-07-04',
      13.2,
      new Date('2026-07-04T10:00:00.000Z'),
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
