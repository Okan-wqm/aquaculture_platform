import type { SensorChannelKey } from '@platform/event-contracts';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../../__tests__/support/sensor-rls-postgres.harness';
import { SensorDataChannel } from '../../../database/entities/sensor-data-channel.entity';
import { SensorMetric } from '../../../database/entities/sensor-metric.entity';
import { SensorProtocol } from '../../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../../database/entities/sensor.entity';
import { ChannelDescriptionService } from '../channel-description.service';

/**
 * What a channel is, by (sensorId, channelKey), on real Postgres under FORCE
 * RLS with a non-owner runtime role: the answer behind farm's bindings and the
 * channelsByKey query. One entry per asked key in request order; disabled
 * channels and inactive sensors described, not dropped; rows of another
 * tenant — even inside this tenant's schema — are no sensor; a sample is never
 * paired with a unit newer than itself.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const SYSTEM = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const TANK = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
const ENTITIES = [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition];

const GOOD = 192;
const BAD_SENSOR_FAILURE = 4;

jest.setTimeout(180_000);

interface ChannelSeed {
  key: string;
  unit: string | null;
  enabled?: boolean;
  declared?: string;
  configuredMinutesAgo?: number;
  /** [minutes ago, value, quality code] */
  samples?: Array<[number, number, number]>;
}

describe('ChannelDescriptionService under FORCE RLS', () => {
  let stage: SensorRlsHarness | undefined;
  let service: ChannelDescriptionService;
  const sensorIds: Record<string, string> = {};
  const now = Date.now();
  const ago = (minutes: number): Date => new Date(now - minutes * 60_000);

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'channel_description',
      tenants: [TENANT_A],
      entities: ENTITIES,
      beforeRls: async ({ admin, schema }) => {
        const sensor = async (
          name: string,
          tenantId: string,
          active: boolean,
          channels: ChannelSeed[],
        ): Promise<void> => {
          const [row] = await admin.query(
            `INSERT INTO "${schema}".sensors
                 (tenant_id, name, serial_number, type, status, is_active, site_id, system_id, tank_id)
               VALUES ($1, $2, $2, 'multi_parameter', 'active', $3, $4, $5, $6) RETURNING id`,
            [tenantId, name, active, SITE, SYSTEM, TANK],
          );
          sensorIds[name] = row.id;
          for (const channel of channels) {
            const [created] = await admin.query(
              `INSERT INTO "${schema}".sensor_data_channels
                   (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
                    is_enabled, display_order, declared_quantity, next_calibration_due,
                    measurement_configured_at)
                 VALUES ($1, $2, $3, $3, 'number', $4, $3, $5, 0, $6, $7, $8) RETURNING id`,
              [
                row.id,
                tenantId,
                channel.key,
                channel.unit,
                channel.enabled ?? true,
                channel.declared ?? null,
                new Date(now + 86_400_000),
                channel.configuredMinutesAgo === undefined
                  ? null
                  : ago(channel.configuredMinutesAgo),
              ],
            );
            for (const [minutes, value, quality] of channel.samples ?? []) {
              await admin.query(
                `INSERT INTO "${schema}".sensor_metrics
                     (time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code, source_protocol)
                   VALUES ($1, $2, $3, $4, $5, $5, $6, 'mqtt')`,
                [ago(minutes), row.id, created.id, tenantId, value, quality],
              );
            }
          }
        };
        await sensor('sonde', TENANT_A, true, [
          // The newest sample is BAD: described with its band, not skipped.
          {
            key: 'ammonia',
            unit: 'mg/L',
            declared: 'tan',
            samples: [
              [30, 0.41, GOOD],
              [5, 0.44, BAD_SENSOR_FAILURE],
            ],
          },
          { key: 'ph', unit: null },
          // Disabled after an incident; its last sample is older than the window.
          { key: 'orp', unit: 'mV', enabled: false, samples: [[8 * 24 * 60, 210, GOOD]] },
          // Re-labelled 10 minutes ago; the only sample predates the new unit.
          { key: 'h2s', unit: 'µg/L', configuredMinutesAgo: 10, samples: [[20, 0.015, GOOD]] },
          // A stored declaration the key does not allow reads as no quantity.
          { key: 'temperature', unit: '°C', declared: 'tan' },
        ]);
        await sensor('retired', TENANT_A, false, [{ key: 'salinity', unit: 'ppt' }]);
        // Another tenant's rows inside this tenant's schema: only RLS hides them.
        await sensor('intruder', TENANT_B, true, [
          { key: 'ammonia', unit: 'mg/L', samples: [[1, 9.9, GOOD]] },
        ]);
      },
    });
    service = new ChannelDescriptionService(stage.runtime);
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  it('describes each asked key in request order, duplicates included', async () => {
    const sonde = sensorIds['sonde']!;
    const keys: SensorChannelKey[] = [
      { sensorId: sonde, channelKey: 'ammonia' },
      { sensorId: 'not-a-uuid', channelKey: 'ph' },
      { sensorId: sonde, channelKey: 'ph' },
      { sensorId: sonde, channelKey: 'salinity' },
      { sensorId: sensorIds['intruder']!, channelKey: 'ammonia' },
      { sensorId: sonde, channelKey: 'orp' },
      { sensorId: sonde, channelKey: 'ammonia' },
    ];
    const described = await service.describe(TENANT_A, keys);

    expect(described.map(({ sensorId, channelKey }) => ({ sensorId, channelKey }))).toEqual(keys);
    expect(described.map((d) => d.presence)).toEqual([
      'FOUND',
      'NO_SENSOR',
      'FOUND',
      'NO_CHANNEL',
      'NO_SENSOR',
      'FOUND',
      'FOUND',
    ]);
    expect(described[6]).toEqual(described[0]);
  });

  it('describes the channel, its sensor and its newest sample with the quality band', async () => {
    const [ammonia] = await service.describe(TENANT_A, [
      { sensorId: sensorIds['sonde']!, channelKey: 'ammonia' },
    ]);
    expect(ammonia).toMatchObject({
      sensorActive: true,
      siteId: SITE,
      systemId: SYSTEM,
      tankId: TANK,
      enabled: true,
      quantity: 'tan',
      quantityFamily: 'ammonia',
      unit: 'mg/L',
      configuredAt: null,
      latestValue: 0.44,
      latestQuality: 'BAD',
    });
    expect(new Date(ammonia!.latestAt!).getTime()).toBe(now - 5 * 60_000);
    expect(new Date(ammonia!.calibrationDueAt!).getTime()).toBe(now + 86_400_000);
  });

  it('never pairs a sample with a unit set after it', async () => {
    const [h2s] = await service.describe(TENANT_A, [
      { sensorId: sensorIds['sonde']!, channelKey: 'h2s' },
    ]);
    expect(h2s).toMatchObject({ unit: 'µg/L', latestValue: null, latestQuality: null });
    expect(new Date(h2s!.configuredAt!).getTime()).toBe(now - 10 * 60_000);
  });

  it('describes disabled channels, inactive sensors, missing units and refused declarations', async () => {
    const [orp, ph, temperature, salinity] = await service.describe(TENANT_A, [
      { sensorId: sensorIds['sonde']!, channelKey: 'orp' },
      { sensorId: sensorIds['sonde']!, channelKey: 'ph' },
      { sensorId: sensorIds['sonde']!, channelKey: 'temperature' },
      { sensorId: sensorIds['retired']!, channelKey: 'salinity' },
    ]);
    expect(orp).toMatchObject({ enabled: false, quantity: 'orp', latestValue: null });
    expect(ph).toMatchObject({ quantity: 'ph', unit: null });
    expect(temperature).toMatchObject({ quantity: null, unit: '°C' });
    expect(salinity).toMatchObject({
      presence: 'FOUND',
      sensorActive: false,
      quantity: 'salinity',
    });
  });
});
