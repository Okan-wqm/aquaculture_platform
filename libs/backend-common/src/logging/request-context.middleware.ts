import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { trace, context } from '@opentelemetry/api';

import { RequestContext, requestContextStorage } from './request-context';

/**
 * Express middleware that populates the AsyncLocalStorage-based
 * RequestContext for every incoming HTTP request.
 *
 * It extracts:
 *  - correlationId  (X-Correlation-Id header, or auto-generated UUID)
 *  - traceId / spanId (from active OpenTelemetry span, or X-Trace-Id header)
 *  - tenantId       (X-Tenant-Id header, or from decoded JWT user payload)
 *  - userId         (from the x-user-payload header forwarded by the gateway)
 *  - method, url, ip  (standard Express request fields)
 *
 * This middleware should run as early as possible in the middleware chain
 * (before any business middleware) so that all subsequent code, including
 * the StructuredLoggerService, can read the context.
 *
 * @example
 * ```ts
 * // In your AppModule or main.ts:
 * consumer.apply(RequestContextMiddleware).forRoutes('*');
 * ```
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // --- Correlation ID ---
    let correlationId = req.headers['x-correlation-id'] as string | undefined;
    if (!correlationId?.trim()) {
      correlationId = randomUUID();
    }

    // --- Trace / Span ---
    let traceId: string | undefined;
    let spanId: string | undefined;

    // Prefer OpenTelemetry active span if available
    const activeSpan = trace.getSpan(context.active());
    if (activeSpan) {
      const spanCtx = activeSpan.spanContext();
      traceId = spanCtx.traceId;
      spanId = spanCtx.spanId;
    } else {
      traceId = req.headers['x-trace-id'] as string | undefined;
      spanId = req.headers['x-span-id'] as string | undefined;
    }

    // --- Tenant & User ---
    const tenantId = (req.headers['x-tenant-id'] as string | undefined) || extractTenantFromUser(req);
    const userId = extractUserIdFromPayload(req);

    const requestContext: RequestContext = {
      correlationId,
      traceId,
      spanId,
      tenantId,
      userId,
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip,
    };

    // Propagate correlation ID back to the caller
    res.setHeader('X-Correlation-Id', correlationId);
    if (traceId) {
      res.setHeader('X-Trace-Id', traceId);
    }

    // Run the remainder of the request inside the AsyncLocalStorage context
    requestContextStorage.run(requestContext, () => {
      next();
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Private helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Try to extract tenantId from the x-user-payload header (set by gateway).
 */
function extractTenantFromUser(req: Request): string | undefined {
  const raw = req.headers['x-user-payload'] as string | undefined;
  if (!raw) return undefined;
  try {
    const payload = JSON.parse(raw) as { tenantId?: string };
    return payload.tenantId;
  } catch {
    return undefined;
  }
}

/**
 * Try to extract userId (sub) from the x-user-payload header (set by gateway).
 */
function extractUserIdFromPayload(req: Request): string | undefined {
  const raw = req.headers['x-user-payload'] as string | undefined;
  if (!raw) return undefined;
  try {
    const payload = JSON.parse(raw) as { sub?: string };
    return payload.sub;
  } catch {
    return undefined;
  }
}
