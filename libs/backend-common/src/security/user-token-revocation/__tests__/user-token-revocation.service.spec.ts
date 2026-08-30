import { UserTokenRevocationService, userBlacklistKey } from '../user-token-revocation.service';

describe('UserTokenRevocationService (RBAC-HIGH-001)', () => {
  const USER = 'user-1';

  describe('userBlacklistKey', () => {
    it('is the exact contract the gateway read path enforces', () => {
      // The gateway RedisTokenBlacklistStore reads this key; drift here silently
      // breaks fleet-wide revocation, so pin it.
      expect(userBlacklistKey(USER)).toBe('user_blacklist:user-1');
    });
  });

  describe('with Redis', () => {
    const makeRedis = (): { set: jest.Mock; get: jest.Mock } => ({
      set: jest.fn().mockResolvedValue(undefined),
      get: jest.fn(),
    });

    it('writes the invalidation epoch (seconds) to the canonical key with a 24h TTL', async () => {
      const redis = makeRedis();
      const svc = new UserTokenRevocationService(redis);
      const at = new Date('2026-07-11T00:00:00Z');

      await svc.revokeUserTokens(USER, at);

      expect(redis.set).toHaveBeenCalledWith(
        'user_blacklist:user-1',
        String(Math.floor(at.getTime() / 1000)),
        24 * 60 * 60,
      );
    });

    it('invalidates a token issued BEFORE the epoch and keeps one issued after', async () => {
      const redis = makeRedis();
      const invalidatedAt = Math.floor(new Date('2026-07-11T12:00:00Z').getTime() / 1000);
      redis.get.mockResolvedValue(String(invalidatedAt));
      const svc = new UserTokenRevocationService(redis);

      const before = new Date('2026-07-11T11:59:00Z');
      const after = new Date('2026-07-11T12:00:30Z');
      expect(await svc.isTokenValid(USER, before)).toBe(false);
      expect(await svc.isTokenValid(USER, after)).toBe(true);
    });

    it('treats an absent marker as valid', async () => {
      const redis = makeRedis();
      redis.get.mockResolvedValue(null);
      const svc = new UserTokenRevocationService(redis);
      expect(await svc.isTokenValid(USER, new Date())).toBe(true);
    });
  });

  describe('in-memory fallback (no Redis)', () => {
    it('revokes then rejects an earlier-issued token', async () => {
      const svc = new UserTokenRevocationService(undefined);
      const issuedBefore = new Date('2026-07-11T09:00:00Z');
      await svc.revokeUserTokens(USER, new Date('2026-07-11T10:00:00Z'));
      expect(await svc.isTokenValid(USER, issuedBefore)).toBe(false);
      expect(await svc.isTokenValid(USER, new Date('2026-07-11T10:30:00Z'))).toBe(true);
    });
  });
});
