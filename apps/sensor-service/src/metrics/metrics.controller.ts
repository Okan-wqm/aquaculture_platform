import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { Public, SkipTenantGuard, ServiceMetricsService } from '@platform/backend-common';

/**
 * Sensor Service Metrics Controller
 *
 * Exposes /metrics for Prometheus scraping.
 * @Public() bypasses TenantGuard and RolesGuard.
 * @SkipTenantGuard() bypasses tenant schema middleware check.
 */
@Controller('metrics')
@Public()
@SkipTenantGuard()
export class SensorMetricsController {
  constructor(private readonly metricsService: ServiceMetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    res.set('Content-Type', this.metricsService.getContentType());
    res.end(metrics);
  }
}
