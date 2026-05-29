import { Controller, Get, Header, Res } from '@nestjs/common';
import { Public } from '@aquaculture/backend-common/decorators';
import { SkipThrottle } from '@aquaculture/backend-common/security';
import type { Response } from 'express';

import { FarmDomainMetricsService } from './farm-domain-metrics.service';

@Controller('metrics')
@Public()
@SkipThrottle()
export class FarmMetricsController {
  constructor(private readonly metricsService: FarmDomainMetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    res.set('Content-Type', this.metricsService.getContentType());
    res.end(metrics);
  }
}
