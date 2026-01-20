import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { PrometheusService } from './prometheus.service';

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
