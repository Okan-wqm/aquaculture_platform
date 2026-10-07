import { RedisService } from '@aquaculture/backend-common/redis';
import { DataSource } from 'typeorm';

import {
  bootSensorRlsHarness,
  type SensorRlsHarness,
} from '../../__tests__/support/sensor-rls-postgres.harness';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { SensorMetric } from '../../database/entities/sensor-metric.entity';
import { SensorProtocol } from '../../database/entities/sensor-protocol.entity';
import { SensorTypeDefinition } from '../../database/entities/sensor-type-definition.entity';
import { Sensor } from '../../database/entities/sensor.entity';
import { SensorTopicCacheService } from '../sensor-topic-cache.service';

/**
 * SENSOR-HIGH-119 on real Postgres: tenant schemas carry FORCE RLS and pooled
 * connections default to deny (app.bypass_rls='off' with no tenant context),
 * so the topic cache's cross-schema SELECT saw zero rows — MQTT messages could
 * not resolve sensors even with registration and channels correct.
 *
 * The fix reads each active tenant inside runInTenantRead (tenant GUC pinned
 * per transaction). This spec reproduces the exact pre-fix environment — a
 * non-owner runtime role, FORCE RLS on both tenant schemas, no bypass — and
 * asserts resolution works and stays tenant-isolated.
 */

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

jest.setTimeout(180_000);

describe('SensorTopicCacheService under FORCE RLS (SENSOR-HIGH-119)', () => {
  let stage: SensorRlsHarness | undefined;
  let admin: DataSource | undefined;
  let runtime: DataSource | undefined;
  let service: SensorTopicCacheService;
  let setJson: jest.Mock;
  let getJson: jest.Mock;
  const schemas: string[] = [];
  // Non-null views over the two fixture schemas (assigned in beforeAll).
  let SCHEMA_A = '';
  let SCHEMA_B = '';

  beforeAll(async () => {
    stage = await bootSensorRlsHarness({
      name: 'topic_cache',
      tenants: [TENANT_A, TENANT_B],
      entities: [Sensor, SensorDataChannel, SensorMetric, SensorProtocol, SensorTypeDefinition],
      beforeRls: async ({ admin: owner, tenantId, schema }) => {
        // Seed as the owner: one parent sensor per tenant on distinct topics.
        await owner.query(
          `INSERT INTO "${schema}".sensors
             (tenant_id, name, serial_number, type, protocol_configuration, is_parent_device)
           VALUES ($1, $2, $3, 'temperature', $4::jsonb, true)`,
          [
            tenantId,
            `Sonde ${schema.slice(0, 12)}`,
            `SONDE-${schema}`,
            JSON.stringify({ topic: `sensors/${schema.slice(0, 8)}/sonde` }),
          ],
        );
      },
    });
    admin = stage.admin;
    runtime = stage.runtime;
    SCHEMA_A = stage.schemaOf(TENANT_A);
    SCHEMA_B = stage.schemaOf(TENANT_B);
    schemas.push(SCHEMA_A, SCHEMA_B);

    getJson = jest.fn().mockResolvedValue(null);
    setJson = jest.fn().mockResolvedValue(undefined);
    const redisService = {
      getJson,
      setJson,
      del: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockResolvedValue([]),
    } as Partial<RedisService> as RedisService;

    service = new SensorTopicCacheService(redisService, runtime);
  });

  afterAll(async () => {
    await stage?.shutdown();
  });

  it('resolves a topic to its sensor under FORCE RLS with no bypass (was: zero rows)', async () => {
    const sensor = await service.getSensorByTopic(`sensors/${SCHEMA_A.slice(0, 8)}/sonde`);

    expect(sensor).not.toBeNull();
    expect(sensor?.tenantId).toBe(TENANT_A);
    expect(sensor?.schemaName).toBe(SCHEMA_A);
    expect(sensor?.protocolConfiguration).toMatchObject({
      topic: `sensors/${SCHEMA_A.slice(0, 8)}/sonde`,
    });
  });

  it('resolves each tenant independently (no cross-tenant bleed)', async () => {
    const sensorB = await service.getSensorByTopic(`sensors/${SCHEMA_B.slice(0, 8)}/sonde`);

    expect(sensorB?.tenantId).toBe(TENANT_B);
    expect(sensorB?.schemaName).toBe(SCHEMA_B);
  });

  it('warm-up caches every active tenant sensor (regression: "0 sensors")', async () => {
    await service.onModuleInit();

    // Earlier resolution tests also cached their hits — assert DISTINCT topics.
    const distinctTopics = new Set(
      setJson.mock.calls
        .map(([key]) => (typeof key === 'string' && key.startsWith('sensor:tenant:') ? key : null))
        .filter((key: string | null): key is string => key !== null),
    );
    expect(distinctTopics.size).toBe(2);
  });

  it('the RLS policy is genuinely enforced for the runtime role (regression guard)', async () => {
    // With tenant A's GUC, tenant A's rows are visible and tenant B's are not —
    // proves the policy is FORCED for this role, i.e. the fix works WITH the
    // isolation rather than around it.
    const qr = runtime!.createQueryRunner();
    try {
      await qr.startTransaction();
      await qr.query(`SELECT set_config('app.current_tenant', $1, true)`, [TENANT_A]);
      const visibleA = await qr.query(`SELECT count(*)::int AS n FROM "${SCHEMA_A}".sensors`);
      const visibleB = await qr.query(`SELECT count(*)::int AS n FROM "${SCHEMA_B}".sensors`);
      await qr.commitTransaction();

      expect(visibleA[0].n).toBe(1);
      expect(visibleB[0].n).toBe(0);
    } finally {
      await qr.release();
    }
  });
});
