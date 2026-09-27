/**
 * SensorTopicCacheService warm-up + lookup tests
 *
 * Covers two regressions in one place:
 * - F5/SENSOR-MEDIUM-120: the warm-up SQL used to select `protocol_configuration`
 *   (pg returns it snake_case, unaliased) while the mapping read
 *   `sensor.protocolConfiguration` — warm-up silently cached 0 sensors.
 * - F4/SENSOR-HIGH-119: warm-up and topic lookup now iterate ACTIVE TENANT
 *   IDENTITIES and read each schema through runInTenantRead (tenant GUC pinned
 *   per transaction) instead of a bare cross-schema SELECT that FORCE RLS
 *   denies on the deny-by-default pool.
 *
 * platform helpers are partial-mocked: runInTenantRead hands the callback a
 * fake query runner, so the specs assert the SQL/rows contract without PG.
 */

import { DataSource } from 'typeorm';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  listActiveTenantSchemaIdentities,
  runInTenantRead,
} from '@aquaculture/backend-common/database';

import { SensorTopicCacheService } from '../sensor-topic-cache.service';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    listActiveTenantSchemaIdentities: jest.fn(),
    runInTenantRead: jest.fn(),
  };
});

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

describe('SensorTopicCacheService tenant-scoped reads', () => {
  let service: SensorTopicCacheService;
  let setJson: jest.Mock;
  let getJson: jest.Mock;
  let redisService: RedisService;
  let dataSource: DataSource;
  let rowsByTenant: Map<string, Row[]>;
  let queryLog: string[];
  let currentWarmRows: Row[];

  beforeEach(() => {
    jest.clearAllMocks();

    rowsByTenant = new Map<string, Row[]>([
      [
        TENANT_A,
        [makeRow('11111111-1111-4111-8111-111111111111', TENANT_A, 'sensors/site-a/water-temp')],
      ],
      [
        TENANT_B,
        [
          makeRow('22222222-2222-4222-8222-222222222222', TENANT_B, 'sensors/site-b/water-temp'),
          makeRow('33333333-3333-4333-8333-333333333333', TENANT_B, 'sensors/site-b/ph'),
        ],
      ],
    ]);
    queryLog = [];
    currentWarmRows = [];

    getJson = jest.fn().mockResolvedValue(null);
    setJson = jest.fn().mockResolvedValue(undefined);
    redisService = {
      getJson,
      setJson,
      del: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockResolvedValue([]),
    } as Partial<RedisService> as RedisService;

    const qr = {
      query: jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        queryLog.push(sql);
        if (sql.includes("->>'topic' = $1")) {
          const topic = String(params?.[0]);
          for (const rows of rowsByTenant.values()) {
            const hit = rows.find((r) => r.protocolConfiguration.topic === topic);
            if (hit) return [hit];
          }
          return [];
        }
        if (sql.includes("LIKE '%#%'")) {
          return [...(rowsByTenant.get(TENANT_B) ?? [])];
        }
        if (sql.includes('IS NOT NULL')) {
          return currentWarmRows;
        }
        return [];
      }),
    };

    (listActiveTenantSchemaIdentities as jest.Mock).mockResolvedValue([
      { schemaName: 'tenant_aaaa000000000000', tenantId: TENANT_A },
      { schemaName: 'tenant_bbbb000000000000', tenantId: TENANT_B },
    ]);
    (runInTenantRead as jest.Mock).mockImplementation(
      async (
        _ds: unknown,
        _schema: string,
        tenantId: string,
        fn: (runner: unknown) => Promise<unknown>,
      ) => {
        currentWarmRows = rowsByTenant.get(tenantId) ?? [];
        return fn(qr);
      },
    );

    dataSource = { query: jest.fn() } as Partial<DataSource> as DataSource;
    service = new SensorTopicCacheService(redisService, dataSource);
  });

  it('warms the cache from every active tenant (regression: was silently 0)', async () => {
    await service.onModuleInit();

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

  it('reads each tenant through runInTenantRead (no bare cross-schema SELECT)', async () => {
    await service.onModuleInit();

    expect(listActiveTenantSchemaIdentities).toHaveBeenCalledWith(dataSource);
    const tenantsRead = (runInTenantRead as jest.Mock).mock.calls.map((call) => call[2]);
    expect(tenantsRead).toEqual(expect.arrayContaining([TENANT_A, TENANT_B]));
    // The bare dataSource.query (the RLS-blind path) is never used for sensors
    expect((dataSource.query as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('resolves warmed topics without any further tenant read', async () => {
    await service.onModuleInit();

    const readsBefore = (runInTenantRead as jest.Mock).mock.calls.length;
    const cached = await service.getSensorByTopic('sensors/site-b/ph');

    expect(cached).not.toBeNull();
    expect(cached?.id).toBe('33333333-3333-4333-8333-333333333333');
    expect(cached?.schemaName).toBe('tenant_bbbb000000000000');
    expect((runInTenantRead as jest.Mock).mock.calls.length).toBe(readsBefore);
  });

  it('falls back to the database through runInTenantRead on cache miss and caches the hit', async () => {
    const sensor = await service.getSensorByTopic('sensors/site-a/water-temp');

    expect(sensor).not.toBeNull();
    expect(sensor?.id).toBe('11111111-1111-4111-8111-111111111111');
    expect(
      setJson.mock.calls.some(
        ([key]) => typeof key === 'string' && key.includes(TENANT_A) && key.includes('site-a'),
      ),
    ).toBe(true);
  });

  it('guards the camelCase alias in every sensors query (F5 regression pin)', async () => {
    await service.onModuleInit();
    await service.getSensorByTopic('sensors/site-a/water-temp');

    for (const sql of queryLog.filter((s) => s.includes('protocol_configuration'))) {
      expect(sql).toContain('protocol_configuration AS "protocolConfiguration"');
    }
  });

  it('does not blow up when one tenant read fails (per-tenant isolation)', async () => {
    (runInTenantRead as jest.Mock).mockImplementation(
      async (
        _ds: unknown,
        _schema: string,
        tenantId: string,
        fn: (runner: unknown) => Promise<unknown>,
      ) => {
        if (tenantId === TENANT_B) throw new Error('relation does not exist');
        currentWarmRows = rowsByTenant.get(tenantId) ?? [];
        return fn(qrFactory());
      },
    );

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    const sensorEntryWrites = setJson.mock.calls.filter(
      ([key]) => typeof key === 'string' && key.startsWith('sensor:tenant:'),
    );
    expect(sensorEntryWrites).toHaveLength(1); // tenant A survived
  });

  function qrFactory() {
    return {
      query: jest.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
        queryLog.push(sql);
        if (sql.includes("->>'topic' = $1")) {
          const topic = String(params?.[0]);
          for (const rows of rowsByTenant.values()) {
            const hit = rows.find((r) => r.protocolConfiguration.topic === topic);
            if (hit) return [hit];
          }
          return [];
        }
        if (sql.includes('IS NOT NULL')) {
          return currentWarmRows;
        }
        return [];
      }),
    };
  }
});
