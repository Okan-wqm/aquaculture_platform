import { Controller, Get, Res, Header } from '@nestjs/common';
import { Response } from 'express';
import { PrometheusService } from './prometheus.service';

/**
 * Prometheus Metrics Controller
 *
 * SECURITY NOTE: Bu endpoint Prometheus scraper tarafından kullanılır ve
 * genellikle network seviyesinde korunmalıdır (Kubernetes NetworkPolicy,
 * firewall rules, vb.). Production'da bu endpoint sadece internal network'ten
 * erişilebilir olmalıdır.
 *
 * Eğer dış erişime açılması gerekiyorsa, INTERNAL_API_KEY ile koruma eklenmelidir.
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
