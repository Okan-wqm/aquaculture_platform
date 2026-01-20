import { Injectable, Logger } from '@nestjs/common';
import { NotificationChannel } from '../database/entities/escalation-policy.entity';
import { AlertSeverity } from '../database/entities/alert-rule.entity';

/**
 * User notification preferences
 */
export interface UserNotificationPreferences {
  userId: string;
  enabledChannels: NotificationChannel[];
  preferredChannel: NotificationChannel;
  quietHours?: {
    start: string; // HH:mm format
    end: string;
    timezone: string;
  };
  channelConfigs?: Record<NotificationChannel, ChannelConfig>;
}

/**
 * Channel-specific configuration
 */
export interface ChannelConfig {
  enabled: boolean;
  address?: string; // Email address, phone number, etc.
  severityFilter?: AlertSeverity[];
  rateLimit?: {
    maxPerHour: number;
    maxPerDay: number;
  };
}

/**
 * Routing decision
 */
export interface RoutingDecision {
  userId: string;
  channels: NotificationChannel[];
  primaryChannel: NotificationChannel;
  reason: string;
  metadata?: Record<string, unknown>;
}

/**
 * Channel availability status
 */
export interface ChannelStatus {
  channel: NotificationChannel;
  available: boolean;
  healthScore: number; // 0-100
  lastCheckAt: Date;
  errorMessage?: string;
}

/**
 * Routing rule
 */
export interface RoutingRule {
  id: string;
  name: string;
  priority: number;
  conditions: RoutingCondition[];
  targetChannels: NotificationChannel[];
  enabled: boolean;
}

/**
 * Routing condition
 */
export interface RoutingCondition {
  field: 'severity' | 'tenantId' | 'ruleId' | 'farmId' | 'time';
  operator: 'eq' | 'ne' | 'in' | 'notIn' | 'gt' | 'lt' | 'between';
  value: unknown;
}

/**
 * Channel priority configuration
 */
const CHANNEL_PRIORITY: Record<NotificationChannel, number> = {
  [NotificationChannel.PAGERDUTY]: 100,
  [NotificationChannel.SMS]: 90,
  [NotificationChannel.PUSH]: 80,
  [NotificationChannel.SLACK]: 70,
  [NotificationChannel.TEAMS]: 65,
  [NotificationChannel.EMAIL]: 50,
  [NotificationChannel.WEBHOOK]: 30,
};

/**
 * Severity to channel mapping
 */
const SEVERITY_CHANNELS: Record<AlertSeverity, NotificationChannel[]> = {
  [AlertSeverity.CRITICAL]: [
    NotificationChannel.PAGERDUTY,
    NotificationChannel.SMS,
    NotificationChannel.PUSH,
    NotificationChannel.SLACK,
    NotificationChannel.EMAIL,
  ],
  [AlertSeverity.HIGH]: [
    NotificationChannel.SMS,
    NotificationChannel.PUSH,
    NotificationChannel.SLACK,
    NotificationChannel.EMAIL,
  ],
  [AlertSeverity.MEDIUM]: [
    NotificationChannel.PUSH,
    NotificationChannel.SLACK,
    NotificationChannel.EMAIL,
  ],
  [AlertSeverity.WARNING]: [
    NotificationChannel.PUSH,
    NotificationChannel.SLACK,
    NotificationChannel.EMAIL,
  ],
  [AlertSeverity.LOW]: [NotificationChannel.EMAIL, NotificationChannel.SLACK],
  [AlertSeverity.INFO]: [NotificationChannel.EMAIL],
};

@Injectable()
export class ChannelRouterService {
  private readonly logger = new Logger(ChannelRouterService.name);
  private userPreferences: Map<string, UserNotificationPreferences> = new Map();
  private channelStatus: Map<NotificationChannel, ChannelStatus> = new Map();
  private routingRules: Map<string, RoutingRule> = new Map();
  private rateLimitCounters: Map<string, { hourly: number; daily: number; lastReset: Date }> = new Map();

  constructor() {
    this.initializeChannelStatus();
  }

  /**
   * Route notification to appropriate channels
   */
  route(
    userId: string,
    severity: AlertSeverity,
    requestedChannels?: NotificationChannel[],
    context?: Record<string, unknown>,
  ): RoutingDecision {
    this.logger.debug(`Routing notification for user ${userId} with severity ${severity}`);

    const userPrefs = this.userPreferences.get(userId);
    const availableChannels = this.getAvailableChannels();

    // Apply routing rules first
    const ruleChannels = this.applyRoutingRules(severity, context);

    // Determine candidate channels
    let candidateChannels: NotificationChannel[];

    if (requestedChannels?.length) {
      // Use requested channels if provided
      candidateChannels = requestedChannels;
    } else if (ruleChannels.length) {
      // Use rule-based channels
      candidateChannels = ruleChannels;
    } else {
      // Use severity-based defaults
      candidateChannels = SEVERITY_CHANNELS[severity] || [NotificationChannel.EMAIL];
    }

    // Filter by user preferences
    if (userPrefs) {
      candidateChannels = this.filterByUserPreferences(candidateChannels, userPrefs, severity);
    }

    // Filter by availability
    const finalChannels = candidateChannels.filter(ch => availableChannels.includes(ch));

    // Check quiet hours
    if (userPrefs?.quietHours && this.isInQuietHours(userPrefs.quietHours)) {
      // During quiet hours, only allow critical severity through high-priority channels
      if (severity !== AlertSeverity.CRITICAL) {
        return {
          userId,
          channels: [],
          primaryChannel: NotificationChannel.EMAIL,
          reason: 'Suppressed due to quiet hours',
        };
      }
    }

    // Check rate limits
    const rateLimitedChannels = this.applyRateLimits(userId, finalChannels, userPrefs);

    // Determine primary channel
    const primaryChannel = this.determinePrimaryChannel(rateLimitedChannels, userPrefs);

    return {
      userId,
      channels: rateLimitedChannels,
      primaryChannel,
      reason: this.buildRoutingReason(rateLimitedChannels, severity, userPrefs),
      metadata: {
        severity,
        requestedChannels,
        availableCount: availableChannels.length,
      },
    };
  }

  /**
   * Route to multiple users
   */
  routeToMany(
    userIds: string[],
    severity: AlertSeverity,
    requestedChannels?: NotificationChannel[],
    context?: Record<string, unknown>,
  ): Map<string, RoutingDecision> {
    const decisions = new Map<string, RoutingDecision>();

    for (const userId of userIds) {
      decisions.set(userId, this.route(userId, severity, requestedChannels, context));
    }

    return decisions;
  }

  /**
   * Set user notification preferences
   */
  setUserPreferences(preferences: UserNotificationPreferences): void {
    this.userPreferences.set(preferences.userId, preferences);
    this.logger.log(`Updated preferences for user ${preferences.userId}`);
  }

  /**
   * Get user notification preferences
   */
  getUserPreferences(userId: string): UserNotificationPreferences | undefined {
    return this.userPreferences.get(userId);
  }

  /**
   * Remove user preferences
   */
  removeUserPreferences(userId: string): boolean {
    return this.userPreferences.delete(userId);
  }

  /**
   * Update channel status
   */
  updateChannelStatus(channel: NotificationChannel, available: boolean, healthScore?: number, error?: string): void {
    this.channelStatus.set(channel, {
      channel,
      available,
      healthScore: healthScore ?? (available ? 100 : 0),
      lastCheckAt: new Date(),
      errorMessage: error,
    });
  }

  /**
   * Get channel status
   */
  getChannelStatus(channel: NotificationChannel): ChannelStatus | undefined {
    return this.channelStatus.get(channel);
  }

  /**
   * Get all channel statuses
   */
  getAllChannelStatuses(): ChannelStatus[] {
    return Array.from(this.channelStatus.values());
  }

  /**
   * Get available channels
   */
  getAvailableChannels(): NotificationChannel[] {
    return Array.from(this.channelStatus.values())
      .filter(s => s.available)
      .map(s => s.channel);
  }

  /**
   * Add routing rule
   */
  addRoutingRule(rule: RoutingRule): void {
    this.routingRules.set(rule.id, rule);
    this.logger.log(`Added routing rule: ${rule.name}`);
  }

  /**
   * Remove routing rule
   */
  removeRoutingRule(ruleId: string): boolean {
    return this.routingRules.delete(ruleId);
  }

  /**
   * Get routing rules
   */
  getRoutingRules(): RoutingRule[] {
    return Array.from(this.routingRules.values()).sort((a, b) => b.priority - a.priority);
  }

  /**
   * Apply routing rules
   */
  private applyRoutingRules(severity: AlertSeverity, context?: Record<string, unknown>): NotificationChannel[] {
    const rules = this.getRoutingRules().filter(r => r.enabled);

    for (const rule of rules) {
      if (this.evaluateRuleConditions(rule.conditions, severity, context)) {
        return rule.targetChannels;
      }
    }

    return [];
  }

  /**
   * Evaluate rule conditions
   */
  private evaluateRuleConditions(
    conditions: RoutingCondition[],
    severity: AlertSeverity,
    context?: Record<string, unknown>,
  ): boolean {
    for (const condition of conditions) {
      let value: unknown;

      switch (condition.field) {
        case 'severity':
          value = severity;
          break;
        case 'time':
          value = new Date().getHours();
          break;
        default:
          value = context?.[condition.field];
      }

      if (!this.evaluateCondition(value, condition.operator, condition.value)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Evaluate single condition
   */
  private evaluateCondition(value: unknown, operator: string, expected: unknown): boolean {
    switch (operator) {
      case 'eq':
        return value === expected;
      case 'ne':
        return value !== expected;
      case 'in':
        return Array.isArray(expected) && expected.includes(value);
      case 'notIn':
        return Array.isArray(expected) && !expected.includes(value);
      case 'gt':
        return Number(value) > Number(expected);
      case 'lt':
        return Number(value) < Number(expected);
      case 'between':
        if (Array.isArray(expected) && expected.length === 2) {
          const num = Number(value);
          return num >= Number(expected[0]) && num <= Number(expected[1]);
        }
        return false;
      default:
        return false;
    }
  }

  /**
   * Filter channels by user preferences
   */
  private filterByUserPreferences(
    channels: NotificationChannel[],
    prefs: UserNotificationPreferences,
    severity: AlertSeverity,
  ): NotificationChannel[] {
    return channels.filter(channel => {
      // Check if channel is enabled
      if (!prefs.enabledChannels.includes(channel)) {
        return false;
      }

      // Check channel-specific config
      const config = prefs.channelConfigs?.[channel];
      if (config) {
        if (!config.enabled) {
          return false;
        }

        // Check severity filter
        if (config.severityFilter && !config.severityFilter.includes(severity)) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Apply rate limits
   */
  private applyRateLimits(
    userId: string,
    channels: NotificationChannel[],
    prefs?: UserNotificationPreferences,
  ): NotificationChannel[] {
    const key = userId;
    const now = new Date();
    let counter = this.rateLimitCounters.get(key);

    if (!counter || this.shouldResetCounters(counter.lastReset, now)) {
      counter = { hourly: 0, daily: 0, lastReset: now };
    }

    return channels.filter(channel => {
      const config = prefs?.channelConfigs?.[channel];
      if (!config?.rateLimit) {
        return true;
      }

      if (counter!.hourly >= config.rateLimit.maxPerHour) {
        return false;
      }

      if (counter!.daily >= config.rateLimit.maxPerDay) {
        return false;
      }

      // Increment counters
      counter!.hourly++;
      counter!.daily++;
      this.rateLimitCounters.set(key, counter!);

      return true;
    });
  }

  /**
   * Check if rate limit counters should reset
   */
  private shouldResetCounters(lastReset: Date, now: Date): boolean {
    return now.getTime() - lastReset.getTime() > 60 * 60 * 1000; // 1 hour
  }

  /**
   * Check if currently in quiet hours
   */
  private isInQuietHours(quietHours: { start: string; end: string; timezone: string }): boolean {
    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    // Simple comparison - doesn't handle timezone properly in this implementation
    if (quietHours.start < quietHours.end) {
      return currentTime >= quietHours.start && currentTime <= quietHours.end;
    } else {
      // Quiet hours span midnight
      return currentTime >= quietHours.start || currentTime <= quietHours.end;
    }
  }

  /**
   * Determine primary channel
   */
  private determinePrimaryChannel(
    channels: NotificationChannel[],
    prefs?: UserNotificationPreferences,
  ): NotificationChannel {
    if (channels.length === 0) {
      return NotificationChannel.EMAIL;
    }

    // Use user's preferred channel if available
    if (prefs?.preferredChannel && channels.includes(prefs.preferredChannel)) {
      return prefs.preferredChannel;
    }

    // Otherwise, use highest priority channel
    return channels.reduce((highest, channel) => {
      return CHANNEL_PRIORITY[channel] > CHANNEL_PRIORITY[highest] ? channel : highest;
    });
  }

  /**
   * Build routing reason string
   */
  private buildRoutingReason(
    channels: NotificationChannel[],
    severity: AlertSeverity,
    prefs?: UserNotificationPreferences,
  ): string {
    const reasons: string[] = [];

    if (channels.length === 0) {
      reasons.push('No available channels');
    } else {
      reasons.push(`${channels.length} channels selected for ${severity} severity`);
    }

    if (prefs) {
      reasons.push('User preferences applied');
    }

    return reasons.join('; ');
  }

  /**
   * Initialize channel status
   */
  private initializeChannelStatus(): void {
    for (const channel of Object.values(NotificationChannel)) {
      this.channelStatus.set(channel, {
        channel,
        available: true,
        healthScore: 100,
        lastCheckAt: new Date(),
      });
    }
  }

  /**
   * Get channel priority
   */
  getChannelPriority(channel: NotificationChannel): number {
    return CHANNEL_PRIORITY[channel] || 0;
  }

  /**
   * Get recommended channels for severity
   */
  getRecommendedChannels(severity: AlertSeverity): NotificationChannel[] {
    return SEVERITY_CHANNELS[severity] || [NotificationChannel.EMAIL];
  }

  /**
   * Reset rate limit counters
   */
  resetRateLimits(userId?: string): void {
    if (userId) {
      this.rateLimitCounters.delete(userId);
    } else {
      this.rateLimitCounters.clear();
    }
  }

  /**
   * Get routing statistics
   */
  getStatistics(): Record<string, unknown> {
    return {
      usersWithPreferences: this.userPreferences.size,
      availableChannels: this.getAvailableChannels().length,
      totalChannels: this.channelStatus.size,
      routingRules: this.routingRules.size,
      rateLimitedUsers: this.rateLimitCounters.size,
    };
  }
}
