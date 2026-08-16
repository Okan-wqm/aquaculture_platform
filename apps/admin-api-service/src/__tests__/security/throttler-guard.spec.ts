import {
  RateLimitAuthorityUnavailableError,
  RateLimitEnforcementService,
  type RateLimitRedisPort,
  RedisRateLimitStore,
} from '@aquaculture/backend-common/rate-limit';
import { ConfigService } from '@nestjs/config';

import { ADMIN_RATE_LIMIT_POLICIES } from '../../security/admin-rate-limit.policy';

describe('admin distributed rate-limit authority', () => {
  const services: RateLimitEnforcementService[] = [];

  afterEach(() => {
    services.splice(0).forEach((service) => service.onModuleDestroy());
  });

  function serviceWith(store?: RedisRateLimitStore): RateLimitEnforcementService {
    const service = new RateLimitEnforcementService(
      new ConfigService({ NODE_ENV: 'production' }),
      store,
    );
    services.push(service);
    return service;
  }

  it('shares one failed-auth budget across two application instances', async () => {
    const counts = new Map<string, number>();
    const evalMock = jest
      .fn()
      .mockImplementation((_script: string, _keyCount: number, key: string, windowMs: string) => {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return Promise.resolve([count, Number(windowMs)]);
      });
    const redisPort: RateLimitRedisPort = {
      getClient: () => ({ eval: evalMock }),
      deletePattern: jest.fn().mockResolvedValue(0),
    };
    const instanceA = serviceWith(new RedisRateLimitStore(redisPort, 'ratelimit:'));
    const instanceB = serviceWith(new RedisRateLimitStore(redisPort, 'ratelimit:'));

    for (let index = 0; index < ADMIN_RATE_LIMIT_POLICIES.failedAuth.limit; index += 1) {
      const instance = index % 2 === 0 ? instanceA : instanceB;
      await expect(
        instance.evaluate(ADMIN_RATE_LIMIT_POLICIES.failedAuth, { ip: '203.0.113.77' }),
      ).resolves.toMatchObject({ allowed: true });
    }

    await expect(
      instanceB.evaluate(ADMIN_RATE_LIMIT_POLICIES.failedAuth, { ip: '203.0.113.77' }),
    ).resolves.toMatchObject({ allowed: false, entry: { count: 21 } });
    expect(counts).toEqual(new Map([['ratelimit:admin-failed-auth:ip:203.0.113.77', 21]]));
  });

  it('fails closed when Redis rejects the atomic operation', async () => {
    const redisPort: RateLimitRedisPort = {
      getClient: () => ({ eval: jest.fn().mockRejectedValue(new Error('redis unavailable')) }),
      deletePattern: jest.fn().mockResolvedValue(0),
    };
    const service = serviceWith(new RedisRateLimitStore(redisPort));

    await expect(
      service.evaluate(ADMIN_RATE_LIMIT_POLICIES.sensitive, { userId: 'admin-1' }),
    ).rejects.toBeInstanceOf(RateLimitAuthorityUnavailableError);
  });

  it('has no production in-process fallback when the distributed store is absent', async () => {
    const service = serviceWith();

    await expect(
      service.evaluate(ADMIN_RATE_LIMIT_POLICIES.default, { userId: 'admin-1' }),
    ).rejects.toBeInstanceOf(RateLimitAuthorityUnavailableError);
  });
});
