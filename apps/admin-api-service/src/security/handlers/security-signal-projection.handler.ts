import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
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
 */
@Controller()
export class SecuritySignalProjectionHandler {
  private readonly logger = new Logger(SecuritySignalProjectionHandler.name);

  constructor(
    private readonly activityLogging: ActivityLoggingService,
    private readonly monitoring: SecurityMonitoringService,
  ) {}

  @EventPattern('events.security.events.auth.login.failed')
  async onLoginFailed(@Payload() event: AuthLoginFailedEvent): Promise<void> {
    await this.project(event, false, event.reason);
  }

  @EventPattern('events.security.events.auth.login.success')
  async onLoginSuccess(@Payload() event: AuthLoginSuccessEvent): Promise<void> {
    await this.project(event, true, undefined);
  }

  /**
   * A rate-limit rejection IS the API-abuse fact `checkApiAbuse` counts.
   *
   * It was reading `admin.api_usage_logs.rateLimitExceeded`, a column nothing
   * set. Projecting only the rejections — not every request — keeps the table
   * the size of the signal rather than the size of the traffic.
   */
  @EventPattern('events.security.events.rate_limit.exceeded')
  async onRateLimitExceeded(@Payload() event: RateLimitExceededEvent): Promise<void> {
    const tenantId = this.tenantOf(event);
    try {
      await this.activityLogging.logApiUsage({
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
      });
      await this.monitoring.checkApiAbuse({
        tenantId,
        userId: event.userId,
        ipAddress: event.ip ?? 'unknown',
        endpoint: event.key,
        rateLimitExceeded: true,
      });
    } catch (error) {
      this.logger.error(
        `Failed to project rate-limit signal for key=${event.key}: ${(error as Error).message}`,
      );
    }
  }

  private async project(
    event: AuthLoginFailedEvent | AuthLoginSuccessEvent,
    success: boolean,
    failureReason: string | undefined,
  ): Promise<void> {
    const email = event.email;
    if (!email) {
      // The detectors key on email; a signal without one cannot feed them and
      // would write a row no query can find.
      this.logger.warn(`Login signal ${event.eventId} carried no email; not projected`);
      return;
    }

    const tenantId = this.tenantOf(event);
    try {
      await this.activityLogging.recordLoginAttempt({
        email,
        ipAddress: event.ip ?? 'unknown',
        success,
        failureReason,
        tenantId,
        userId: event.userId,
      });

      await this.monitoring.analyzeLoginAttempt({
        email,
        ipAddress: event.ip ?? 'unknown',
        success,
        userId: event.userId,
        tenantId,
      });
    } catch (error) {
      // A projection failure must not nak the subject into a redelivery storm;
      // the audit ledger in auth.audit_logs remains the system of record.
      this.logger.error(
        `Failed to project login signal ${event.eventId}: ${(error as Error).message}`,
      );
    }
  }

  /** `'system'` means "no tenant yet" on the wire; the admin tables want absent. */
  private tenantOf(event: { tenantId?: string }): string | undefined {
    return event.tenantId && event.tenantId !== PLATFORM_SCOPE ? event.tenantId : undefined;
  }
}
