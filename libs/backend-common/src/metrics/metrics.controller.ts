import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';

import { ServiceMetricsService } from './metrics.service';

/**
 * MetricsController
 *
 * Exposes the /metrics endpoint for Prometheus scraping.
 *
 * SECURITY: This endpoint must be @Public() so Prometheus can scrape without
 * authentication. The guard decorators are applied from the consuming service's
 * own @Public() decorator (gateway uses its own, subservices use backend-common's).
 *
 * Note: We intentionally do NOT import @Public() here because:
 * - gateway-api has its own @Public() in auth.guard.ts
 * - subservices use @Public() from backend-common
 * Instead, the consuming module must apply @Public() at the controller or method level
 * when registering this controller, OR the controller must be excluded from global guards.
 *
 * The MetricsModule handles this by providing a factory that creates a properly
 * decorated controller for each service context.
 */
@Controller('metrics')
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
