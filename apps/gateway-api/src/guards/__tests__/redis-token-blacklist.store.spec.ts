import {
  InMemoryTokenBlacklistStore,
  RedisTokenBlacklistStore,
  buildGatewayTokenBlacklistStore,
  type GatewayAuthorizationRedisClient,
} from '../redis-token-blacklist.store';

describe('RedisTokenBlacklistStore', () => {
  let redis: jest.Mocked<GatewayAuthorizationRedisClient>;
  let store: RedisTokenBlacklistStore;

  beforeEach(() => {
    redis = {
      getAuthorization: jest.fn().mockResolvedValue(null),
      mgetScoped: jest.fn().mockResolvedValue([null, null]),
    };
    store = new RedisTokenBlacklistStore(redis);
  });

  it('reads per-JTI markers from the auth-owned namespace', async () => {
    redis.getAuthorization.mockResolvedValueOnce('1');

    await expect(store.isBlacklisted('jti-1')).resolves.toBe(true);

    expect(redis.getAuthorization).toHaveBeenCalledWith('token:blacklist:jti-1');
  });

  it('fails closed when a per-JTI lookup fails', async () => {
    redis.getAuthorization.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(store.isBlacklisted('jti-1')).resolves.toBe(true);
  });

  it('reads JTI and user epoch in one explicitly-scoped round trip', async () => {
    await expect(store.isValidToken('jti-1', 'user-1', 1_000_000)).resolves.toBe(true);

    expect(redis.mgetScoped).toHaveBeenCalledWith(
      { scope: 'authorization', key: 'token:blacklist:jti-1' },
      { scope: 'authorization', key: 'user_blacklist:user-1' },
    );
  });

  it('denies a per-JTI marker', async () => {
    redis.mgetScoped.mockResolvedValueOnce(['1', null]);
    await expect(store.isValidToken('jti-1', 'user-1', 1_000_000)).resolves.toBe(false);
  });

  it('denies a token issued before a user invalidation epoch', async () => {
    redis.mgetScoped.mockResolvedValueOnce([null, '1000500']);
    await expect(store.isValidToken('jti-1', 'user-1', 1_000_000)).resolves.toBe(false);
  });

  it('denies a token issued at the user invalidation epoch', async () => {
    redis.mgetScoped.mockResolvedValueOnce([null, '1000000']);
    await expect(store.isValidToken('jti-1', 'user-1', 1_000_000)).resolves.toBe(false);
  });

  it('accepts only a token issued after the user invalidation epoch', async () => {
    redis.mgetScoped.mockResolvedValueOnce([null, '1000000']);
    await expect(store.isValidToken('jti-1', 'user-1', 1_000_001)).resolves.toBe(true);
  });

  it.each([
    [null, 'not-an-epoch'],
    [null, '0'],
    [null, '9007199254740992'],
  ] as const)('fails closed for malformed marker tuple %p', async (jti, epoch) => {
    redis.mgetScoped.mockResolvedValueOnce([jti, epoch]);
    await expect(store.isValidToken('jti-1', 'user-1', 1_000_000)).resolves.toBe(false);
  });

  it('fails closed for an incomplete MGET result', async () => {
    redis.mgetScoped.mockResolvedValueOnce([null]);
    await expect(store.isValidToken('jti-1', 'user-1', 1_000_000)).resolves.toBe(false);
  });

  it('fails closed when the composite read fails', async () => {
    redis.mgetScoped.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(store.isValidToken('jti-1', 'user-1', 1_000_000)).resolves.toBe(false);
  });

  it('fails closed for missing identity claims', async () => {
    await expect(store.isValidToken('', 'user-1', 1_000_000)).resolves.toBe(false);
    await expect(store.isValidToken('   ', 'user-1', 1_000_000)).resolves.toBe(false);
    await expect(store.isValidToken('jti-1', '', 1_000_000)).resolves.toBe(false);
    await expect(store.isValidToken('jti-1', '   ', 1_000_000)).resolves.toBe(false);
    await expect(store.isValidToken('jti-1', 'user-1', 0)).resolves.toBe(false);
    expect(redis.mgetScoped).not.toHaveBeenCalled();
  });
});

describe('buildGatewayTokenBlacklistStore', () => {
  const redis: GatewayAuthorizationRedisClient = {
    getAuthorization: jest.fn().mockResolvedValue(null),
    mgetScoped: jest.fn().mockResolvedValue([null, null]),
  };

  it('defaults to distributed Redis enforcement', () => {
    expect(buildGatewayTokenBlacklistStore(redis, 'production', undefined)).toBeInstanceOf(
      RedisTokenBlacklistStore,
    );
  });

  it('allows an explicit bypass only outside production', () => {
    expect(buildGatewayTokenBlacklistStore(redis, 'test', 'false')).toBeInstanceOf(
      InMemoryTokenBlacklistStore,
    );
  });

  it('rejects disabling distributed revocation in production', () => {
    expect(() => buildGatewayTokenBlacklistStore(redis, 'production', false)).toThrow(
      'Distributed token revocation cannot be disabled in production',
    );
  });

  it('rejects malformed configuration instead of silently disabling Redis', () => {
    expect(() => buildGatewayTokenBlacklistStore(redis, 'test', 'yes')).toThrow(
      'TOKEN_BLACKLIST_USE_REDIS must be true or false',
    );
  });
});
