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
    expect(managerQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = managerQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO "sensor_temperature_latest"');
    expect(sql).toContain('ON CONFLICT ("tenantId", "sensorId") DO UPDATE');
    expect(sql).toContain('"sensor_temperature_latest"."measuredAt" < EXCLUDED."measuredAt"');
    expect(params).toEqual([TENANT, SENSOR, 13.2, new Date('2026-07-04T10:00:00.000Z')]);
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

  it('exposes SensorReading as its subscribed event type', () => {
    expect(listener.getEventType()).toBe('SensorReading');
  });
});
