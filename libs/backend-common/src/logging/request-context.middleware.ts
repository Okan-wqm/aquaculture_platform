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
 *  - tenantId       (from verified farm identity, TenantGuard, or decoded JWT)
 *  - userId         (from verified farm identity or decoded JWT)
 *  - method, url, ip  (standard Express request fields)
 *
 * This middleware should run after identity/tenant middleware and before any
 * business handler so StructuredLoggerService sees verified request context.
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
    // Never seed ALS from raw gateway headers. Guards/middleware must first
    // build the verified request identity and only then expose tenant/user here.
    const verifiedReq = req as Request & {
      tenantId?: string;
      user?: { sub?: string; tenantId?: string };
      farmVerifiedIdentity?: { actorUserId?: string; effectiveTenantId?: string };
    };
    const tenantId =
      verifiedReq.farmVerifiedIdentity?.effectiveTenantId ??
      verifiedReq.tenantId ??
      verifiedReq.user?.tenantId;
    const userId = verifiedReq.farmVerifiedIdentity?.actorUserId ?? verifiedReq.user?.sub;

    const requestContext: RequestContext = {
      correlationId,
      traceId,
      spanId,
      tenantId,
      userId,
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip ?? 'unknown',
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
