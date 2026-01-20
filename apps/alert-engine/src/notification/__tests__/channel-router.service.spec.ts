import { Test, TestingModule } from '@nestjs/testing';
import {
  ChannelRouterService,
  UserNotificationPreferences,
  RoutingRule,
} from '../channel-router.service';
import { NotificationChannel } from '../../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';

describe('ChannelRouterService', () => {
  let service: ChannelRouterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ChannelRouterService],
    }).compile();

    service = module.get<ChannelRouterService>(ChannelRouterService);
  });

  afterEach(() => {
    service.resetRateLimits();
  });

  describe('route', () => {
    it('should route notification to default channels based on severity', () => {
      const result = service.route('user-1', AlertSeverity.CRITICAL);

      expect(result.userId).toBe('user-1');
      expect(result.channels.length).toBeGreaterThan(0);
      expect(result.channels).toContain(NotificationChannel.EMAIL);
    });

    it('should include more channels for higher severity', () => {
      const criticalResult = service.route('user-1', AlertSeverity.CRITICAL);
      const lowResult = service.route('user-1', AlertSeverity.LOW);

      expect(criticalResult.channels.length).toBeGreaterThan(lowResult.channels.length);
    });

    it('should use requested channels when provided', () => {
      const result = service.route('user-1', AlertSeverity.HIGH, [NotificationChannel.SLACK]);

      expect(result.channels).toContain(NotificationChannel.SLACK);
    });

    it('should filter by user preferences', () => {
      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL],
        preferredChannel: NotificationChannel.EMAIL,
      };

      service.setUserPreferences(prefs);

      const result = service.route('user-1', AlertSeverity.CRITICAL);

      expect(result.channels).toContain(NotificationChannel.EMAIL);
      expect(result.channels).not.toContain(NotificationChannel.SMS);
    });

    it('should filter by channel availability', () => {
      service.updateChannelStatus(NotificationChannel.SMS, false);

      const result = service.route('user-1', AlertSeverity.CRITICAL);

      expect(result.channels).not.toContain(NotificationChannel.SMS);
    });

    it('should apply routing rules', () => {
      const rule: RoutingRule = {
        id: 'rule-1',
        name: 'High severity to SMS',
        priority: 100,
        conditions: [
          { field: 'severity', operator: 'eq', value: AlertSeverity.HIGH },
        ],
        targetChannels: [NotificationChannel.SMS, NotificationChannel.PUSH],
        enabled: true,
      };

      service.addRoutingRule(rule);

      const result = service.route('user-1', AlertSeverity.HIGH);

      expect(result.channels).toContain(NotificationChannel.SMS);
      expect(result.channels).toContain(NotificationChannel.PUSH);
    });

    it('should respect quiet hours for non-critical alerts', () => {
      // Set quiet hours to current time
      const now = new Date();
      const startTime = `${now.getHours().toString().padStart(2, '0')}:00`;
      const endHour = (now.getHours() + 2) % 24;
      const endTime = `${endHour.toString().padStart(2, '0')}:00`;

      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SMS],
        preferredChannel: NotificationChannel.EMAIL,
        quietHours: {
          start: startTime,
          end: endTime,
          timezone: 'UTC',
        },
      };

      service.setUserPreferences(prefs);

      const result = service.route('user-1', AlertSeverity.LOW);

      expect(result.channels).toHaveLength(0);
      expect(result.reason).toContain('quiet hours');
    });

    it('should allow critical alerts during quiet hours', () => {
      const now = new Date();
      const startTime = `${now.getHours().toString().padStart(2, '0')}:00`;
      const endHour = (now.getHours() + 2) % 24;
      const endTime = `${endHour.toString().padStart(2, '0')}:00`;

      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SMS],
        preferredChannel: NotificationChannel.EMAIL,
        quietHours: {
          start: startTime,
          end: endTime,
          timezone: 'UTC',
        },
      };

      service.setUserPreferences(prefs);

      const result = service.route('user-1', AlertSeverity.CRITICAL);

      expect(result.channels.length).toBeGreaterThan(0);
    });

    it('should determine primary channel', () => {
      const result = service.route('user-1', AlertSeverity.CRITICAL);

      expect(result.primaryChannel).toBeDefined();
    });

    it('should use preferred channel as primary when available', () => {
      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SLACK],
        preferredChannel: NotificationChannel.SLACK,
      };

      service.setUserPreferences(prefs);

      const result = service.route('user-1', AlertSeverity.HIGH);

      expect(result.primaryChannel).toBe(NotificationChannel.SLACK);
    });

    it('should include reason in result', () => {
      const result = service.route('user-1', AlertSeverity.HIGH);

      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });

  describe('routeToMany', () => {
    it('should route to multiple users', () => {
      const results = service.routeToMany(
        ['user-1', 'user-2', 'user-3'],
        AlertSeverity.HIGH,
      );

      expect(results.size).toBe(3);
      expect(results.has('user-1')).toBe(true);
      expect(results.has('user-2')).toBe(true);
      expect(results.has('user-3')).toBe(true);
    });

    it('should apply individual user preferences', () => {
      service.setUserPreferences({
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL],
        preferredChannel: NotificationChannel.EMAIL,
      });

      service.setUserPreferences({
        userId: 'user-2',
        enabledChannels: [NotificationChannel.SLACK],
        preferredChannel: NotificationChannel.SLACK,
      });

      const results = service.routeToMany(['user-1', 'user-2'], AlertSeverity.HIGH);

      expect(results.get('user-1')?.primaryChannel).toBe(NotificationChannel.EMAIL);
      expect(results.get('user-2')?.primaryChannel).toBe(NotificationChannel.SLACK);
    });
  });

  describe('user preferences', () => {
    it('should set and get user preferences', () => {
      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SMS],
        preferredChannel: NotificationChannel.EMAIL,
      };

      service.setUserPreferences(prefs);

      const retrieved = service.getUserPreferences('user-1');
      expect(retrieved).toEqual(prefs);
    });

    it('should return undefined for unknown user', () => {
      const result = service.getUserPreferences('unknown');

      expect(result).toBeUndefined();
    });

    it('should remove user preferences', () => {
      service.setUserPreferences({
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL],
        preferredChannel: NotificationChannel.EMAIL,
      });

      const removed = service.removeUserPreferences('user-1');

      expect(removed).toBe(true);
      expect(service.getUserPreferences('user-1')).toBeUndefined();
    });

    it('should return false when removing non-existent preferences', () => {
      const removed = service.removeUserPreferences('non-existent');

      expect(removed).toBe(false);
    });

    it('should apply channel-specific severity filter', () => {
      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SMS],
        preferredChannel: NotificationChannel.EMAIL,
        channelConfigs: {
          [NotificationChannel.SMS]: {
            enabled: true,
            severityFilter: [AlertSeverity.CRITICAL],
          },
          [NotificationChannel.EMAIL]: {
            enabled: true,
          },
        },
      };

      service.setUserPreferences(prefs);

      // HIGH severity should not include SMS (filtered to CRITICAL only)
      const highResult = service.route('user-1', AlertSeverity.HIGH);
      expect(highResult.channels).not.toContain(NotificationChannel.SMS);

      // CRITICAL should include SMS
      const criticalResult = service.route('user-1', AlertSeverity.CRITICAL);
      expect(criticalResult.channels).toContain(NotificationChannel.SMS);
    });
  });

  describe('channel status', () => {
    it('should update and get channel status', () => {
      service.updateChannelStatus(NotificationChannel.SMS, false, 0, 'Provider unavailable');

      const status = service.getChannelStatus(NotificationChannel.SMS);

      expect(status?.available).toBe(false);
      expect(status?.healthScore).toBe(0);
      expect(status?.errorMessage).toBe('Provider unavailable');
    });

    it('should get all channel statuses', () => {
      const statuses = service.getAllChannelStatuses();

      expect(statuses.length).toBeGreaterThan(0);
    });

    it('should get available channels', () => {
      service.updateChannelStatus(NotificationChannel.SMS, false);
      service.updateChannelStatus(NotificationChannel.SLACK, false);

      const available = service.getAvailableChannels();

      expect(available).not.toContain(NotificationChannel.SMS);
      expect(available).not.toContain(NotificationChannel.SLACK);
      expect(available).toContain(NotificationChannel.EMAIL);
    });

    it('should set health score correctly', () => {
      service.updateChannelStatus(NotificationChannel.EMAIL, true, 85);

      const status = service.getChannelStatus(NotificationChannel.EMAIL);

      expect(status?.healthScore).toBe(85);
    });
  });

  describe('routing rules', () => {
    it('should add and get routing rules', () => {
      const rule: RoutingRule = {
        id: 'rule-1',
        name: 'Test Rule',
        priority: 50,
        conditions: [],
        targetChannels: [NotificationChannel.EMAIL],
        enabled: true,
      };

      service.addRoutingRule(rule);

      const rules = service.getRoutingRules();
      expect(rules.some(r => r.id === 'rule-1')).toBe(true);
    });

    it('should remove routing rule', () => {
      service.addRoutingRule({
        id: 'to-remove',
        name: 'To Remove',
        priority: 50,
        conditions: [],
        targetChannels: [NotificationChannel.EMAIL],
        enabled: true,
      });

      const removed = service.removeRoutingRule('to-remove');

      expect(removed).toBe(true);
      expect(service.getRoutingRules().some(r => r.id === 'to-remove')).toBe(false);
    });

    it('should return rules sorted by priority', () => {
      service.addRoutingRule({
        id: 'low-priority',
        name: 'Low',
        priority: 10,
        conditions: [],
        targetChannels: [],
        enabled: true,
      });

      service.addRoutingRule({
        id: 'high-priority',
        name: 'High',
        priority: 100,
        conditions: [],
        targetChannels: [],
        enabled: true,
      });

      const rules = service.getRoutingRules();

      expect(rules[0].id).toBe('high-priority');
      expect(rules[1].id).toBe('low-priority');
    });

    it('should evaluate rule conditions correctly', () => {
      service.addRoutingRule({
        id: 'critical-rule',
        name: 'Critical Only',
        priority: 100,
        conditions: [
          { field: 'severity', operator: 'eq', value: AlertSeverity.CRITICAL },
        ],
        targetChannels: [NotificationChannel.PAGERDUTY],
        enabled: true,
      });

      const criticalResult = service.route('user-1', AlertSeverity.CRITICAL);
      const highResult = service.route('user-1', AlertSeverity.HIGH);

      expect(criticalResult.channels).toContain(NotificationChannel.PAGERDUTY);
      expect(highResult.channels).not.toContain(NotificationChannel.PAGERDUTY);
    });

    it('should support in operator', () => {
      service.addRoutingRule({
        id: 'multi-severity',
        name: 'Multi Severity',
        priority: 100,
        conditions: [
          {
            field: 'severity',
            operator: 'in',
            value: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
          },
        ],
        targetChannels: [NotificationChannel.SMS],
        enabled: true,
      });

      const criticalResult = service.route('user-1', AlertSeverity.CRITICAL);
      const highResult = service.route('user-1', AlertSeverity.HIGH);
      const lowResult = service.route('user-1', AlertSeverity.LOW);

      expect(criticalResult.channels).toContain(NotificationChannel.SMS);
      expect(highResult.channels).toContain(NotificationChannel.SMS);
      expect(lowResult.channels).not.toContain(NotificationChannel.SMS);
    });

    it('should skip disabled rules', () => {
      service.addRoutingRule({
        id: 'disabled-rule',
        name: 'Disabled',
        priority: 1000,
        conditions: [],
        targetChannels: [NotificationChannel.WEBHOOK],
        enabled: false,
      });

      const result = service.route('user-1', AlertSeverity.HIGH);

      // Should use default channels, not the disabled rule
      expect(result.channels).not.toEqual([NotificationChannel.WEBHOOK]);
    });
  });

  describe('rate limiting', () => {
    it('should apply rate limits', () => {
      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL, NotificationChannel.SMS],
        preferredChannel: NotificationChannel.EMAIL,
        channelConfigs: {
          [NotificationChannel.SMS]: {
            enabled: true,
            rateLimit: {
              maxPerHour: 2,
              maxPerDay: 10,
            },
          },
          [NotificationChannel.EMAIL]: {
            enabled: true,
          },
        },
      };

      service.setUserPreferences(prefs);

      // First two requests should include SMS
      service.route('user-1', AlertSeverity.HIGH);
      service.route('user-1', AlertSeverity.HIGH);

      // Third request should not include SMS (rate limited)
      const result = service.route('user-1', AlertSeverity.HIGH);

      expect(result.channels).not.toContain(NotificationChannel.SMS);
    });

    it('should reset rate limits', () => {
      const prefs: UserNotificationPreferences = {
        userId: 'user-1',
        enabledChannels: [NotificationChannel.SMS],
        preferredChannel: NotificationChannel.SMS,
        channelConfigs: {
          [NotificationChannel.SMS]: {
            enabled: true,
            rateLimit: {
              maxPerHour: 1,
              maxPerDay: 10,
            },
          },
        },
      };

      service.setUserPreferences(prefs);

      service.route('user-1', AlertSeverity.HIGH);
      service.resetRateLimits('user-1');

      const result = service.route('user-1', AlertSeverity.HIGH);

      expect(result.channels).toContain(NotificationChannel.SMS);
    });

    it('should reset all rate limits', () => {
      service.setUserPreferences({
        userId: 'user-1',
        enabledChannels: [NotificationChannel.SMS],
        preferredChannel: NotificationChannel.SMS,
        channelConfigs: {
          [NotificationChannel.SMS]: {
            enabled: true,
            rateLimit: { maxPerHour: 1, maxPerDay: 10 },
          },
        },
      });

      service.setUserPreferences({
        userId: 'user-2',
        enabledChannels: [NotificationChannel.SMS],
        preferredChannel: NotificationChannel.SMS,
        channelConfigs: {
          [NotificationChannel.SMS]: {
            enabled: true,
            rateLimit: { maxPerHour: 1, maxPerDay: 10 },
          },
        },
      });

      service.route('user-1', AlertSeverity.HIGH);
      service.route('user-2', AlertSeverity.HIGH);

      service.resetRateLimits();

      const result1 = service.route('user-1', AlertSeverity.HIGH);
      const result2 = service.route('user-2', AlertSeverity.HIGH);

      expect(result1.channels).toContain(NotificationChannel.SMS);
      expect(result2.channels).toContain(NotificationChannel.SMS);
    });
  });

  describe('channel priority', () => {
    it('should return correct priority for channels', () => {
      expect(service.getChannelPriority(NotificationChannel.PAGERDUTY)).toBe(100);
      expect(service.getChannelPriority(NotificationChannel.SMS)).toBe(90);
      expect(service.getChannelPriority(NotificationChannel.EMAIL)).toBe(50);
    });
  });

  describe('recommended channels', () => {
    it('should return recommended channels for severity', () => {
      const critical = service.getRecommendedChannels(AlertSeverity.CRITICAL);
      const info = service.getRecommendedChannels(AlertSeverity.INFO);

      expect(critical.length).toBeGreaterThan(info.length);
      expect(critical).toContain(NotificationChannel.PAGERDUTY);
      expect(info).toContain(NotificationChannel.EMAIL);
    });
  });

  describe('statistics', () => {
    it('should return routing statistics', () => {
      service.setUserPreferences({
        userId: 'user-1',
        enabledChannels: [NotificationChannel.EMAIL],
        preferredChannel: NotificationChannel.EMAIL,
      });

      service.addRoutingRule({
        id: 'rule-1',
        name: 'Test',
        priority: 50,
        conditions: [],
        targetChannels: [],
        enabled: true,
      });

      const stats = service.getStatistics();

      expect(stats.usersWithPreferences).toBe(1);
      expect(stats.routingRules).toBe(1);
      expect((stats.totalChannels as number)).toBeGreaterThan(0);
    });
  });
});
