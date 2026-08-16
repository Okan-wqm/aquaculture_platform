import { RedisService } from '@aquaculture/backend-common/redis';
import {
  adminCacheInvalidationReceiptSha256V1,
  adminCacheKeySetSha256V1,
} from '@aquaculture/shared-contracts';
import { ServiceUnavailableException } from '@nestjs/common';

import { CacheInspectorService } from '../cache-inspector.service';

type RedisDouble = Pick<
  RedisService,
  | 'isConnected'
  | 'getKeyPrefix'
  | 'keys'
  | 'ttl'
  | 'del'
  | 'exists'
  | 'get'
  | 'type'
  | 'memoryUsage'
  | 'objectIdleTime'
  | 'deletePatternWithEvidence'
  | 'info'
  | 'dbsize'
>;

interface Harness {
  readonly service: CacheInspectorService;
  readonly redis: { readonly [K in keyof RedisDouble]: jest.Mock };
}

function makeHarness(connected = true): Harness {
  const redis: Harness['redis'] = {
    isConnected: jest.fn().mockReturnValue(connected),
    getKeyPrefix: jest.fn().mockReturnValue('admin:'),
    keys: jest.fn().mockResolvedValue([]),
    ttl: jest.fn().mockResolvedValue(3600),
    del: jest.fn().mockResolvedValue(0),
    exists: jest.fn().mockResolvedValue(false),
    get: jest.fn().mockResolvedValue('cached'),
    type: jest.fn().mockResolvedValue('string'),
    memoryUsage: jest.fn().mockResolvedValue(128),
    objectIdleTime: jest.fn().mockResolvedValue(42),
    deletePatternWithEvidence: jest.fn().mockResolvedValue({
      schemaVersion: 'redis-pattern-deletion-evidence.v1',
      matchedKeys: [],
      deletedCount: 0,
    }),
    info: jest.fn().mockResolvedValue(''),
    dbsize: jest.fn().mockResolvedValue(250),
  };

  return {
    service: new CacheInspectorService(redis as unknown as RedisService),
    redis,
  };
}

describe('CacheInspectorService invalidation evidence', () => {
  it('returns a deterministic content-addressed receipt for an exact key deletion', async () => {
    const { service, redis } = makeHarness();
    redis.exists
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    redis.del.mockResolvedValue(1);

    const first = await service.invalidateKey('report:abc');
    const second = await service.invalidateKey('report:abc');

    expect(redis.del).toHaveBeenCalledWith('report:abc');
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 'admin-cache-invalidation-receipt.v1',
      namespace: 'admin:',
      selector: { kind: 'KEY', value: 'report:abc' },
      discoveredCount: 1,
      deletedCount: 1,
      residualCount: 0,
      outcome: 'FULLY_INVALIDATED',
    });
    expect(first.discoveredKeysDigest).toBe(
      adminCacheKeySetSha256V1({
        namespace: 'admin:',
        selector: { kind: 'KEY', value: 'report:abc' },
        phase: 'DISCOVERED',
        keys: ['report:abc'],
      }),
    );
    const { receiptId: _receiptId, ...evidence } = first;
    expect(first.receiptId).toBe(adminCacheInvalidationReceiptSha256V1(evidence));
  });

  it('records the discovered mutation set and residual keys for a pattern', async () => {
    const { service, redis } = makeHarness();
    redis.deletePatternWithEvidence.mockResolvedValueOnce({
      schemaVersion: 'redis-pattern-deletion-evidence.v1',
      matchedKeys: ['report:b', 'report:a'],
      deletedCount: 1,
    });
    redis.keys.mockResolvedValueOnce(['report:b']);

    const receipt = await service.invalidatePattern('report:*');

    expect(redis.deletePatternWithEvidence).toHaveBeenCalledWith('report:*');
    expect(receipt).toMatchObject({
      selector: { kind: 'PATTERN', value: 'report:*' },
      discoveredCount: 2,
      deletedCount: 1,
      residualCount: 1,
      outcome: 'RESIDUAL_KEYS_PRESENT',
    });
    expect(receipt.discoveredKeysDigest).toBe(
      adminCacheKeySetSha256V1({
        namespace: 'admin:',
        selector: { kind: 'PATTERN', value: 'report:*' },
        phase: 'DISCOVERED',
        keys: ['report:a', 'report:b'],
      }),
    );
    expect(receipt.residualKeysDigest).toBe(
      adminCacheKeySetSha256V1({
        namespace: 'admin:',
        selector: { kind: 'PATTERN', value: 'report:*' },
        phase: 'RESIDUAL',
        keys: ['report:b'],
      }),
    );
  });
});

describe('CacheInspectorService availability boundary', () => {
  it.each([
    ['listEntries', (service: CacheInspectorService) => service.listEntries('*', 10)],
    ['getEntry', (service: CacheInspectorService) => service.getEntry('key')],
    ['invalidateKey', (service: CacheInspectorService) => service.invalidateKey('key')],
    ['invalidatePattern', (service: CacheInspectorService) => service.invalidatePattern('*')],
    ['getStats', (service: CacheInspectorService) => service.getStats()],
  ])('%s fails closed while Redis is disconnected', async (_name, call) => {
    const { service, redis } = makeHarness(false);

    await expect(call(service)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(redis.del).not.toHaveBeenCalled();
    expect(redis.deletePatternWithEvidence).not.toHaveBeenCalled();
  });
});

describe('CacheInspectorService live projection', () => {
  it('lists bounded, namespace-relative Redis metadata and exposes truncation', async () => {
    const { service, redis } = makeHarness();
    redis.keys.mockResolvedValueOnce(['report:a', 'report:b', 'report:c']);
    redis.ttl.mockResolvedValue(120);

    const listing = await service.listEntries('report:*', 2);

    expect(redis.keys).toHaveBeenCalledWith('report:*');
    expect(listing).toEqual({
      namespace: 'admin:',
      entries: [
        {
          key: 'report:a',
          type: 'string',
          ttlSeconds: 120,
          sizeBytes: 128,
          idleSeconds: 42,
        },
        {
          key: 'report:b',
          type: 'string',
          ttlSeconds: 120,
          sizeBytes: 128,
          idleSeconds: 42,
        },
      ],
      matchedCount: 3,
      truncated: true,
    });
  });

  it('does not present a partial string view for non-string values', async () => {
    const { service, redis } = makeHarness();
    redis.type.mockResolvedValueOnce('hash');

    await expect(service.getEntry('some:hash')).resolves.toMatchObject({
      key: 'some:hash',
      type: 'hash',
      value: null,
    });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('reports absent keys as absent', async () => {
    const { service, redis } = makeHarness();
    redis.type.mockResolvedValueOnce('none');

    await expect(service.getEntry('gone')).resolves.toBeNull();
  });

  it('keeps namespace and whole-instance statistics distinct', async () => {
    const { service, redis } = makeHarness();
    redis.info.mockImplementation(async (section: 'memory' | 'stats') =>
      section === 'stats' ? 'keyspace_hits:800\nkeyspace_misses:200\n' : 'used_memory:2048\n',
    );
    redis.keys.mockResolvedValueOnce(['a', 'b', 'c']);

    await expect(service.getStats()).resolves.toEqual({
      namespace: 'admin:',
      keysInNamespace: 3,
      instance: {
        keyspaceHits: 800,
        keyspaceMisses: 200,
        hitRatePercent: 80,
        usedMemoryBytes: 2048,
        totalKeys: 250,
      },
    });
  });

  it('uses null, not a fabricated percentage, before any lookup is measured', async () => {
    const { service, redis } = makeHarness();
    redis.info.mockImplementation(async (section: 'memory' | 'stats') =>
      section === 'stats' ? 'keyspace_hits:0\nkeyspace_misses:0\n' : 'used_memory:512\n',
    );

    const stats = await service.getStats();

    expect(stats.instance.hitRatePercent).toBeNull();
  });

  it('rejects missing Redis counters instead of fabricating zero-valued statistics', async () => {
    const { service, redis } = makeHarness();
    redis.info.mockImplementation(async (section: 'memory' | 'stats') =>
      section === 'stats' ? 'keyspace_hits:8\n' : 'used_memory:512\n',
    );

    await expect(service.getStats()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
