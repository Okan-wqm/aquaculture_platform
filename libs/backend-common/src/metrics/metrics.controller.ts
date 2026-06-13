import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';

import { Public } from '../decorators/roles.decorator';

import { ServiceMetricsService } from './metrics.service';

/**
 * MetricsController
 *
 * Exposes the /metrics endpoint for Prometheus scraping.
 *
 * SECURITY (OBS-HIGH-001): the endpoint carries @Public() directly so the
 * module is genuinely drop-in. WHY this is universally correct: every guard
 * chain in the platform keys public-route bypass on the same `'isPublic'`
 * reflector metadata — backend-common TenantGuard / RolesGuard
 * (IS_PUBLIC_KEY in decorators/roles.decorator.ts), gateway-api's own
 * AuthGuard (apps/gateway-api/src/guards/auth.guard.ts:45), billing's local
 * JwtAuthGuard, and admin-api's PlatformAdminGuard all read 'isPublic'.
 * @Public() additionally sets 'skipTenantGuard', so TenantGuard is bypassed
 * without a second decorator. The pre-fix doc-comment here claimed a
 * "properly decorated controller factory" that never existed — that lie is
 * the root cause of 10 services shipping with no scrape endpoint at all.
 *
 * The endpoint is reachable at /metrics (not /api/v1/metrics) because
 * bootstrap/create-service-app.ts excludes 'metrics' from the global prefix
 * by default (DEFAULT_PREFIX_EXCLUSIONS).
 */
@Controller('metrics')
@Public()
export class MetricsController {
  constructor(private readonly metricsService: ServiceMetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    res.set('Content-Type', this.metricsService.getContentType());
    res.end(metrics);
  }
}
