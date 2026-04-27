// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';
import type { Request, Response, NextFunction } from 'express';

// ---------------------------------------------------------------------------
// Lightweight in-process rate limiter (no external dependency required).
// Uses a sliding-window counter keyed by IP address.
// ---------------------------------------------------------------------------
interface RateLimitWindow {
  count: number;
  windowStart: number;
}

function createRateLimiter(maxRequests: number, windowMs: number) {
  const store = new Map<string, RateLimitWindow>();

  // Prune stale entries every 5 minutes to prevent unbounded growth
  const pruneInterval = setInterval(
    () => {
      const now = Date.now();
      for (const [key, window] of store) {
        if (now - window.windowStart >= windowMs) {
          store.delete(key);
        }
      }
    },
    5 * 60 * 1000,
  );
  // Allow the Node.js process to exit even if this timer is still active
  pruneInterval.unref();

  return function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip ||
      'unknown';
    const now = Date.now();
    const existing = store.get(ip);

    if (!existing || now - existing.windowStart >= windowMs) {
      store.set(ip, { count: 1, windowStart: now });
      next();
      return;
    }

    existing.count++;
    if (existing.count > maxRequests) {
      res.status(429).json({
        statusCode: 429,
        message: 'Too Many Requests',
        retryAfter: Math.ceil((windowMs - (now - existing.windowStart)) / 1000),
      });
      return;
    }

    next();
  };
}

bootstrapService(AppModule, {
  serviceName: 'observability-service',
  portEnvVar: 'OBSERVABILITY_SERVICE_PORT',
  // Internal-only service: Prometheus scrapes /metrics from inside the cluster,
  // and the only HTTP surface is /metrics + /health. No browser ever talks to
  // this service, so CORS is conceptually inapplicable. The shared bootstrap
  // skips configureCors() entirely when visibility is 'internal' rather than
  // requiring a synthetic CORS_ORIGINS env var to bypass the production
  // hard-fail (which would be a patch hiding the architectural truth).
  serviceVisibility: 'internal',
  // Rate limiting: 60 requests per minute per IP across all observability endpoints.
  earlyMiddleware: [createRateLimiter(60, 60 * 1000)],
  prefixExclusions: ['metrics', 'health', 'health/live', 'health/ready', 'health/metrics'],
});
