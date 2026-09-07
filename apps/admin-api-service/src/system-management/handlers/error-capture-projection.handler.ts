import { Injectable, Logger } from '@nestjs/common';
import { SubscribeTo } from '@platform/event-bus';
import type { ServiceErrorCapturedEvent } from '@platform/event-contracts';

import { ErrorSeverity } from '../entities/error-tracking.entity';
import { ErrorTrackingService } from '../services/error-tracking.service';

/** A tenant-less platform failure travels with an empty tenant segment. */
const NO_TENANT = '';

/** `uuid` columns; anything that is not one must arrive as absent, not as ''. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The sink for `events.*.ServiceErrorCaptured` (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * `admin.error_groups` and `admin.error_occurrences` had a reader — the
 * ErrorTrackingPage, its dashboard, its group and occurrence endpoints, a
 * 1,000-line service behind them — and no writer. The only entry point to
 * `reportError` was `POST /system/errors/report`, behind `PlatformAdminGuard`
 * and `@RequiresCapability('security-ops')`: a crashing service cannot
 * authenticate as a platform admin, so that route could never have been the
 * ingress and never once was called. Every service now publishes its defects
 * and this handler folds them in.
 *
 * # Why a failure acks instead of NAKing
 *
 * The sibling projection on this stream's security events re-raises, because a
 * failed-login row that is never written is a detection gap in a threshold the
 * platform depends on. This data is the opposite: `http_requests_total` already
 * counted the 5xx, the group almost certainly already exists, and the same
 * defect will produce another event within seconds. NAKing instead would mean
 * redelivering database writes during a database-caused error storm — the
 * amplification loop `reportError`'s own rule cache was just fixed to break.
 *
 * Acking on failure is also what keeps this handler free of an idempotency key:
 * no NAK means no redelivery, so no duplicate occurrence can inflate a windowed
 * alert threshold. That is a deliberate pairing, not an omission.
 */
@Injectable()
export class ErrorCaptureProjectionHandler {
  private readonly logger = new Logger(ErrorCaptureProjectionHandler.name);

  constructor(private readonly errorTracking: ErrorTrackingService) {}

  @SubscribeTo({
    topic: 'events.*.ServiceErrorCaptured',
    durable: true,
    startFrom: 'latest',
  })
  async onServiceErrorCaptured(event: ServiceErrorCapturedEvent): Promise<void> {
    try {
      await this.errorTracking.reportError({
        message: event.message,
        errorType: event.errorType,
        stackTrace: event.stackTrace,
        severity: event.severity === 'critical' ? ErrorSeverity.CRITICAL : ErrorSeverity.ERROR,
        service: event.service,
        environment: event.environment,
        release: event.release,
        tenantId: this.uuidOrUndefined(event.tenantId),
        userId: this.uuidOrUndefined(event.userId),
        context: {
          request:
            event.httpMethod && event.httpRoute
              ? { method: event.httpMethod, url: event.httpRoute }
              : undefined,
          response: event.statusCode > 0 ? { statusCode: event.statusCode } : undefined,
          tags: {
            transport: event.transport,
            ...(event.rpcPattern ? { rpcPattern: event.rpcPattern } : {}),
          },
        },
        metadata: {
          sourceEventId: event.eventId,
          correlationId: event.correlationId,
        },
      });
    } catch (error) {
      // See the class docblock: this stream is redundant by design, and a NAK
      // here would redeliver database writes into the incident that caused them.
      this.logger.warn(
        `Failed to project error capture ${event.eventId} from ${event.service}: ${
          (error as Error).message
        }`,
      );
    }
  }

  /**
   * The wire carries `''` for "no tenant" so the bus derives the
   * `events.system.*` subject; the columns are `uuid`, where `''` is a type
   * error rather than an absence.
   */
  private uuidOrUndefined(value: string | undefined): string | undefined {
    if (!value || value === NO_TENANT || !UUID_RE.test(value)) {
      return undefined;
    }
    return value;
  }
}
