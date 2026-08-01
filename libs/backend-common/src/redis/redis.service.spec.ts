const mockRedisOn = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisSetex = jest.fn();
const mockRedisEval = jest.fn<
  Promise<unknown>,
  [script: string, numberOfKeys: number, ...arguments_: string[]]
>();
const mockRedisGet = jest.fn();
const mockRedisMget = jest.fn();
const mockRedisQuit = jest.fn();

jest.mock('ioredis', () =>
  jest.fn().mockImplementation(() => ({
    on: mockRedisOn,
    quit: mockRedisQuit,
    set: mockRedisSet,
    setex: mockRedisSetex,
    eval: mockRedisEval,
    get: mockRedisGet,
    mget: mockRedisMget,
  })),
);

import { RedisService } from './redis.service';

describe('RedisService key prefixing', () => {
  beforeEach(() => {
    mockRedisOn.mockReset();
    mockRedisSet.mockReset();
    mockRedisSetex.mockReset();
    mockRedisEval.mockReset();
    mockRedisGet.mockReset();
    mockRedisMget.mockReset();
    mockRedisQuit.mockReset();
    mockRedisSet.mockResolvedValue('OK');
    mockRedisSetex.mockResolvedValue('OK');
    mockRedisEval.mockResolvedValue(1_000_000);
    mockRedisGet.mockResolvedValue(null);
    mockRedisMget.mockResolvedValue([null, null]);
  });

  it('preserves an explicit empty keyPrefix', async () => {
    const service = new RedisService({
      url: 'redis://redis:6379',
      keyPrefix: '',
    });

    await service.set('ai:tokens:tenant-1:2026-06', '42');
    await service.onModuleDestroy();

    expect(mockRedisSet).toHaveBeenCalledWith('ai:tokens:tenant-1:2026-06', '42');
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
  });

  it('uses the platform default prefix when keyPrefix is undefined', async () => {
    const service = new RedisService({
      url: 'redis://redis:6379',
    });

    await service.set('healthcheck', 'ok');
    await service.onModuleDestroy();

    expect(mockRedisSet).toHaveBeenCalledWith('aqua:healthcheck', 'ok');
    expect(mockRedisQuit).toHaveBeenCalledTimes(1);
  });

  it('atomically retains a max epoch at the prefixed key with a TTL', async () => {
    const service = new RedisService({ url: 'redis://redis:6379' });

    await expect(
      service.setMaxSafeInteger('user_blacklist:user-1', 1_000_000, 86_400),
    ).resolves.toBe(1_000_000);

    expect(mockRedisEval).toHaveBeenCalledTimes(1);
    const [script, keyCount, key, epoch, ttl] = mockRedisEval.mock.calls[0] ?? [];
    expect(keyCount).toBe(1);
    expect(key).toBe('aqua:user_blacklist:user-1');
    expect(epoch).toBe('1000000');
    expect(ttl).toBe('86400');
    expect(script).toContain("redis.error_reply('EXISTING_VALUE_NOT_POSITIVE_INTEGER')");
    expect(script).toContain('current_number >= tonumber(ARGV[1])');
  });

  it('keeps auth-owned JTI and user markers identical for gateway reads', async () => {
    const authRedis = new RedisService({
      url: 'redis://redis:6379',
      keyPrefix: 'auth:',
    });
    const gatewayRedis = new RedisService({
      url: 'redis://redis:6379',
      keyPrefix: 'gateway:',
    });

    await authRedis.setAuthorizationMaxSafeInteger('user_blacklist:user-1', 1_000_000, 86_400);
    await authRedis.setAuthorization('token:blacklist:jti-1', '1', 60);
    await gatewayRedis.mgetScoped(
      { scope: 'authorization', key: 'token:blacklist:jti-1' },
      { scope: 'authorization', key: 'user_blacklist:user-1' },
    );

    expect(mockRedisEval.mock.calls[0]?.[2]).toBe('auth:user_blacklist:user-1');
    expect(mockRedisSetex).toHaveBeenCalledWith('auth:token:blacklist:jti-1', 60, '1');
    expect(mockRedisMget).toHaveBeenCalledWith(
      'auth:token:blacklist:jti-1',
      'auth:user_blacklist:user-1',
    );
  });

  it('rejects invalid max-integer inputs before reaching Redis', async () => {
    const service = new RedisService({ url: 'redis://redis:6379' });

    await expect(service.setMaxSafeInteger('key', 0, 86_400)).rejects.toThrow(
      'value must be a positive safe integer',
    );
    await expect(service.setMaxSafeInteger('key', 1_000_000, 0)).rejects.toThrow(
      'ttlSeconds must be a positive safe integer',
    );
    expect(mockRedisEval).not.toHaveBeenCalled();
  });

  it('surfaces malformed-existing-value and invalid-result failures', async () => {
    const service = new RedisService({ url: 'redis://redis:6379' });
    mockRedisEval.mockRejectedValueOnce(new Error('EXISTING_VALUE_NOT_POSITIVE_INTEGER'));

    await expect(service.setMaxSafeInteger('key', 1_000_000, 86_400)).rejects.toThrow(
      'EXISTING_VALUE_NOT_POSITIVE_INTEGER',
    );

    mockRedisEval.mockResolvedValueOnce('1000000');
    await expect(service.setMaxSafeInteger('key', 1_000_000, 86_400)).rejects.toThrow(
      'Redis returned an invalid max-integer result',
    );
  });
});
