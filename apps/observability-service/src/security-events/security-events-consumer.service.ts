import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { NatsEventBus } from '@platform/event-bus';
import type { SecurityEvent } from '@platform/event-contracts';
import { SecurityMetricsService } from './security-metrics.service';

/**
 * SecurityEventsConsumerService
 *
 * Subscribes to all NATS `security.events.>` subjects (normalized to
 * `events.security.events.>` by the event bus) and:
 *   1. Logs every event in structured JSON for log aggregation.
 *   2. Increments Prometheus counter metrics per event type.
 */
@Injectable()
export class SecurityEventsConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SecurityEventsConsumerService.name);

  constructor(
    private readonly eventBus: NatsEventBus,
    private readonly securityMetrics: SecurityMetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Subscribe to ALL security events using NATS wildcard.
      // The event bus normalizeSubject will prepend `events.` if necessary;
      // we use the already-normalized form because publishTo normalizes too.
      await this.eventBus.subscribeTo(
        'events.security.events.>',
        {
          handle: async (event: SecurityEvent) => {
            await this.handleSecurityEvent(event);
          },
          getEventType: () => 'security.events.>',
        },
        {
          durable: true,
          groupId: 'observability-security',
          startFrom: 'latest',
        },
      );

      this.logger.log('Subscribed to security events (events.security.events.>)');
    } catch (error) {
      this.logger.warn(
        `Failed to subscribe to security events: ${(error as Error).message}. ` +
        'Security event consumption will be unavailable until NATS reconnects.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.eventBus.unsubscribeFrom('events.security.events.>');
    } catch (error) {
      this.logger.warn(`Error unsubscribing from security events: ${(error as Error).message}`);
    }
  }

  /**
   * Handle an incoming security event: log + metric.
   */
  private async handleSecurityEvent(event: SecurityEvent): Promise<void> {
    const eventType = event.securityEventType ?? event.eventType ?? 'unknown';
    const shortType = this.toShortLabel(eventType);

    // Structured log entry for log aggregation (ELK, Loki, etc.)
    // All fields are flat at the top level — no nested details bag.
    this.logger.warn('Security event received', {
      securityEventType: eventType,
      eventId: event.eventId,
      tenantId: event.tenantId,
      userId: event.userId,
      ip: event.ip,
      userAgent: event.userAgent,
      timestamp: event.timestamp,
    });

    // Increment Prometheus counter
    this.securityMetrics.incrementSecurityEvent(shortType);
  }

  /**
   * Convert a full SecurityEventType value (e.g. `security.events.auth.login.failed`)
   * to a short Prometheus label (e.g. `auth.login.failed`).
   */
  private toShortLabel(eventType: string): string {
    return eventType.replace(/^security\.events\./, '');
  }
}
