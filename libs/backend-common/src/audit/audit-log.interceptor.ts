import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  InternalServerErrorException,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Observable, from, throwError } from 'rxjs';
import { switchMap, catchError } from 'rxjs/operators';

import { createBaseEvent } from '@platform/event-contracts';

import { AUDIT_LOG_KEY, AuditLogOptions } from '../decorators/audit-log.decorator';
import { AuditLogService } from './audit-log.service';
import { AuditSeverity } from './audit-log.entity';

/**
 * Keys that must never appear in audit log metadata.
 * Prevents accidental leakage of secrets into the audit trail.
 */
const SENSITIVE_KEYS = new Set([
  'password',
  'token',
  'secret',
  'accessToken',
  'refreshToken',
  'authorization',
  'creditCard',
  'ssn',
  'cvv',
  'pin',
]);

/**
 * Maximum depth for sanitizing nested objects
 */
const MAX_SANITIZE_DEPTH = 3;

/**
 * AuditLogInterceptor
 *
 * NestJS interceptor that automatically captures audit trail entries
 * for any handler decorated with @AuditLog().
 *
 * # Behaviour (post-AUDITTRAIL-HIGH-002 + HIGH-006 cure)
 *
 * - Runs AFTER the handler completes via `switchMap` so the response
 *   stream WAITS for the audit-row write to commit.
 * - Reads AUDIT_LOG_KEY metadata from the handler via Reflector.
 * - Extracts user info (userId, email, tenantId) from req.user.
 * - Extracts IP and User-Agent from the request.
 * - Publishes to NATS `events.audit.*` topic if NatsEventBus is
 *   available (event-bus emit stays fire-and-forget — it is a
 *   downstream observability signal, not a primary audit channel).
 * - Stores in database via AuditLogService.recordAwait — failures
 *   propagate as InternalServerErrorException so the consumer sees
 *   the audit-write failure rather than silently dropping evidence.
 *
 * # Why this changed (was fire-and-forget, now fail-closed)
 *
 * Pre-fix this interceptor used `tap({ next })` and
 * `auditLogService.record(...)` (fire-and-forget). On a process
 * crash between handler-return and worker-flush, the audit row was
 * lost. RxJS `tap` does not wait for promises, so even
 * `recordAwait` would have raced the response stream. The
 * architectural successor `AuditedOperationInterceptor` already
 * uses `switchMap → from(promise) → switchMap(() => [result])` to
 * block emission until the audit write resolves; this interceptor
 * now matches that contract end-to-end, closing AUDITTRAIL-HIGH-002
 * and AUDITTRAIL-HIGH-006 in a single architectural cure.
 *
 * Supports both HTTP and GraphQL execution contexts.
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditLogService: AuditLogService,
    @Optional()
    @Inject('EVENT_BUS')
    private readonly eventBus?: { publish: (event: unknown) => Promise<void>; isConnected: () => boolean } | null,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Read @AuditLog() metadata — if absent, skip audit logging entirely
    const auditOptions = this.reflector.get<AuditLogOptions | undefined>(
      AUDIT_LOG_KEY,
      context.getHandler(),
    );

    if (!auditOptions) {
      return next.handle();
    }

    // Extract request context before handler runs
    const requestContext = this.extractRequestContext(context);
    const args = this.extractArgs(context);

    return next.handle().pipe(
      // ── Success path ──
      // switchMap blocks emission until the audit-row write resolves.
      // Pre-cure this used `tap` which does NOT await promises — the
      // response stream completed before the audit row hit the DB,
      // and on crash between the two the row was lost.
      switchMap((result: unknown) =>
        from(
          this.recordAuditLog(auditOptions, requestContext, args, result),
        ).pipe(switchMap(() => [result])),
      ),
      // ── Failure path ──
      // Handler threw. We still write a FAILED audit row, then
      // re-throw the original handler error.
      catchError((handlerError: Error) =>
        from(
          this.recordAuditLog(
            auditOptions,
            requestContext,
            args,
            null,
            handlerError,
          ),
        ).pipe(
          switchMap(() => throwError(() => handlerError)),
          // If audit write ALSO fails, throw an InternalServerError
          // wrapping both so the operator sees both the original
          // handler error AND the audit failure.
          catchError((auditWriteError: Error) => {
            this.logger.error(
              `AUDIT_WRITE_FAILURE: Could not persist FAILED audit ` +
                `entry for ${auditOptions.action} on ${auditOptions.resource}. ` +
                `Original error: ${handlerError.message}. ` +
                `Audit error: ${auditWriteError.message}`,
            );
            return throwError(
              () =>
                new InternalServerErrorException(
                  `Operation failed and audit trail could not be ` +
                    `written. Original: ${handlerError.message}`,
                ),
            );
          }),
        ),
      ),
      // ── Audit write failure on SUCCESS path ──
      // The first switchMap above can fail if recordAuditLog rejects
      // on a successful handler. We catch that here and surface as
      // InternalServerError — the operation has been aborted for
      // compliance per the same posture AuditedOperationInterceptor
      // applies.
      catchError((error: Error) => {
        if (error instanceof InternalServerErrorException) {
          return throwError(() => error);
        }
        this.logger.error(
          `AUDIT_WRITE_FAILURE: Could not persist SUCCESS audit ` +
            `entry for ${auditOptions.action} on ${auditOptions.resource}. ` +
            `Error: ${error.message}`,
        );
        return throwError(
          () =>
            new InternalServerErrorException(
              'Operation succeeded but audit trail could not be ' +
                'written. The operation has been aborted for compliance.',
            ),
        );
      }),
    );
  }

  /**
   * Persist audit log entry.
   *
   * # Why this method now AWAITS the DB write (was fire-and-forget)
   *
   * Pre-cure this method called `auditLogService.record()`
   * (fire-and-forget) wrapped in a try/catch that swallowed every
   * error to a logger.error line. The combined effect: the audit row
   * could fail to land in the DB and the handler's response would
   * already be on the wire to the client. SOC 2 CC4 evidence
   * silently lost on every DB blip.
   *
   * Cure (AUDITTRAIL-HIGH-002 + HIGH-006): use `recordAwait` and let
   * failures propagate. Callers (the `intercept` switchMap above)
   * convert a rejection into an InternalServerErrorException so the
   * operation aborts for compliance — same posture as the canonical
   * AuditedOperationInterceptor.
   *
   * The NATS event-bus emission stays fire-and-forget because the
   * event bus is a downstream observability signal, not a primary
   * audit channel — losing a NATS event must not abort the
   * operation. If event-bus delivery is critical for a particular
   * consumer, that consumer should subscribe to the audit-row table
   * via outbox / CDC, not depend on the volatile `events.audit.*`
   * stream.
   *
   * @throws Error — propagates DB write failure to the caller; the
   *   intercept() switchMap chain wraps it into
   *   InternalServerErrorException for the client.
   */
  private async recordAuditLog(
    options: AuditLogOptions,
    requestCtx: RequestContext,
    args: Record<string, unknown> | null,
    result: unknown,
    error?: Error,
  ): Promise<void> {
    const resourceId = this.extractResourceId(result);
    const sanitizedArgs = args ? this.sanitizeObject(args) : null;

    const metadata: Record<string, unknown> = {};
    if (options.description) {
      metadata['description'] = options.description;
    }
    if (sanitizedArgs && Object.keys(sanitizedArgs).length > 0) {
      metadata['args'] = sanitizedArgs;
    }
    if (resourceId) {
      metadata['resourceId'] = resourceId;
    }
    if (error) {
      metadata['error'] = error.message;
    }

    // 1. Persist to database — AWAITED. A rejection bubbles up to
    //    the intercept() chain which surfaces it as a 5xx.
    await this.auditLogService.recordAwait({
      action: options.action,
      resource: options.resource,
      resourceId,
      userId: requestCtx.userId,
      userEmail: requestCtx.userEmail,
      tenantId: requestCtx.tenantId,
      schemaName: requestCtx.schemaName,
      metadata: Object.keys(metadata).length > 0 ? metadata : null,
      ip: requestCtx.ip,
      userAgent: requestCtx.userAgent,
      severity: error ? AuditSeverity.ERROR : AuditSeverity.INFO,
      correlationId: requestCtx.correlationId,
    });

    // 2. Publish to NATS (fire-and-forget — observability signal,
    //    not a primary audit channel; loss must not abort the op).
    this.publishToEventBus(options, requestCtx, resourceId, metadata, error);
  }

  /**
   * Publish audit event to NATS event bus if available.
   * Completely fire-and-forget.
   */
  private publishToEventBus(
    options: AuditLogOptions,
    requestCtx: RequestContext,
    resourceId: string | null,
    metadata: Record<string, unknown>,
    error?: Error,
  ): void {
    if (!this.eventBus || typeof this.eventBus.isConnected !== 'function' || !this.eventBus.isConnected()) {
      return;
    }

    const event = {
      ...createBaseEvent(`audit.${options.action.toLowerCase()}`, requestCtx.tenantId ?? '', { userId: requestCtx.userId ?? undefined }),
      metadata: {
        action: options.action,
        resource: options.resource,
        resourceId,
        userEmail: requestCtx.userEmail,
        ip: requestCtx.ip,
        severity: error ? 'error' : 'info',
        ...metadata,
      },
    };

    this.eventBus.publish(event).catch((err: Error) => {
      this.logger.debug(
        `Failed to publish audit event to NATS: ${err.message}`,
      );
    });
  }

  /**
   * Extract request context from the execution context.
   * Supports both HTTP and GraphQL contexts.
   */
  private extractRequestContext(context: ExecutionContext): RequestContext {
    const contextType = context.getType<string>();
    let request: RequestLike;

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      request = gqlCtx.getContext().req as RequestLike;
    } else {
      request = context.switchToHttp().getRequest<RequestLike>();
    }

    const user = request?.user;
    const headers = request?.headers ?? {};

    return {
      userId: user?.sub ?? user?.id ?? null,
      userEmail: user?.email ?? null,
      tenantId: user?.tenantId ?? (headers['x-tenant-id'] as string) ?? null,
      schemaName: (headers['x-schema-name'] as string) ?? null,
      ip: this.extractIp(request),
      userAgent: (headers['user-agent'] as string) ?? null,
      correlationId: (headers['x-correlation-id'] as string) ?? null,
    };
  }

  /**
   * Extract GraphQL/REST arguments for metadata
   */
  private extractArgs(context: ExecutionContext): Record<string, unknown> | null {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const gqlArgs = gqlCtx.getArgs<Record<string, unknown>>();
      return gqlArgs && Object.keys(gqlArgs).length > 0 ? gqlArgs : null;
    }

    // For REST, capture body
    const request = context.switchToHttp().getRequest<RequestLike>();
    const body = request?.body as Record<string, unknown> | undefined;
    return body && Object.keys(body).length > 0 ? body : null;
  }

  /**
   * Extract the resource ID from the handler result.
   * Looks for common patterns: result.id, result.data.id, or string/number result.
   */
  private extractResourceId(result: unknown): string | null {
    if (result === null || result === undefined) {
      return null;
    }

    // Direct string/number (e.g. mutation returning just an ID)
    if (typeof result === 'string') {
      return result;
    }
    if (typeof result === 'number') {
      return String(result);
    }

    // Object with .id property
    if (typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      if (typeof obj['id'] === 'string') {
        return obj['id'];
      }
      if (typeof obj['id'] === 'number') {
        return String(obj['id']);
      }
    }

    return null;
  }

  /**
   * Extract client IP from the request.
   * Considers X-Forwarded-For for proxied requests.
   */
  private extractIp(request: RequestLike | undefined): string | null {
    if (!request) return null;

    const forwarded = request.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string') {
      // X-Forwarded-For can contain comma-separated IPs; take the first
      return forwarded.split(',')[0]?.trim() ?? null;
    }

    return request.ip ?? null;
  }

  /**
   * Sanitize an object by removing sensitive keys and truncating deep nesting.
   * Prevents passwords, tokens, and other secrets from appearing in audit logs.
   */
  private sanitizeObject(
    obj: Record<string, unknown>,
    depth = 0,
  ): Record<string, unknown> {
    if (depth >= MAX_SANITIZE_DEPTH) {
      return { _truncated: true };
    }

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      // Skip sensitive keys
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = '[REDACTED]';
        continue;
      }

      if (value === null || value === undefined) {
        result[key] = value;
      } else if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
        result[key] = this.sanitizeObject(
          value as Record<string, unknown>,
          depth + 1,
        );
      } else if (Array.isArray(value)) {
        // Limit arrays to first 10 items
        result[key] = value.slice(0, 10);
      } else {
        result[key] = value;
      }
    }

    return result;
  }
}

/**
 * Minimal request shape for extracting audit context.
 * Avoids tight coupling to Express/Fastify types.
 */
interface RequestLike {
  user?: {
    sub?: string;
    id?: string;
    email?: string;
    tenantId?: string | null;
    [key: string]: unknown;
  };
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string;
}

/**
 * Extracted request context for audit logging
 */
interface RequestContext {
  userId: string | null;
  userEmail: string | null;
  tenantId: string | null;
  schemaName: string | null;
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
}
