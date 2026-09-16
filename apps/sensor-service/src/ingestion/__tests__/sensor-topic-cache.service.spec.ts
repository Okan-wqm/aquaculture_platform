/**
 * SensorTopicCacheService warm-up tests
 *
 * Regression cover for the warm-up row-mapping bug: the warm-up SQL used to
 * select `protocol_configuration` (pg returns it snake_case, unaliased) while
 * the mapping read `sensor.protocolConfiguration` — every topic read as
 * undefined and the service logged "Cache warmed up: 0 sensors" forever.
 *
 * The stub rows below mirror EXACTLY what the (fixed) aliased query returns
 * from pg — camelCase keys — so reverting the alias breaks these tests.
 */

import { DataSource } from 'typeorm';
import { RedisService } from '@aquaculture/backend-common/redis';

import { SensorTopicCacheService } from '../sensor-topic-cache.service';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface Row {
  id: string;
  name: string;
  type: string;
  tenantId: string;
  protocolConfiguration: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
}

function makeRow(id: string, tenantId: string, topic: string): Row {
  return {
    id,
    name: `Sensor ${id.slice(0, 8)}`,
    type: 'temperature',
    tenantId,
    protocolConfiguration: { topic },
    metadata: null,
  };
}

describe('SensorTopicCacheService warmUpCache', () => {
  let service: SensorTopicCacheService;
  let setJson: jest.Mock;
  let getJson: jest.Mock;
  let query: jest.Mock;
  let redisService: RedisService;
  let dataSource: DataSource;
  let rowsBySchema: Map<string, Row[]>;

  beforeEach(() => {
    rowsBySchema = new Map<string, Row[]>([
      [
        'tenant_aaaa000000000000',
        [makeRow('11111111-1111-4111-8111-111111111111', TENANT_A, 'sensors/site-a/water-temp')],
      ],
      [
        'tenant_bbbb000000000000',
        [
          makeRow('22222222-2222-4222-8222-222222222222', TENANT_B, 'sensors/site-b/water-temp'),
          makeRow('33333333-3333-4333-8333-333333333333', TENANT_B, 'sensors/site-b/ph'),
        ],
      ],
    ]);

    getJson = jest.fn().mockResolvedValue(null);
    setJson = jest.fn().mockResolvedValue(undefined);
    redisService = {
      getJson,
      setJson,
      del: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockResolvedValue([]),
    } as Partial<RedisService> as RedisService;

    query = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('information_schema.schemata')) {
        return [...rowsBySchema.keys()].map((schema_name) => ({ schema_name }));
      }
      if (sql.includes('information_schema.tables')) {
        const schema = String(params?.[0]);
        return rowsBySchema.has(schema) ? [{ '?column?': 1 }] : [];
      }
      if (sql.includes('protocol_configuration')) {
        const schemaMatch = sql.match(/FROM "(tenant_[a-f0-9]+)"/);
        const schema = schemaMatch?.[1] ?? '';
        return rowsBySchema.get(schema) ?? [];
      }
      return [];
    });
    dataSource = { query } as Partial<DataSource> as DataSource;

    service = new SensorTopicCacheService(redisService, dataSource);
  });

  it('warms the cache from every tenant schema (regression: was silently 0)', async () => {
    await service.onModuleInit();

    // 3 sensors across 2 schemas must produce 3 tenant-scoped cache writes
    const sensorEntryWrites = setJson.mock.calls.filter(
      ([key]) => typeof key === 'string' && key.startsWith('sensor:tenant:'),
    );
    expect(sensorEntryWrites).toHaveLength(3);

    const cachedTopics = sensorEntryWrites.map(([key]) =>
      key.replace(/^sensor:tenant:[^:]+:topic:/, ''),
    );
    expect(cachedTopics).toEqual(
      expect.arrayContaining([
        'sensors/site-a/water-temp',
        'sensors/site-b/water-temp',
        'sensors/site-b/ph',
      ]),
    );
  });

  it('resolves warmed topics without any further database query', async () => {
    await service.onModuleInit();

    const dbCallsBefore = query.mock.calls.length;
    const cached = await service.getSensorByTopic('sensors/site-b/ph');

    expect(cached).not.toBeNull();
    expect(cached?.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(cached?.schemaName).toBe('tenant_bbbb000000000000');
    expect(query.mock.calls.length).toBe(dbCallsBefore);
  });

  it('caches nothing when a schema has no sensors with topics', async () => {
    rowsBySchema.set('tenant_cccc000000000000', []);

    await service.onModuleInit();

    const keys = setJson.mock.calls.map(([key]) => key).filter((k) => typeof k === 'string');
    // 3 writes per sensor (tenant entry + topic index + reverse lookup) — none from the empty schema
    expect(keys).toHaveLength(9);
    expect(keys.every((k) => !k.includes('tenant_cccc'))).toBe(true);
  });

  it('sends the aliased protocolConfiguration column to the mapping (guards the SQL alias)', async () => {
    await service.onModuleInit();

    const warmUpSql = query.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('protocol_configuration'));
    expect(warmUpSql).toBeDefined();
    // The alias is the fix itself — pg must return camelCase for the row mapping.
    expect(warmUpSql).toContain('protocol_configuration AS "protocolConfiguration"');
  });

  it('does not blow up when a schema query fails (per-schema isolation)', async () => {
    const failingQuery = jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (
        sql.includes('information_schema.tables') &&
        String(params?.[0]) === 'tenant_bbbb000000000000'
      ) {
        throw new Error('relation does not exist');
      }
      if (sql.includes('information_schema.schemata')) {
        return [...rowsBySchema.keys()].map((schema_name) => ({ schema_name }));
      }
      if (sql.includes('information_schema.tables')) {
        return [{ '?column?': 1 }];
      }
      if (sql.includes('protocol_configuration')) {
        const schemaMatch = sql.match(/FROM "(tenant_[a-f0-9]+)"/);
        return rowsBySchema.get(schemaMatch?.[1] ?? '') ?? [];
      }
      return [];
    });
    query.mockImplementation(failingQuery);

    await expect(service.onModuleInit()).resolves.toBeUndefined();

    const sensorEntryWrites = setJson.mock.calls.filter(
      ([key]) => typeof key === 'string' && key.startsWith('sensor:tenant:'),
    );
    expect(sensorEntryWrites).toHaveLength(1); // tenant A survived, tenant B failed silently per-schema
  });
});
