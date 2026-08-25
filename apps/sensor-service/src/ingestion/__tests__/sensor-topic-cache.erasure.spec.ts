import { SensorTopicCacheService } from '../sensor-topic-cache.service';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('SensorTopicCacheService erasure boundary', () => {
  it('deletes every tenant-scoped Redis key', async () => {
    const redis = {
      keys: jest.fn().mockResolvedValue(['sensor:tenant:a:topic:one', 'sensor:tenant:a:topic:two']),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const service = new SensorTopicCacheService(redis as never, {} as never);

    await service.eraseTenantCache(TENANT_ID);

    expect(redis.keys).toHaveBeenCalledWith(`sensor:tenant:${TENANT_ID}:topic:*`);
    expect(redis.del).toHaveBeenCalledTimes(2);
  });

  it('fails closed when Redis cannot prove tenant cache deletion', async () => {
    const redis = {
      keys: jest.fn().mockResolvedValue(['sensor:tenant:a:topic:one']),
      del: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
    };
    const service = new SensorTopicCacheService(redis as never, {} as never);

    await expect(service.eraseTenantCache(TENANT_ID)).rejects.toThrow('Redis unavailable');
  });
});
