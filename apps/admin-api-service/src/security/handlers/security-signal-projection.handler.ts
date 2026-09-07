import { Injectable, Logger } from '@nestjs/common';
import { SubscribeTo } from '@platform/event-bus';
import type {
  AuthLoginFailedEvent,
  AuthLoginSuccessEvent,
  RateLimitExceededEvent,
} from '@platform/event-contracts';

import { ActivityLoggingService } from '../services/activity-logging.service';
import { SecurityMonitoringService } from '../services/security-monitoring.service';

/** The tenant id auth-service stamps on a fact that belongs to no tenant yet. */
const PLATFORM_SCOPE = 'system';

/**
 * The sink for the security signal (ADMIN-HIGH-014, ADR-0018).
 *
 * `admin.login_attempts` and `admin.api_usage_logs` had readers and no writer.
 * Five anomaly detectors counted rows in them — brute force by email, brute
 * force by IP, credential stuffing, geo anomaly, off-hours — and every count
 * was 0, so no threshold was ever reachable and the security health score
 * returned a perfect 100 by construction.
 *
 * The projection is deliberately thin. `ActivityLoggingService.recordLoginAttempt`
 * already wrote the row and its paired activity-log entry; it simply had no
 * caller. `SecurityMonitoringService.analyzeLoginAttempt` already ran the five
 * detectors; its only entry point was a SUPER_ADMIN pressing a button
 * (`POST /security/monitoring/analyze/login`), which is not how an attack
 * announces itself. Both are now driven by the stream that carries the fact.
 *
 * Ordering matters: the row is written BEFORE the analysis runs, because the
 * detectors count rows including this one. Analysing first would make every
 * threshold off by one and the fifth failed login look like the fourth.
 *
 * # Why @SubscribeTo and not @EventPattern
 *
 * This class was first written with `@EventPattern`, which binds through a Nest
 * microservice transport. admin-api's `bootstrapService` call declares no
 * `natsTransport`, so no NATS server strategy is ever attached and every
 * `@EventPattern` in this service binds to nothing — silently. The projection
 * shipped, the waivers were retired, and not one row was written.
 * `@SubscribeTo` binds through `EventHandlerRegistryModule`, which is
 * fail-closed: a subscription it cannot register stops the boot.
 * `tests/invariants/nats-inbound-binding.spec.ts` makes the mismatch a CI
 * failure so it cannot return.
 *
 * # Why a failure re-raises
 *
 * A JetStream delivery that throws is NAK'd and redelivered with backoff, so a
 * transient database error costs a retry instead of a security fact. That is
 * only safe because the write is idempotent on the source event id (migration
 * `1809300000000`): the second delivery of an event whose row is already stored
 * is dropped by a partial unique index, and the detectors are not re-run over a
 * row that is already counted.
 */
@Injectable()
export class SecuritySignalProjectionHandler {
  private readonly logger = new Logger(SecuritySignalProjectionHandler.name);

  constructor(
    private readonly activityLogging: ActivityLoggingService,
    private readonly monitoring: SecurityMonitoringService,
  ) {}

  @SubscribeTo({
    topic: 'events.security.events.auth.login.failed',
    durable: true,
    startFrom: 'latest',
  })
  async onLoginFailed(event: AuthLoginFailedEvent): Promise<void> {
    await this.project(event, false, event.reason);
  }

  @SubscribeTo({
    topic: 'events.security.events.auth.login.success',
    durable: true,
    startFrom: 'latest',
  })
  async onLoginSuccess(event: AuthLoginSuccessEvent): Promise<void> {
    await this.project(event, true, undefined);
  }

  /**
   * A rate-limit rejection IS the API-abuse fact `checkApiAbuse` counts.
   *
   * It was reading `admin.api_usage_logs.rateLimitExceeded`, a column nothing
   * set. Projecting only the rejections — not every request — keeps the table
   * the size of the signal rather than the size of the traffic.
   */
  @SubscribeTo({
    topic: 'events.security.events.rate_limit.exceeded',
    durable: true,
    startFrom: 'latest',
  })
  async onRateLimitExceeded(event: RateLimitExceededEvent): Promise<void> {
    const tenantId = this.tenantOf(event);
    const written = await this.activityLogging.logApiUsage({
      // The rate-limit key is the only route identity the signal carries;
      // it is neither an HTTP method nor a path, and inventing either would
      // put a fiction in a table an operator reads.
      method: 'UNKNOWN',
      endpoint: event.key,
      path: event.key,
      statusCode: 429,
      responseTimeMs: 0,
      ipAddress: event.ip ?? 'unknown',
      userAgent: event.userAgent,
      rateLimitExceeded: true,
      tenantId,
      userId: event.userId,
      correlationId: event.correlationId,
      sourceEventId: event.eventId,
    });

    if (!written) {
      this.logger.debug(`Rate-limit signal ${event.eventId} already projected; skipping analysis`);
      return;
    }

    await this.monitoring.checkApiAbuse({
      tenantId,
      userId: event.userId,
      ipAddress: event.ip ?? 'unknown',
      endpoint: event.key,
      rateLimitExceeded: true,
    });
  }

  private async project(
    event: AuthLoginFailedEvent | AuthLoginSuccessEvent,
    success: boolean,
    failureReason: string | undefined,
  ): Promise<void> {
    const email = event.email;
    if (!email) {
      // The detectors key on email; a signal without one cannot feed them and
      // would write a row no query can find. Nothing to retry, so it is acked.
      this.logger.warn(`Login signal ${event.eventId} carried no email; not projected`);
      return;
    }

    const tenantId = this.tenantOf(event);
    const stored = await this.activityLogging.recordLoginAttempt({
      email,
      ipAddress: event.ip ?? 'unknown',
      success,
      failureReason,
      tenantId,
      userId: event.userId,
      sourceEventId: event.eventId,
    });

    if (!stored) {
      this.logger.debug(`Login signal ${event.eventId} already projected; skipping analysis`);
      return;
    }

    await this.monitoring.analyzeLoginAttempt({
      email,
      ipAddress: event.ip ?? 'unknown',
      success,
      userId: event.userId,
      tenantId,
    });
  }

  /** `'system'` means "no tenant yet" on the wire; the admin tables want absent. */
  private tenantOf(event: { tenantId?: string }): string | undefined {
    return event.tenantId && event.tenantId !== PLATFORM_SCOPE ? event.tenantId : undefined;
  }
}
