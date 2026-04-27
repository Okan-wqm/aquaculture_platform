import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { ServiceMetricsService } from '@aquaculture/backend-common/metrics';

import { Public } from '../guards/auth.guard';

/**
 * Gateway Metrics Controller
 *
 * Exposes /metrics for Prometheus scraping.
 * Uses gateway-api's own @Public() decorator to bypass the AuthGuard.
 */
@Controller('metrics')
@Public()
export class GatewayMetricsController {
  constructor(private readonly metricsService: ServiceMetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    res.set('Content-Type', this.metricsService.getContentType());
    res.end(metrics);
  }
}
