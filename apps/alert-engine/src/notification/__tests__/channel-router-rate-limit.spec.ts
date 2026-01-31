import { ChannelRouterService, UserNotificationPreferences, ChannelConfig } from '../channel-router.service';
import { NotificationChannel } from '../../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

/**
 * Tests for ChannelRouterService rate limiting functionality
 * Verifies that hourly and daily rate limits work independently
 */
describe('ChannelRouterService Rate Limiting', () => {
  let service: ChannelRouterService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new ChannelRouterService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const createUserPreferences = (
    userId: string,
    maxPerHour: number,
    maxPerDay: number,
  ): UserNotificationPreferences => ({
    userId,
    enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SMS],
    preferredChannel: NotificationChannel.EMAIL,
    channelConfigs: {
      [NotificationChannel.EMAIL]: {
        enabled: true,
        rateLimit: { maxPerHour, maxPerDay },
      } as ChannelConfig,
      [NotificationChannel.SMS]: {
        enabled: true,
        rateLimit: { maxPerHour, maxPerDay },
      } as ChannelConfig,
    } as Record<NotificationChannel, ChannelConfig>,
  });

  describe('Hourly Rate Limits', () => {
    it('should enforce hourly rate limits', () => {
      const userId = 'user-hourly-test';
      const prefs = createUserPreferences(userId, 3, 100); // 3 per hour, 100 per day
      service.setUserPreferences(prefs);

      // First 3 should succeed
      for (let i = 0; i < 3; i++) {
        const decision = service.route(userId, AlertSeverity.HIGH);
        expect(decision.channels).toContain(NotificationChannel.EMAIL);
      }

      // 4th should be rate limited
      const decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);
    });

    it('should reset hourly counter after 1 hour', () => {
      const userId = 'user-hourly-reset';
      const prefs = createUserPreferences(userId, 2, 100);
      service.setUserPreferences(prefs);

      // Exhaust hourly limit
      service.route(userId, AlertSeverity.HIGH);
      service.route(userId, AlertSeverity.HIGH);

      // Should be rate limited
      let decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);

      // Advance time by 61 minutes
      jest.advanceTimersByTime(61 * 60 * 1000);

      // Should work again
      decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).toContain(NotificationChannel.EMAIL);
    });
  });

  describe('Daily Rate Limits', () => {
    it('should enforce daily rate limits independently from hourly', () => {
      const userId = 'user-daily-test';
      const prefs = createUserPreferences(userId, 100, 5); // 100 per hour, 5 per day
      service.setUserPreferences(prefs);

      // First 5 should succeed
      for (let i = 0; i < 5; i++) {
        const decision = service.route(userId, AlertSeverity.HIGH);
        expect(decision.channels).toContain(NotificationChannel.EMAIL);
      }

      // 6th should be rate limited (daily limit)
      const decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);
    });

    it('should NOT reset daily counter after just 1 hour', () => {
      const userId = 'user-daily-no-reset';
      const prefs = createUserPreferences(userId, 100, 3); // 100 per hour, 3 per day
      service.setUserPreferences(prefs);

      // Exhaust daily limit
      service.route(userId, AlertSeverity.HIGH);
      service.route(userId, AlertSeverity.HIGH);
      service.route(userId, AlertSeverity.HIGH);

      // Advance time by 1 hour (this should NOT reset daily counter)
      jest.advanceTimersByTime(60 * 60 * 1000);

      // Should still be rate limited by daily counter
      const decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);
    });

    it('should reset daily counter after 24 hours', () => {
      const userId = 'user-daily-reset';
      const prefs = createUserPreferences(userId, 100, 3);
      service.setUserPreferences(prefs);

      // Exhaust daily limit
      service.route(userId, AlertSeverity.HIGH);
      service.route(userId, AlertSeverity.HIGH);
      service.route(userId, AlertSeverity.HIGH);

      // Advance time by 25 hours
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);

      // Should work again after daily reset
      const decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).toContain(NotificationChannel.EMAIL);
    });
  });

  describe('Independent Counter Resets', () => {
    it('should reset hourly counter while keeping daily counter', () => {
      const userId = 'user-independent';
      const prefs = createUserPreferences(userId, 2, 10);
      service.setUserPreferences(prefs);

      // Use 2 notifications (exhaust hourly, 2/10 daily)
      service.route(userId, AlertSeverity.HIGH);
      service.route(userId, AlertSeverity.HIGH);

      // Should be hourly rate limited
      let decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);

      // Advance 1 hour (resets hourly, but daily should be at 2)
      jest.advanceTimersByTime(61 * 60 * 1000);

      // Hourly reset - can send 2 more
      service.route(userId, AlertSeverity.HIGH);
      service.route(userId, AlertSeverity.HIGH);

      // Should be hourly rate limited again
      decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);

      // Advance another hour
      jest.advanceTimersByTime(61 * 60 * 1000);

      // Can continue until daily limit (10 total)
      for (let i = 0; i < 6; i++) {
        service.route(userId, AlertSeverity.HIGH);
      }

      // Daily limit reached (10 notifications)
      decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);
    });
  });

  describe('Multiple Users', () => {
    it('should track rate limits separately per user', () => {
      const user1 = 'user-1';
      const user2 = 'user-2';
      const prefs1 = createUserPreferences(user1, 2, 10);
      const prefs2 = createUserPreferences(user2, 2, 10);
      service.setUserPreferences(prefs1);
      service.setUserPreferences(prefs2);

      // Exhaust user1's hourly limit
      service.route(user1, AlertSeverity.HIGH);
      service.route(user1, AlertSeverity.HIGH);

      // User1 should be rate limited
      let decision = service.route(user1, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);

      // User2 should NOT be affected
      decision = service.route(user2, AlertSeverity.HIGH);
      expect(decision.channels).toContain(NotificationChannel.EMAIL);
    });
  });

  describe('Reset Rate Limits', () => {
    it('should reset rate limits for specific user', () => {
      const userId = 'user-reset';
      const prefs = createUserPreferences(userId, 2, 10);
      service.setUserPreferences(prefs);

      // Exhaust hourly limit
      service.route(userId, AlertSeverity.HIGH);
      service.route(userId, AlertSeverity.HIGH);

      // Should be rate limited
      let decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).not.toContain(NotificationChannel.EMAIL);

      // Admin resets rate limits for this user
      service.resetRateLimits(userId);

      // Should work again
      decision = service.route(userId, AlertSeverity.HIGH);
      expect(decision.channels).toContain(NotificationChannel.EMAIL);
    });

    it('should reset rate limits for all users', () => {
      const user1 = 'user-reset-1';
      const user2 = 'user-reset-2';
      const prefs1 = createUserPreferences(user1, 2, 10);
      const prefs2 = createUserPreferences(user2, 2, 10);
      service.setUserPreferences(prefs1);
      service.setUserPreferences(prefs2);

      // Exhaust both users' limits
      service.route(user1, AlertSeverity.HIGH);
      service.route(user1, AlertSeverity.HIGH);
      service.route(user2, AlertSeverity.HIGH);
      service.route(user2, AlertSeverity.HIGH);

      // Both should be rate limited
      expect(service.route(user1, AlertSeverity.HIGH).channels).not.toContain(NotificationChannel.EMAIL);
      expect(service.route(user2, AlertSeverity.HIGH).channels).not.toContain(NotificationChannel.EMAIL);

      // Reset all
      service.resetRateLimits();

      // Both should work again
      expect(service.route(user1, AlertSeverity.HIGH).channels).toContain(NotificationChannel.EMAIL);
      expect(service.route(user2, AlertSeverity.HIGH).channels).toContain(NotificationChannel.EMAIL);
    });
  });
});
