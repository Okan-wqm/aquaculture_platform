import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { Public, SkipTenantGuard, ServiceMetricsService } from '@platform/backend-common';

/**
 * Auth Service Metrics Controller
 *
 * Exposes /metrics for Prometheus scraping.
 * @Public() bypasses global JwtAuthGuard so Prometheus can scrape without auth.
 * @SkipTenantGuard() bypasses global TenantGuard (no tenant context needed).
 */
@Controller('metrics')
@Public()
@SkipTenantGuard()
export class AuthMetricsController {
  constructor(private readonly metricsService: ServiceMetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    res.set('Content-Type', this.metricsService.getContentType());
    res.end(metrics);
  }
}
