import { Injectable, Logger } from '@nestjs/common';
import { HandlerOutcome, SubscribeTo } from '@platform/event-bus';
import { eventTenantScope, type ServiceErrorCapturedEvent } from '@platform/event-contracts';

import { ErrorSeverity } from '../entities/error-tracking.entity';
import { ErrorTrackingService } from '../services/error-tracking.service';

/** `userId` is a `uuid` column; a value that is not one must arrive as absent. */
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
  async onServiceErrorCaptured(event: ServiceErrorCapturedEvent): Promise<HandlerOutcome> {
    try {
      await this.errorTracking.reportError({
        message: event.message,
        errorType: event.errorType,
        stackTrace: event.stackTrace,
        severity: event.severity === 'critical' ? ErrorSeverity.CRITICAL : ErrorSeverity.ERROR,
        service: event.service,
        environment: event.environment,
        release: event.release,
        tenantId: this.tenantOf(event),
        userId: this.userIdOf(event),
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
      return HandlerOutcome.ack();
    } catch (error) {
      // See the class docblock: this stream is redundant by design, and a NAK
      // here would redeliver database writes into the incident that caused them.
      this.logger.warn(
        `Failed to project error capture ${event.eventId} from ${event.service}: ${
          (error as Error).message
        }`,
      );
      // The ack carries its reason, so the disposition stays out of the
      // "silently swallowed" class the bus can no longer express: it says the
      // projection failed AND that redelivering it is the wrong answer.
      return HandlerOutcome.ack(`projection failed: ${(error as Error).message}`);
    }
  }

  /**
   * The store's tenant of record, parsed through the contract (SEC-HIGH-159,
   * OBS-HIGH-009). A platform-level failure carries the one platform segment
   * (`PLATFORM_EVENT_TENANT_ID`) and is stored with no tenant — the group's
   * `affectedTenants` stays empty and the occurrence's `uuid` column NULL. A
   * value that is neither a tenant UUID nor that segment is not read as
   * "no tenant": `eventTenantScope` throws, and the catch above acks it with
   * the reason, so a second platform spelling can never become a row.
   */
  private tenantOf(event: ServiceErrorCapturedEvent): string | undefined {
    const scope = eventTenantScope(event);
    return scope.kind === 'tenant' ? scope.tenantId : undefined;
  }

  private userIdOf(event: ServiceErrorCapturedEvent): string | undefined {
    const { userId } = event;
    return userId !== undefined && UUID_RE.test(userId) ? userId : undefined;
  }
}
