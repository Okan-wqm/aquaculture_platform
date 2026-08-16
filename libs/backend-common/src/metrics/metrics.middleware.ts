import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

import { ServiceMetricsService } from './metrics.service';
import { normalizeRoute } from './route-normalizer';

function matchedRoutePath(request: Request): string | undefined {
  const route: unknown = request.route;
  if (
    typeof route === 'object' &&
    route !== null &&
    'path' in route &&
    typeof route.path === 'string'
  ) {
    return route.path;
  }
  return undefined;
}

/**
 * MetricsMiddleware
 *
 * NestJS middleware that records HTTP request duration and status for Prometheus.
 * Uses route normalization to prevent cardinality explosion from dynamic path segments.
 *
 * Priority order for route label:
 * 1. Express matched route pattern (req.route.path) -- best, already parameterized
 * 2. Heuristic normalization of req.originalUrl -- fallback for unmatched routes
 *
 * Excluded paths: /metrics, /health/* -- these are infrastructure endpoints
 * that would add noise without operational value.
 */
@Injectable()
export class MetricsMiddleware implements NestMiddleware {
  /** Paths excluded from metrics collection to reduce noise */
  private static readonly EXCLUDED_PREFIXES = ['/metrics', '/health'];

  constructor(private readonly metricsService: ServiceMetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const path = req.originalUrl || req.url;

    // Skip metrics collection for infrastructure endpoints
    if (MetricsMiddleware.EXCLUDED_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      next();
      return;
    }

    const startTime = process.hrtime.bigint();
    this.metricsService.incInFlight();

    // No tenant dimension (OBS-HIGH-001 follow-up): the HTTP scrape family
    // carries no tenant label, so the previously-extracted (and
    // attacker-influenceable via x-tenant-id) tenant id is no longer read.

    // Use the 'finish' event to record metrics after the response is sent
    res.on('finish', () => {
      this.metricsService.decInFlight();

      const durationNs = Number(process.hrtime.bigint() - startTime);
      const durationSeconds = durationNs / 1e9;

      // Prefer Express route pattern if available (already parameterized)
      // e.g., /api/sensors/:id instead of /api/sensors/abc-123
      const routePath = matchedRoutePath(req);
      const route = routePath
        ? req.baseUrl + routePath
        : normalizeRoute(path.split('?')[0] ?? path); // Strip query params

      this.metricsService.recordHttpRequest(req.method, route, res.statusCode, durationSeconds);
    });

    next();
  }
}
