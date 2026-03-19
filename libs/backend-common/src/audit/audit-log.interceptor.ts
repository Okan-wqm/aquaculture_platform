import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  Optional,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

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
 * Behaviour:
 * - Runs AFTER the handler completes (in the `tap` of the response observable)
 * - Reads AUDIT_LOG_KEY metadata from the handler via Reflector
 * - Extracts user info (userId, email, tenantId) from req.user
 * - Extracts IP and User-Agent from the request
 * - Publishes to NATS `events.audit.*` topic if NatsEventBus is available
 * - Stores in database via AuditLogService
 * - Fire-and-forget: NEVER blocks or slows the response
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
      tap({
        next: (result: unknown) => {
          // Fire-and-forget: persist audit log after successful response
          this.recordAuditLog(auditOptions, requestContext, args, result);
        },
        error: (error: Error) => {
          // Also log failed operations with ERROR severity
          this.recordAuditLog(
            auditOptions,
            requestContext,
            args,
            null,
            error,
          );
        },
      }),
    );
  }

  /**
   * Persist audit log entry. This method NEVER throws —
   * all errors are caught and logged.
   */
  private recordAuditLog(
    options: AuditLogOptions,
    requestCtx: RequestContext,
    args: Record<string, unknown> | null,
    result: unknown,
    error?: Error,
  ): void {
    try {
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

      // 1. Persist to database (fire-and-forget)
      this.auditLogService.record({
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

      // 2. Publish to NATS (fire-and-forget, if available)
      this.publishToEventBus(options, requestCtx, resourceId, metadata, error);
    } catch (err) {
      // Last resort: never let audit logging crash the application
      this.logger.error(
        `Audit log recording failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
      eventId: crypto.randomUUID(),
      eventType: `audit.${options.action.toLowerCase()}`,
      timestamp: new Date(),
      tenantId: requestCtx.tenantId ?? undefined,
      userId: requestCtx.userId ?? undefined,
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
