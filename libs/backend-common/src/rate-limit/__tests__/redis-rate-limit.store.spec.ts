import { RateLimitRedisPort, RedisRateLimitStore } from '../redis-rate-limit.store';

describe('RedisRateLimitStore', () => {
  // Two-method double against the segregated port — no cast: a `jest.Mock`
  // is assignable to ioredis' overloaded `eval`, and the literal satisfies
  // RateLimitRedisPort structurally (the same surface RedisService exposes).
  const buildRedisService = (evalImpl: jest.Mock): RateLimitRedisPort => ({
    getClient: () => ({ eval: evalImpl }),
    deletePattern: jest.fn().mockResolvedValue(0),
  });

  it('runs the atomic Lua increment and maps [count, pttl] to an entry', async () => {
    const evalMock = jest.fn().mockResolvedValue([3, 45_000]);
    const store = new RedisRateLimitStore(buildRedisService(evalMock), 'ratelimit:');

    const before = Date.now();
    const result = await store.incrementOrCreate('login:ip:1.2.3.4', 60_000);

    // WHAT the script contract is: one key, the window in ms as ARGV[1] —
    // INCR + first-hit PEXPIRE + PTTL in a single server-side atomic step.
    expect(evalMock).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      1,
      'ratelimit:login:ip:1.2.3.4',
      '60000',
    );
    expect(result.entry.count).toBe(3);
    expect(result.isNew).toBe(false);
    expect(result.entry.resetTime).toBeGreaterThanOrEqual(before + 45_000);
    expect(store.isHealthy()).toBe(true);
  });

  it('flags isNew on the first hit of a window', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 60_000]);
    const store = new RedisRateLimitStore(buildRedisService(evalMock));

    const result = await store.incrementOrCreate('k', 60_000);
    expect(result.isNew).toBe(true);
  });

  it('marks itself unhealthy and RETHROWS on Redis failure (guard owns the policy)', async () => {
    const evalMock = jest.fn().mockRejectedValue(new Error('connection refused'));
    const store = new RedisRateLimitStore(buildRedisService(evalMock));

    await expect(store.incrementOrCreate('k', 60_000)).rejects.toThrow('connection refused');
    expect(store.isHealthy()).toBe(false);
  });
});
