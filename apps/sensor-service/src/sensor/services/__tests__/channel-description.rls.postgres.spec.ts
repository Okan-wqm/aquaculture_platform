import { BadRequestException } from '@nestjs/common';
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
 * channels described, not dropped; another tenant's sensor is no sensor.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SITE = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const SYSTEM = 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2';
const TANK = 'e3e3e3e3-e3e3-4e3e-8e3e-e3e3e3e3e3e3';
const ENTITIES = [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition];

jest.setTimeout(180_000);

describe('ChannelDescriptionService under FORCE RLS', () => {
  let stage: SensorRlsHarness | undefined;
  let service: ChannelDescriptionService;
  const sensorIds: Record<string, string> = {};
  const now = Date.now();

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'channel_description',
      tenants: [TENANT_A, TENANT_B],
      entities: ENTITIES,
      beforeRls: async ({ admin, tenantId, schema }) => {
        const [sensor] = await admin.query(
          `INSERT INTO "${schema}".sensors
               (tenant_id, name, serial_number, type, status, site_id, system_id, tank_id)
             VALUES ($1, 'Sonde', $2, 'multi_parameter', 'active', $3, $4, $5) RETURNING id`,
          [tenantId, `S-${schema}`, SITE, SYSTEM, TANK],
        );
        sensorIds[tenantId] = sensor.id;
        const channel = async (
          key: string,
          unit: string,
          enabled: boolean,
          declared: string | null,
          samples: Array<[number, number]>,
        ): Promise<void> => {
          const [row] = await admin.query(
            `INSERT INTO "${schema}".sensor_data_channels
                 (sensor_id, tenant_id, channel_key, display_label, data_type, unit, "dataPath",
                  is_enabled, display_order, declared_quantity, next_calibration_due)
               VALUES ($1, $2, $3, $3, 'number', $4, $3, $5, 0, $6, $7) RETURNING id`,
            [sensor.id, tenantId, key, unit, enabled, declared, new Date(now + 86_400_000)],
          );
          for (const [ageMinutes, value] of samples) {
            await admin.query(
              `INSERT INTO "${schema}".sensor_metrics
                   (time, sensor_id, channel_id, tenant_id, value, raw_value, quality_code, source_protocol)
                 VALUES ($1, $2, $3, $4, $5, $5, 192, 'mqtt')`,
              [new Date(now - ageMinutes * 60_000), sensor.id, row.id, tenantId, value],
            );
          }
        };
        await channel('ammonia', 'mg/L', true, 'tan', [
          [30, 0.41],
          [5, 0.44],
        ]);
        await channel('ph', 'pH', true, null, []);
        // Disabled after an incident; its last sample is older than the window.
        await channel('orp', 'mV', false, null, [[8 * 24 * 60, 210]]);
      },
    });
    service = new ChannelDescriptionService(stage.runtime);
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  it('describes each asked key in request order', async () => {
    const a = sensorIds[TENANT_A]!;
    const keys: SensorChannelKey[] = [
      { sensorId: a, channelKey: 'ammonia' },
      { sensorId: 'not-a-uuid', channelKey: 'ph' },
      { sensorId: a, channelKey: 'ph' },
      { sensorId: a, channelKey: 'salinity' },
      { sensorId: sensorIds[TENANT_B]!, channelKey: 'ammonia' },
      { sensorId: a, channelKey: 'orp' },
    ];
    const described = await service.describe(TENANT_A, keys);

    expect(described.map(({ sensorId, channelKey }) => ({ sensorId, channelKey }))).toEqual(keys);
    expect(described.map((d) => d.presence)).toEqual([
      'FOUND',
      'NO_SENSOR',
      'FOUND',
      'NO_CHANNEL',
      // Tenant B's sensor is invisible under tenant A's RLS boundary.
      'NO_SENSOR',
      'FOUND',
    ]);

    const [ammonia, , ph, salinity, , orp] = described;
    expect(ammonia).toMatchObject({
      sensorActive: true,
      siteId: SITE,
      systemId: SYSTEM,
      tankId: TANK,
      enabled: true,
      quantity: 'tan',
      quantityFamily: 'ammonia',
      unit: 'mg/L',
      latestValue: 0.44,
      latestQualityCode: 192,
    });
    expect(new Date(ammonia!.latestAt!).getTime()).toBe(now - 5 * 60_000);
    expect(new Date(ammonia!.calibrationDueAt!).getTime()).toBe(now + 86_400_000);
    expect(ph).toMatchObject({ quantity: 'ph', latestValue: null, latestAt: null });
    expect(salinity).toMatchObject({ siteId: SITE, channelId: null, quantity: null });
    // Disabled channels are described; a sample outside the window is no latest value.
    expect(orp).toMatchObject({ enabled: false, quantity: 'orp', latestValue: null });
  });

  it('refuses more keys than the contract allows', async () => {
    const keys = Array.from({ length: 101 }, () => ({
      sensorId: sensorIds[TENANT_A]!,
      channelKey: 'ph',
    }));
    await expect(service.describe(TENANT_A, keys)).rejects.toBeInstanceOf(BadRequestException);
  });
});
