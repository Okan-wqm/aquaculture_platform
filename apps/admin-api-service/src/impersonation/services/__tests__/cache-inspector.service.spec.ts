/**
 * The cache inspector talks to Redis, and says so when it cannot.
 *
 * Every assertion here targets a specific behaviour of the version this
 * replaced, which inspected a table nothing wrote and whose three invalidation
 * methods logged `[Cache] Invalidated key: …` and returned. The controller spec
 * could not catch it: it mocked `invalidateCachePattern` to resolve 5, so the
 * stub and a working implementation were indistinguishable from above.
 */
import { RedisService } from '@aquaculture/backend-common/redis';
import { ServiceUnavailableException } from '@nestjs/common';

import { CacheInspectorService } from '../cache-inspector.service';

interface FakeClient {
  info: jest.Mock;
  dbsize: jest.Mock;
  type: jest.Mock;
  memory: jest.Mock;
  object: jest.Mock;
}

/** The RedisService members the inspector actually calls. */
type RedisDouble = Pick<
  RedisService,
  'isConnected' | 'getKeyPrefix' | 'getClient' | 'keys' | 'ttl' | 'del' | 'deletePattern' | 'get'
>;

interface Harness {
  service: CacheInspectorService;
  redis: {
    keys: jest.Mock;
    ttl: jest.Mock;
    del: jest.Mock;
    deletePattern: jest.Mock;
  };
  client: FakeClient;
}

function makeHarness(connected = true): Harness {
  const client: FakeClient = {
    info: jest.fn(),
    dbsize: jest.fn().mockResolvedValue(250),
    type: jest.fn().mockResolvedValue('string'),
    memory: jest.fn().mockResolvedValue(128),
    object: jest.fn().mockResolvedValue(42),
  };

  const keys = jest.fn().mockResolvedValue([]);
  const ttl = jest.fn().mockResolvedValue(3600);
  const del = jest.fn().mockResolvedValue(1);
  const deletePattern = jest.fn().mockResolvedValue(7);

  // Typed as the exact slice the service uses, so adding a dependency to the
  // service breaks this spec instead of passing silently.
  const redisDouble: RedisDouble = {
    isConnected: jest.fn().mockReturnValue(connected),
    getKeyPrefix: jest.fn().mockReturnValue('admin:'),
    getClient: jest.fn().mockReturnValue(client),
    keys,
    ttl,
    del,
    deletePattern,
    get: jest.fn().mockResolvedValue('cached'),
  };

  const service = new CacheInspectorService(redisDouble as RedisService);
  return { service, redis: { keys, ttl, del, deletePattern }, client };
}

describe('CacheInspectorService — invalidation is real', () => {
  it('deletes the key through Redis and reports what Redis removed', async () => {
    const { service, redis } = makeHarness();
    redis.del.mockResolvedValueOnce(1);

    await expect(service.invalidateKey('report:abc')).resolves.toBe(1);
    expect(redis.del).toHaveBeenCalledWith('report:abc');
  });

  it('reports 0 when the key was not there, rather than claiming a delete', async () => {
    const { service, redis } = makeHarness();
    redis.del.mockResolvedValueOnce(0);

    await expect(service.invalidateKey('missing')).resolves.toBe(0);
  });

  it('deletes a pattern through Redis and returns the REAL count', async () => {
    // The method this replaced ended with `return 0;` under a comment reading
    // "In production, this would use SCAN and DEL on Redis".
    const { service, redis } = makeHarness();

    await expect(service.invalidatePattern('report:*')).resolves.toBe(7);
    expect(redis.deletePattern).toHaveBeenCalledWith('report:*');
  });
});

describe('CacheInspectorService — fail closed', () => {
  it.each([
    ['listEntries', (s: CacheInspectorService) => s.listEntries('*', 10)],
    ['getEntry', (s: CacheInspectorService) => s.getEntry('k')],
    ['invalidateKey', (s: CacheInspectorService) => s.invalidateKey('k')],
    ['invalidatePattern', (s: CacheInspectorService) => s.invalidatePattern('*')],
    ['getStats', (s: CacheInspectorService) => s.getStats()],
  ])('%s refuses when Redis is not connected', async (_name, call) => {
    // Redis is registered in `optional` mode, so an unreachable instance is a
    // real runtime state. Returning zeros there is how "0 keys cleared" came to
    // mean both "nothing matched" and "nothing happened".
    const { service, redis } = makeHarness(false);

    await expect(call(service)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.deletePattern).not.toHaveBeenCalled();
  });
});

describe('CacheInspectorService — statistics describe what was measured', () => {
  it('computes the hit rate from keyspace hits and misses', async () => {
    const { service, redis, client } = makeHarness();
    client.info.mockImplementation(async (section: string) =>
      section === 'stats'
        ? 'keyspace_hits:800\nkeyspace_misses:200\n'
        : 'used_memory:2048\n',
    );
    redis.keys.mockResolvedValueOnce(['a', 'b', 'c']);

    const stats = await service.getStats();

    // 800 / (800 + 200). The formula this replaced was
    // hits / (hits + ROW COUNT of a snapshot table).
    expect(stats.instance.hitRatePercent).toBe(80);
    expect(stats.instance.keyspaceHits).toBe(800);
    expect(stats.instance.usedMemoryBytes).toBe(2048);
    // Namespace and instance stay apart: 3 keys here, 250 in the instance.
    expect(stats.keysInNamespace).toBe(3);
    expect(stats.instance.totalKeys).toBe(250);
    expect(stats.namespace).toBe('admin:');
  });

  it('reports an unmeasured hit rate as null, not as zero', async () => {
    // A fresh instance has served no lookup. 0% would say the cache misses
    // everything, which is a claim about a cache nobody has used yet.
    const { service, client } = makeHarness();
    client.info.mockImplementation(async (section: string) =>
      section === 'stats' ? 'keyspace_hits:0\nkeyspace_misses:0\n' : 'used_memory:512\n',
    );

    const stats = await service.getStats();

    expect(stats.instance.hitRatePercent).toBeNull();
  });
});

describe('CacheInspectorService — listing', () => {
  it('scans the namespace and reports each key as Redis describes it', async () => {
    const { service, redis, client } = makeHarness();
    redis.keys.mockResolvedValueOnce(['report:a', 'report:b']);
    redis.ttl.mockResolvedValue(120);

    const listing = await service.listEntries('report:*', 10);

    expect(redis.keys).toHaveBeenCalledWith('report:*');
    expect(listing.entries).toEqual([
      { key: 'report:a', type: 'string', ttlSeconds: 120, sizeBytes: 128, idleSeconds: 42 },
      { key: 'report:b', type: 'string', ttlSeconds: 120, sizeBytes: 128, idleSeconds: 42 },
    ]);
    // Raw-client commands address the PREFIXED key: `getClient()` bypasses the
    // namespace that `keys`/`ttl`/`del` apply for us.
    expect(client.memory).toHaveBeenCalledWith('USAGE', 'admin:report:a');
    expect(client.object).toHaveBeenCalledWith('IDLETIME', 'admin:report:a');
  });

  it('says when the listing was cut short instead of implying it is complete', async () => {
    const { service, redis } = makeHarness();
    redis.keys.mockResolvedValueOnce(['a', 'b', 'c', 'd']);

    const listing = await service.listEntries('*', 2);

    expect(listing.entries).toHaveLength(2);
    expect(listing.matchedCount).toBe(4);
    expect(listing.truncated).toBe(true);
  });

  it('returns null for a key that does not exist', async () => {
    const { service, client } = makeHarness();
    client.type.mockResolvedValueOnce('none');

    await expect(service.getEntry('gone')).resolves.toBeNull();
  });

  it('returns the value only for a string key', async () => {
    // A hash rendered through a string read would be a partial view presented
    // as the whole value.
    const { service, client } = makeHarness();
    client.type.mockResolvedValueOnce('hash');

    const entry = await service.getEntry('some:hash');

    expect(entry?.type).toBe('hash');
    expect(entry?.value).toBeNull();
  });
});
