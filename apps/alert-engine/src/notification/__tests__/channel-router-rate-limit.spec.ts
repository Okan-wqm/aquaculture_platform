import { ChannelRouterService, UserNotificationPreferences, ChannelConfig } from '../channel-router.service';
import { NotificationChannel } from '../../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

/**
 * Tests for ChannelRouterService rate limiting functionality.
 * Rate limiting is now Redis-based (distributed across replicas).
 * Tests verify the checkRateLimit + recordDelivery pattern via Redis mocks.
 */

const createMockRedisService = () => {
  const store = new Map<string, string>();
  return {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: string, _ttl?: number) => {
      store.set(key, value);
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    incr: jest.fn(async (key: string) => {
      const current = parseInt(store.get(key) || '0', 10);
      const next = current + 1;
      store.set(key, String(next));
      return next;
    }),
    expire: jest.fn().mockResolvedValue(true),
    deletePattern: jest.fn(async (pattern: string) => {
      const prefix = pattern.replace('*', '');
      for (const key of store.keys()) {
        if (key.startsWith(prefix) || key.includes(prefix.replace(':', ''))) {
          store.delete(key);
        }
      }
      return 0;
    }),
    _store: store,
  } as any;
};

describe('ChannelRouterService Rate Limiting (Redis-based)', () => {
  let service: ChannelRouterService;
  let mockRedis: ReturnType<typeof createMockRedisService>;

  beforeEach(() => {
    mockRedis = createMockRedisService();
    service = new ChannelRouterService(mockRedis);
  });

  describe('checkRateLimit', () => {
    it('should allow delivery when under limit', async () => {
      const allowed = await service.checkRateLimit('user-1', NotificationChannel.EMAIL, 10, 100);
      expect(allowed).toBe(true);
    });

    it('should deny delivery when hourly limit exceeded', async () => {
      // Simulate 10 deliveries via Redis state
      for (let i = 0; i < 10; i++) {
        await service.recordDelivery('user-1', NotificationChannel.EMAIL);
      }

      const allowed = await service.checkRateLimit('user-1', NotificationChannel.EMAIL, 10, 100);
      expect(allowed).toBe(false);
    });

    it('should deny delivery when daily limit exceeded', async () => {
      for (let i = 0; i < 5; i++) {
        await service.recordDelivery('user-1', NotificationChannel.EMAIL);
      }

      const allowed = await service.checkRateLimit('user-1', NotificationChannel.EMAIL, 100, 5);
      expect(allowed).toBe(false);
    });
  });

  describe('recordDelivery', () => {
    it('should increment Redis counters', async () => {
      await service.recordDelivery('user-1', NotificationChannel.EMAIL);

      expect(mockRedis.incr).toHaveBeenCalledTimes(2); // hourly + daily
    });

    it('should set TTL on first increment', async () => {
      await service.recordDelivery('user-1', NotificationChannel.EMAIL);

      expect(mockRedis.expire).toHaveBeenCalled();
    });
  });

  describe('Multiple Users', () => {
    it('should track rate limits separately per user via Redis keys', async () => {
      // Exhaust user1's limit
      for (let i = 0; i < 5; i++) {
        await service.recordDelivery('user-1', NotificationChannel.EMAIL);
      }

      // User1 should be rate limited
      const user1Allowed = await service.checkRateLimit('user-1', NotificationChannel.EMAIL, 5, 100);
      expect(user1Allowed).toBe(false);

      // User2 should NOT be affected
      const user2Allowed = await service.checkRateLimit('user-2', NotificationChannel.EMAIL, 5, 100);
      expect(user2Allowed).toBe(true);
    });
  });

  describe('Reset Rate Limits', () => {
    it('should reset rate limits via Redis deletePattern', async () => {
      await service.recordDelivery('user-1', NotificationChannel.EMAIL);
      await service.resetRateLimits('user-1');

      expect(mockRedis.deletePattern).toHaveBeenCalledWith(
        expect.stringContaining('user-1'),
      );
    });

    it('should reset all rate limits', async () => {
      await service.resetRateLimits();

      expect(mockRedis.deletePattern).toHaveBeenCalledWith('ratelimit:*');
    });
  });

  describe('route() passes channels through (rate limiting is async)', () => {
    it('should not filter channels synchronously during route()', () => {
      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SMS],
        preferredChannel: NotificationChannel.EMAIL,
        channelConfigs: {
          [NotificationChannel.EMAIL]: {
            enabled: true,
            rateLimit: { maxPerHour: 1, maxPerDay: 1 },
          } as ChannelConfig,
        } as Record<NotificationChannel, ChannelConfig>,
      };

      service.setUserPreferences(prefs);

      // route() should pass channels through; actual rate limiting
      // happens in checkRateLimit() called before send
      const decision = service.route('user-1', AlertSeverity.HIGH);
      expect(decision.channels).toContain(NotificationChannel.EMAIL);
    });
  });
});
