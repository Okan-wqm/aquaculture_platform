import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { trace, context } from '@opentelemetry/api';
import { TenantRequest as CanonicalTenantRequest } from '../types/tenant-request.interface';

/**
 * User payload from JWT (forwarded by gateway)
 */
export interface UserPayload {
  sub: string;
  email: string;
  tenantId: string;
  role?: string;
  roles?: string[];
  modules?: string[];
  firstName?: string;
  lastName?: string;
  iat?: number;
  exp?: number;
}

/**
 * Extended Request with tenant context and user.
 * Extends the canonical TenantRequest (libs/backend-common/src/types/tenant-request.interface.ts)
 * with the additional `tenantContext` field populated by TenantContextMiddleware.
 *
 * NOTE: The base `TenantRequest` type is exported from the canonical location
 * `@platform/backend-common` (via `types/tenant-request.interface.ts`).
 * This extended interface is local to the middleware module and does not conflict.
 */
export interface TenantRequest extends CanonicalTenantRequest {
  tenantContext?: TenantContext;
  user?: UserPayload;
}

/**
 * Tenant Context information
 */
export interface TenantContext {
  tenantId: string;
  source: 'header' | 'jwt' | 'query' | 'subdomain';
}

/**
 * User Context Middleware
 * Extracts user payload from gateway header (x-user-payload)
 * Must run BEFORE TenantContextMiddleware
 */
@Injectable()
export class UserContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UserContextMiddleware.name);

  use(req: TenantRequest, res: Response, next: NextFunction): void {
    const userPayloadHeader = req.headers['x-user-payload'] as string;

    if (userPayloadHeader) {
      try {
        const user = JSON.parse(userPayloadHeader) as UserPayload;
        req.user = user;
        this.logger.debug(
          `User context set: ${user.email} (tenant: ${user.tenantId})`,
        );
      } catch (error) {
        this.logger.warn(`Failed to parse x-user-payload header: ${error}`);
      }
    }

    next();
  }
}

/**
 * Tenant Context Middleware
 * Extracts and attaches tenant context to requests
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  use(req: TenantRequest, res: Response, next: NextFunction): void {
    const tenantContext = this.extractTenantContext(req);

    if (tenantContext) {
      req.tenantId = tenantContext.tenantId;
      req.tenantContext = tenantContext;
      this.logger.debug(
        `Tenant context set: ${tenantContext.tenantId} (source: ${tenantContext.source})`,
      );
    }

    next();
  }

  private extractTenantContext(req: TenantRequest): TenantContext | null {
    // 1. Try from header
    const headerTenant = req.headers['x-tenant-id'] as string;
    if (headerTenant) {
      return { tenantId: headerTenant, source: 'header' };
    }

    // 2. Try from JWT (if already decoded by auth middleware)
    if (req.user?.tenantId) {
      return { tenantId: req.user.tenantId, source: 'jwt' };
    }

    // 3. Try from query parameter
    const queryTenant = req.query['tenantId'] as string;
    if (queryTenant) {
      return { tenantId: queryTenant, source: 'query' };
    }

    // 4. Try from subdomain (e.g., tenant1.api.example.com)
    const host = req.hostname;

    // Skip IP addresses (IPv4 and localhost)
    if (this.isIPAddress(host)) {
      return null;
    }

    const parts = host.split('.');
    if (parts.length >= 3) {
      const subdomain = parts[0];
      // Exclude common prefixes and validate UUID format for subdomain-based tenant IDs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (subdomain && !['www', 'api', 'app', 'admin', 'localhost'].includes(subdomain) && uuidRegex.test(subdomain)) {
        return { tenantId: subdomain, source: 'subdomain' };
      }
    }

    return null;
  }

  /**
   * Check if host is an IP address (IPv4)
   */
  private isIPAddress(host: string): boolean {
    // IPv4 pattern: 4 parts, all numeric
    const parts = host.split('.');
    if (parts.length === 4) {
      return parts.every(part => /^\d+$/.test(part));
    }
    // IPv6 or localhost
    if (host.includes(':') || host === 'localhost') {
      return true;
    }
    return false;
  }
}

/**
 * Trace Context interface for distributed tracing
 */
export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  correlationId: string;
  sampled: boolean;
}

/**
 * Extended Request with trace context
 */
export interface TracedRequest extends Request {
  traceContext?: TraceContext;
}

/**
 * Correlation ID Middleware
 * Ensures every request has correlation ID and trace context for distributed tracing
 * Supports W3C Trace Context standard (traceparent header)
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CorrelationIdMiddleware.name);

  use(req: TracedRequest, res: Response, next: NextFunction): void {
    // Handle correlation ID
    let correlationId = req.headers['x-correlation-id'] as string;
    if (!correlationId) {
      correlationId = crypto.randomUUID();
      req.headers['x-correlation-id'] = correlationId;
    }

    // Try to read trace context from OpenTelemetry SDK first (if active)
    // This avoids generating duplicate trace IDs when OTel is enabled
    const activeSpan = trace.getSpan(context.active());
    let traceId: string;
    let spanId: string;
    let parentSpanId: string | undefined;
    let sampled = true;

    if (activeSpan) {
      // Use OTel's trace context as the single source of truth
      const spanContext = activeSpan.spanContext();
      traceId = spanContext.traceId;
      spanId = spanContext.spanId;
      sampled = (spanContext.traceFlags & 0x01) === 1;
    } else {
      // No OTel context - fall back to W3C traceparent header parsing
      const traceparent = req.headers['traceparent'] as string;

      if (traceparent) {
        const parts = traceparent.split('-');
        if (parts.length >= 4) {
          traceId = parts[1] || this.generateTraceId();
          parentSpanId = parts[2];
          spanId = this.generateSpanId(); // Generate new span for this service
          sampled = parts[3] ? (parseInt(parts[3], 16) & 0x01) === 1 : true;
        } else {
          traceId = this.generateTraceId();
          spanId = this.generateSpanId();
        }
      } else {
        // No trace context at all - generate new
        traceId = this.generateTraceId();
        spanId = this.generateSpanId();
      }
    }

    // Set trace context on request
    const traceContext: TraceContext = {
      traceId,
      spanId,
      parentSpanId,
      correlationId,
      sampled,
    };
    req.traceContext = traceContext;

    // Set headers for downstream propagation
    req.headers['x-trace-id'] = traceId;
    req.headers['x-span-id'] = spanId;
    if (parentSpanId) {
      req.headers['x-parent-span-id'] = parentSpanId;
    }

    // Generate traceparent for forwarding to other services
    const newTraceparent = `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
    req.headers['traceparent'] = newTraceparent;

    // Add to response headers for client tracking and debugging
    res.setHeader('x-correlation-id', correlationId);
    res.setHeader('x-trace-id', traceId);
    res.setHeader('x-span-id', spanId);
    res.setHeader('traceparent', newTraceparent);

    next();
  }

  /**
   * Generate a 32-character trace ID (128 bits in hex)
   */
  private generateTraceId(): string {
    return crypto.randomUUID().replace(/-/g, '');
  }

  /**
   * Generate a 16-character span ID (64 bits in hex)
   */
  private generateSpanId(): string {
    return crypto.randomBytes(8).toString('hex');
  }
}

/**
 * Request Logging Middleware
 * Logs all incoming requests with relevant context including trace information
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: TenantRequest & TracedRequest, res: Response, next: NextFunction): void {
    const startTime = Date.now();
    const { method, originalUrl, ip } = req;
    const correlationId = req.headers['x-correlation-id'];
    const tenantId = req.tenantId || req.headers['x-tenant-id'];

    // Get trace context
    const traceId = req.traceContext?.traceId || req.headers['x-trace-id'];
    const spanId = req.traceContext?.spanId || req.headers['x-span-id'];

    // Log when response finishes
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      const { statusCode } = res;

      // Extract trace context
      const span = trace.getSpan(context.active());
      const traceId = span?.spanContext().traceId;
      const spanId = span?.spanContext().spanId;

      const logMessage = `${method} ${originalUrl} ${statusCode} ${duration}ms`;
      const logContext = {
        method,
        url: originalUrl,
        statusCode,
        duration,
        correlationId,
        traceId,
        spanId,
        tenantId,
        ip,
        userAgent: req.headers['user-agent'],
      };

      if (statusCode >= 500) {
        this.logger.error(logMessage, logContext);
      } else if (statusCode >= 400) {
        this.logger.warn(logMessage, logContext);
      } else {
        this.logger.log(logMessage, logContext);
      }
    });

    next();
  }
}
