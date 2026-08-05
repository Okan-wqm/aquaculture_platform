import {
  UserTokenRevocationService,
  type UserTokenRevocationRedisStore,
  userBlacklistKey,
  userInvalidationEpochFromDate,
} from '../user-token-revocation.service';

describe('UserTokenRevocationService', () => {
  const userId = 'user-1';
  let redis: jest.Mocked<UserTokenRevocationRedisStore>;
  let service: UserTokenRevocationService;

  beforeEach(() => {
    redis = {
      setAuthorizationMaxSafeInteger: jest
        .fn()
        .mockImplementation((_key, value) => Promise.resolve(value)),
      getAuthorization: jest.fn().mockResolvedValue(null),
    };
    service = new UserTokenRevocationService(redis);
  });

  it('pins the exact authorization-owned logical key', () => {
    expect(userBlacklistKey(userId)).toBe('user_blacklist:user-1');
  });

  it('writes a max-only epoch through the authorization namespace', async () => {
    const invalidatedAt = new Date('2026-07-11T00:00:00Z');

    await service.revokeUserTokens(userId, invalidatedAt);

    expect(redis.setAuthorizationMaxSafeInteger).toHaveBeenCalledWith(
      'user_blacklist:user-1',
      userInvalidationEpochFromDate(invalidatedAt),
      24 * 60 * 60,
    );
  });

  it('rejects tokens issued before or at the marker and accepts only newer tokens', async () => {
    redis.getAuthorization.mockResolvedValue('1783771200');

    await expect(service.isTokenValid(userId, new Date('2026-07-11T11:59:59Z'))).resolves.toBe(
      false,
    );
    await expect(service.isTokenValid(userId, new Date('2026-07-11T12:00:00Z'))).resolves.toBe(
      false,
    );
    await expect(service.isTokenValid(userId, new Date('2026-07-11T12:00:01Z'))).resolves.toBe(
      true,
    );
  });

  it('accepts when no user invalidation marker exists', async () => {
    await expect(service.isTokenValid(userId, new Date('2026-07-11T12:00:00Z'))).resolves.toBe(
      true,
    );
  });

  it.each(['0', '-1', 'not-an-epoch', '9007199254740992'])(
    'fails closed for malformed marker %s',
    async (marker) => {
      redis.getAuthorization.mockResolvedValue(marker);
      await expect(service.isTokenValid(userId, new Date('2026-07-11T12:00:00Z'))).resolves.toBe(
        false,
      );
    },
  );

  it('rejects invalid dates before reaching Redis', async () => {
    await expect(service.revokeUserTokens(userId, new Date(Number.NaN))).rejects.toThrow(
      'Invalidation time must be a valid positive date',
    );
    await expect(service.isTokenValid(userId, new Date(Number.NaN))).rejects.toThrow(
      'Invalidation time must be a valid positive date',
    );
    expect(redis.setAuthorizationMaxSafeInteger).not.toHaveBeenCalled();
    expect(redis.getAuthorization).not.toHaveBeenCalled();
  });

  it('surfaces Redis failures instead of falling back to process-local state', async () => {
    redis.setAuthorizationMaxSafeInteger.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(service.revokeUserTokens(userId)).rejects.toThrow('redis unavailable');

    redis.getAuthorization.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(service.isTokenValid(userId, new Date('2026-07-11T12:00:00Z'))).rejects.toThrow(
      'redis unavailable',
    );
  });
});
