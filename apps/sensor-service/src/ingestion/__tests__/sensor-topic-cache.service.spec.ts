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

  // A mapping outlives its tenant: one cached before db-migrate's delete job
  // dropped the schema keeps resolving for up to an hour, and every read
  // through it fails. The listener asks this question after such a read
  // failed, to tell "the tenant is gone" from "the read failed".
  describe('evictIfTenantInactive', () => {
    const B_KEYS = [
      `sensor:tenant:${TENANT_B}:topic:sensors/site-b/water-temp`,
      `sensor:tenant:${TENANT_B}:topic:sensors/site-b/ph`,
    ];

    /** db-migrate's delete job: B's schema dropped, its ledger row no longer active. */
    function deprovisionTenantB(): void {
      rowsByTenant.delete(TENANT_B);
      (listActiveTenantSchemaIdentities as jest.Mock).mockResolvedValue([
        { schemaName: 'tenant_aaaa000000000000', tenantId: TENANT_A },
      ]);
    }

    it('evicts every mapping of a tenant the platform no longer lists as active, and says so', async () => {
      await service.onModuleInit();
      deprovisionTenantB();
      (redisService.keys as jest.Mock).mockResolvedValueOnce(B_KEYS);

      await expect(service.evictIfTenantInactive(TENANT_B)).resolves.toBe(true);

      expect(redisService.keys).toHaveBeenCalledWith(`sensor:tenant:${TENANT_B}:topic:*`);
      for (const key of B_KEYS) expect(redisService.del).toHaveBeenCalledWith(key);
      // The local entry went with it: the topic re-resolves, and the resolver
      // maps topics of active tenants only.
      await expect(service.getSensorByTopic('sensors/site-b/ph')).resolves.toBeNull();
      // The active tenant's mapping is untouched and still served from cache.
      const readsBefore = (runInTenantRead as jest.Mock).mock.calls.length;
      const stillMapped = await service.getSensorByTopic('sensors/site-a/water-temp');
      expect(stillMapped?.tenantId).toBe(TENANT_A);
      expect((runInTenantRead as jest.Mock).mock.calls.length).toBe(readsBefore);
    });

    it('keeps the mappings of a tenant that is still active, and says so', async () => {
      await service.onModuleInit();

      // The ledger normalizes tenant ids to lower case; the answer must not
      // depend on how the caller spelled the id.
      await expect(service.evictIfTenantInactive(TENANT_B.toUpperCase())).resolves.toBe(false);

      expect(redisService.keys).not.toHaveBeenCalled();
      expect(redisService.del).not.toHaveBeenCalled();
      const readsBefore = (runInTenantRead as jest.Mock).mock.calls.length;
      expect((await service.getSensorByTopic('sensors/site-b/ph'))?.tenantId).toBe(TENANT_B);
      expect((runInTenantRead as jest.Mock).mock.calls.length).toBe(readsBefore);
    });

    it('rejects without evicting when the platform mapping cannot be read', async () => {
      await service.onModuleInit();
      (listActiveTenantSchemaIdentities as jest.Mock).mockRejectedValueOnce(
        new Error('connection terminated unexpectedly'),
      );

      await expect(service.evictIfTenantInactive(TENANT_B)).rejects.toThrow(
        'connection terminated unexpectedly',
      );

      expect(redisService.del).not.toHaveBeenCalled();
      expect((await service.getSensorByTopic('sensors/site-b/ph'))?.tenantId).toBe(TENANT_B);
    });

    it('evicts the local mapping even when Redis refuses the key scan', async () => {
      await service.onModuleInit();
      deprovisionTenantB();
      (redisService.keys as jest.Mock).mockRejectedValueOnce(new Error('redis: connection lost'));

      await expect(service.evictIfTenantInactive(TENANT_B)).resolves.toBe(true);

      await expect(service.getSensorByTopic('sensors/site-b/ph')).resolves.toBeNull();
    });
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

// Moved from the MqttListenerService spec: the listener's own copy of the
// matcher went with its RLS-blind legacy resolver (SENSOR-HIGH-137); the topic
// cache is now the only topic→sensor resolver.
describe('SensorTopicCacheService topic wildcard matching', () => {
  const service = new SensorTopicCacheService(
    {} as Partial<RedisService> as RedisService,
    {} as Partial<DataSource> as DataSource,
  );
  const topicMatches = (pattern: string, topic: string): boolean =>
    service['topicMatches'](pattern, topic);

  it('matches a single-level wildcard (+)', () => {
    expect(topicMatches('sensors/+/data', 'sensors/abc/data')).toBe(true);
    expect(topicMatches('sensors/+/data', 'sensors/abc/other')).toBe(false);
  });

  it('matches a multi-level wildcard (#)', () => {
    expect(topicMatches('sensors/#', 'sensors/a/b/c')).toBe(true);
    expect(topicMatches('sensors/#', 'sensors')).toBe(true);
  });

  it('does not match when the pattern has more levels than the topic', () => {
    expect(topicMatches('sensors/a/b/c', 'sensors/a')).toBe(false);
  });

  it('matches an exact topic without wildcards', () => {
    expect(topicMatches('sensors/abc/data', 'sensors/abc/data')).toBe(true);
    expect(topicMatches('sensors/abc/data', 'sensors/xyz/data')).toBe(false);
  });
});
