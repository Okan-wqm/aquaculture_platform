import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { PrometheusService } from './prometheus.service';

/**
 * Prometheus Metrics Controller
 *
 * Exposes the /metrics scrape endpoint for Prometheus. This endpoint is
 * protected by the global InternalApiGuard — Prometheus must be configured
 * to send the x-internal-api-key header on every scrape request.
 *
 * The endpoint is excluded from the api/v1 global prefix so it is reachable
 * at the conventional /metrics path expected by Prometheus scrape jobs.
 */
@Controller('metrics')
export class PrometheusController {
  constructor(private readonly prometheusService: PrometheusService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async getMetrics(@Res() res: Response): Promise<void> {
    const metrics = await this.prometheusService.getMetrics();
    res.set('Content-Type', this.prometheusService.getContentType());
    res.end(metrics);
  }
}
