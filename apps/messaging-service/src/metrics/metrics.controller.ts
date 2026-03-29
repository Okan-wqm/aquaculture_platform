/**
 * @module MetricsController
 * @description Prometheus scrape endpoint for the messaging-service.
 * Exposes GET /metrics in Prometheus exposition format.
 * @see ADR-012 section 10 (Observability)
 */
import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { MessagingMetricsService } from './messaging-metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metricsService: MessagingMetricsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.metricsService.getMetrics();
    res.set('Content-Type', this.metricsService.getContentType());
    res.end(metrics);
  }
}
