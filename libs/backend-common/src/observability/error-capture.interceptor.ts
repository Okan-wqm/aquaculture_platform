import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { createBaseEvent, type ServiceErrorCapturedEvent } from '@platform/event-contracts';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { normalizeRoute } from '../metrics/route-normalizer';
import { maskPii } from '../utils/pii-mask.util';

/** Minimal publish surface — typed here so this file does not depend on the bus package. */
export interface ErrorCapturePublisher {
  publish(event: ServiceErrorCapturedEvent): Promise<void>;
}

/** Request shape the interceptor reads. Deliberately narrow. */
interface CapturedRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  tenantId?: string;
  user?: { id?: string; tenantId?: string };
  headers?: Record<string, string | string[] | undefined>;
}

const MESSAGE_MAX = 500;
const STACK_MAX = 8_000;

/** Paths whose failures are infrastructure state, not defects. */
const EXCLUDED_PREFIXES = ['/metrics', '/health'];

/** Node/undici codes that mean the client went away mid-response. */
const CLIENT_ABORT_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE']);

/**
 * ErrorCaptureInterceptor — the fleet's defects become one stream
 * (ADMIN-HIGH-014, OBS-CRITICAL-003).
 *
 * # Why an interceptor and not an exception filter
 *
 * The obvious capture point is a global `@Catch()` filter, and it is the wrong
 * one. Nest dispatches an exception to exactly ONE matching filter, so a
 * capture-only filter registered alongside a service's existing filter is
 * silently shadowed depending on registration order — and 8 of the 15 services
 * have a hand-copied filter while 7 have none at all. Making capture work as a
 * filter therefore means first consolidating 8 divergent error envelopes into
 * one, which is a public API change (`error-format.spec.ts` pins admin's shape
 * and web clients parse it) with a completely different risk profile from
 * "start recording defects".
 *
 * Capture is a cross-cutting observability concern; the error envelope is a
 * contract with clients. Coupling them means neither can move without the
 * other. An interceptor's `catchError` sees the thrown exception object and its
 * stack BEFORE any filter runs, re-throws it untouched, and composes with all
 * 15 services regardless of what each does with the response.
 *
 * # What it therefore cannot see
 *
 * Nest runs middleware and guards BEFORE interceptors, so an exception thrown
 * in a guard or in middleware never reaches this pipe. That class is almost
 * entirely 401/403 — which the exclusions below drop anyway — and every one of
 * them is still counted by `http_requests_total` and recorded by
 * `AccessLogMiddleware`. The store's contract is "defect signatures with a
 * stack trace", and this is exactly the set for which a stack trace exists.
 *
 * # Bounded by construction
 *
 * Publishing is rate-limited per process by a token bucket, because the
 * alternative is an ingest whose volume equals the fleet's 5xx rate during
 * precisely the incident that produces the most of them. During a storm the
 * useful information is the signature and the fact that it is happening a lot,
 * not the ten-thousandth copy of the same stack. Drops are counted and logged
 * rather than silent — a store that quietly stopped recording would be the
 * same class of lie this whole finding is about.
 */
export class ErrorCaptureInterceptor implements NestInterceptor {
  private readonly logger = new Logger(ErrorCaptureInterceptor.name);
  private tokens: number;
  private lastRefillMs: number;
  private droppedSinceLastReport = 0;

  constructor(
    private readonly serviceName: string,
    private readonly publisher: ErrorCapturePublisher | undefined,
    private readonly options: {
      environment?: string;
      release?: string;
      /** Sustained publishes per second. */
      ratePerSecond?: number;
      /** Burst allowance. */
      burst?: number;
      /** Injected in tests; production reads the clock. */
      now?: () => number;
    } = {},
  ) {
    this.tokens = options.burst ?? 20;
    this.lastRefillMs = this.now();
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        this.capture(context, error);
        // The exception continues to whatever filter the service registered.
        // Capture never changes what a client sees.
        return throwError(() => error);
      }),
    );
  }

  /**
   * Build and publish the event. Synchronous and total: a capture failure must
   * never turn a 500 into a different 500, and must never re-enter this path.
   */
  private capture(context: ExecutionContext, error: unknown): void {
    try {
      if (!this.publisher) {
        return;
      }
      const event = this.buildEvent(context, error);
      if (!event) {
        return;
      }
      if (!this.takeToken()) {
        this.droppedSinceLastReport += 1;
        if (this.droppedSinceLastReport % 100 === 1) {
          this.logger.warn('Error capture rate limit reached; events dropped', {
            service: this.serviceName,
            droppedSinceLastReport: this.droppedSinceLastReport,
          });
        }
        return;
      }
      this.publisher.publish(event).catch((publishError: unknown) => {
        // A bus that is down must not escalate an application error.
        this.logger.debug(
          `Error capture publish failed: ${publishError instanceof Error ? publishError.message : String(publishError)}`,
        );
      });
    } catch (captureError) {
      this.logger.debug(
        `Error capture skipped: ${captureError instanceof Error ? captureError.message : String(captureError)}`,
      );
    }
  }

  /** `null` when this failure is not a defect. */
  private buildEvent(context: ExecutionContext, error: unknown): ServiceErrorCapturedEvent | null {
    const statusCode = error instanceof HttpException ? error.getStatus() : 0;

    // 4xx is the client's input, not this service's defect. That covers every
    // ValidationPipe rejection, every 401/403 (already an AUTH_TOKEN_REJECTED
    // security event) and every 429 (already projected into
    // admin.api_usage_logs from events.security.events.rate_limit.exceeded —
    // capturing it here would double-count one fact into two admin tables).
    if (statusCode > 0 && statusCode < 500) {
      return null;
    }

    // 503 is a shutdown, a circuit breaker or a dependency being out: real
    // operational state, correctly alerted on by the RED rules, and the
    // highest-volume noise class during exactly the incident you want readable.
    if (statusCode === 503) {
      return null;
    }

    if (this.isClientAbort(error)) {
      return null;
    }

    const transport = context.getType<'http' | 'rpc'>();
    const request =
      transport === 'http' ? context.switchToHttp().getRequest<CapturedRequest>() : undefined;

    if (request && this.isExcludedPath(this.pathOf(request))) {
      return null;
    }

    const cause = error instanceof Error ? error : new Error(String(error));
    const tenantId = this.tenantOf(request);

    return {
      ...createBaseEvent<ServiceErrorCapturedEvent>('ServiceErrorCaptured', tenantId, {
        userId: request?.user?.id,
        correlationId: this.headerOf(request, 'x-request-id'),
        aggregateId: this.serviceName,
        aggregateType: 'Service',
      }),
      eventType: 'ServiceErrorCaptured',
      message: truncate(maskPii(cause.message || 'Unknown error'), MESSAGE_MAX),
      errorType: cause.name || cause.constructor.name,
      stackTrace: cause.stack ? truncate(maskPii(cause.stack), STACK_MAX) : undefined,
      service: this.serviceName,
      environment: this.options.environment,
      release: this.options.release,
      severity: statusCode === 0 ? 'critical' : 'error',
      statusCode,
      transport: transport === 'rpc' ? 'rpc' : 'http',
      httpMethod: request?.method,
      httpRoute: request ? normalizeRoute(this.pathOf(request)) : undefined,
      rpcPattern: transport === 'rpc' ? String(context.getHandler().name) : undefined,
    };
  }

  private takeToken(): boolean {
    const now = this.now();
    const rate = this.options.ratePerSecond ?? 5;
    const burst = this.options.burst ?? 20;
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(burst, this.tokens + elapsedSeconds * rate);
      this.lastRefillMs = now;
    }
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  private now(): number {
    const clock = this.options.now;
    return clock ? clock() : Date.now();
  }

  private isClientAbort(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' && CLIENT_ABORT_CODES.has(code);
  }

  private isExcludedPath(path: string): boolean {
    return EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix));
  }

  private pathOf(request: CapturedRequest): string {
    const raw = request.originalUrl ?? request.url ?? '/';
    const queryStart = raw.indexOf('?');
    return queryStart === -1 ? raw : raw.slice(0, queryStart);
  }

  /**
   * `createBaseEvent` routes on tenantId, and a platform-level failure belongs
   * to no tenant. An empty string makes the bus derive the `events.system.*`
   * subject, the same convention every other tenant-less fact uses.
   */
  private tenantOf(request: CapturedRequest | undefined): string {
    if (!request) {
      return '';
    }
    return request.tenantId ?? request.user?.tenantId ?? '';
  }

  private headerOf(request: CapturedRequest | undefined, name: string): string | undefined {
    const value = request?.headers?.[name];
    if (typeof value === 'string') {
      return value;
    }
    return Array.isArray(value) ? value[0] : undefined;
  }
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) {
    return value;
  }
  const marker = '…<truncated>';
  return `${value.slice(0, maxLen - marker.length)}${marker}`;
}
