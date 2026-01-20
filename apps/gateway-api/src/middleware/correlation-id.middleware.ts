/**
 * Correlation ID Middleware
 *
 * Generates and propagates correlation IDs for request tracing.
 * Essential for distributed tracing and debugging across microservices.
 * Supports X-Request-ID and X-Correlation-ID headers.
 */

import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

/**
 * Header names for correlation ID
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';
export const TRACE_ID_HEADER = 'x-trace-id';

/**
 * Extended request with correlation context
 */
export interface CorrelatedRequest extends Request {
  correlationId: string;
  requestId: string;
  traceId?: string;
  parentSpanId?: string;
}

/**
 * Correlation ID Middleware
 * Ensures every request has a unique correlation ID for tracing
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  private readonly logger = new Logger(CorrelationIdMiddleware.name);

  use(req: Request, res: Response, next: NextFunction): void {
    const correlatedReq = req as CorrelatedRequest;

    // Get or generate correlation ID
    const correlationId = this.extractOrGenerateCorrelationId(req);
    correlatedReq.correlationId = correlationId;

    // Generate unique request ID for this specific request
    const requestId = this.extractOrGenerateRequestId(req);
    correlatedReq.requestId = requestId;

    // Extract trace context if present (OpenTelemetry/Jaeger)
    const traceContext = this.extractTraceContext(req);
    if (traceContext.traceId) {
      correlatedReq.traceId = traceContext.traceId;
      correlatedReq.parentSpanId = traceContext.parentSpanId;
    }

    // Set headers for downstream services
    req.headers[CORRELATION_ID_HEADER] = correlationId;
    req.headers[REQUEST_ID_HEADER] = requestId;

    // Set response headers for client
    res.setHeader(CORRELATION_ID_HEADER, correlationId);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    // Log request start with correlation context
    this.logRequestStart(correlatedReq);

    // Track request duration
    const startTime = Date.now();

    // Log on response finish
    res.on('finish', () => {
      this.logRequestFinish(correlatedReq, res, startTime);
    });

    next();
  }

  /**
   * Extract correlation ID from headers or generate new one
   */
  private extractOrGenerateCorrelationId(req: Request): string {
    // Check for existing correlation ID
    const existingId =
      req.headers[CORRELATION_ID_HEADER] ||
      req.headers['correlation-id'] ||
      req.headers[TRACE_ID_HEADER];

    if (existingId && typeof existingId === 'string') {
      return existingId;
    }

    // Generate new UUID v4
    return randomUUID();
  }

  /**
   * Extract request ID from headers or generate new one
   */
  private extractOrGenerateRequestId(req: Request): string {
    const existingId = req.headers[REQUEST_ID_HEADER];

    if (existingId && typeof existingId === 'string') {
      return existingId;
    }

    return randomUUID();
  }

  /**
   * Extract OpenTelemetry/Jaeger trace context
   */
  private extractTraceContext(req: Request): {
    traceId?: string;
    parentSpanId?: string;
  } {
    // Check W3C Trace Context header
    const traceparent = req.headers['traceparent'];
    if (traceparent && typeof traceparent === 'string') {
      const parts = traceparent.split('-');
      if (parts.length >= 3) {
        return {
          traceId: parts[1],
          parentSpanId: parts[2],
        };
      }
    }

    // Check Jaeger headers
    const uberTraceId = req.headers['uber-trace-id'];
    if (uberTraceId && typeof uberTraceId === 'string') {
      const parts = uberTraceId.split(':');
      if (parts.length >= 2) {
        return {
          traceId: parts[0],
          parentSpanId: parts[1],
        };
      }
    }

    // Check X-B3 headers (Zipkin)
    const b3TraceId = req.headers['x-b3-traceid'];
    const b3SpanId = req.headers['x-b3-spanid'];
    if (b3TraceId && typeof b3TraceId === 'string') {
      return {
        traceId: b3TraceId,
        parentSpanId: typeof b3SpanId === 'string' ? b3SpanId : undefined,
      };
    }

    return {};
  }

  /**
   * Log request start
   */
  private logRequestStart(req: CorrelatedRequest): void {
    this.logger.debug(
      `[${req.correlationId}] ${req.method} ${req.url} - Started`,
      {
        correlationId: req.correlationId,
        requestId: req.requestId,
        method: req.method,
        url: req.url,
        ip: req.ip || req.headers['x-forwarded-for'],
        userAgent: req.headers['user-agent'],
      },
    );
  }

  /**
   * Log request finish
   */
  private logRequestFinish(
    req: CorrelatedRequest,
    res: Response,
    startTime: number,
  ): void {
    const duration = Date.now() - startTime;
    const statusCode = res.statusCode;

    const logData = {
      correlationId: req.correlationId,
      requestId: req.requestId,
      method: req.method,
      url: req.url,
      statusCode,
      duration,
    };

    if (statusCode >= 500) {
      this.logger.error(
        `[${req.correlationId}] ${req.method} ${req.url} - ${statusCode} (${duration}ms)`,
        logData,
      );
    } else if (statusCode >= 400) {
      this.logger.warn(
        `[${req.correlationId}] ${req.method} ${req.url} - ${statusCode} (${duration}ms)`,
        logData,
      );
    } else {
      this.logger.log(
        `[${req.correlationId}] ${req.method} ${req.url} - ${statusCode} (${duration}ms)`,
        logData,
      );
    }
  }
}

/**
 * Helper to get correlation ID from request
 */
export function getCorrelationId(req: Request): string | undefined {
  return (req as CorrelatedRequest).correlationId;
}

/**
 * Helper to get request ID from request
 */
export function getRequestId(req: Request): string | undefined {
  return (req as CorrelatedRequest).requestId;
}
