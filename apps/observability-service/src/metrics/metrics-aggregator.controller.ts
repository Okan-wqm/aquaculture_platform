import { Controller, Get, Param } from '@nestjs/common';
import {
  MetricsAggregatorService,
  AggregatedMetrics,
} from './metrics-aggregator.service';

@Controller('aggregated-metrics')
export class MetricsAggregatorController {
  constructor(
    private readonly metricsAggregatorService: MetricsAggregatorService,
  ) {}

  @Get()
  getAggregatedMetrics(): AggregatedMetrics | { message: string } {
    const metrics = this.metricsAggregatorService.getAggregatedMetrics();
    if (!metrics) {
      return { message: 'Metrics not yet available' };
    }
    return metrics;
  }

  @Get('tenants')
  getTenantMetrics(): { tenants: AggregatedMetrics['tenants'] } | { message: string } {
    const metrics = this.metricsAggregatorService.getAggregatedMetrics();
    if (!metrics) {
      return { message: 'Metrics not yet available' };
    }
    return { tenants: metrics.tenants };
  }

  @Get('sensors')
  getSensorMetrics(): { sensors: AggregatedMetrics['sensors'] } | { message: string } {
    const metrics = this.metricsAggregatorService.getAggregatedMetrics();
    if (!metrics) {
      return { message: 'Metrics not yet available' };
    }
    return { sensors: metrics.sensors };
  }

  @Get('alerts')
  getAlertMetrics(): { alerts: AggregatedMetrics['alerts'] } | { message: string } {
    const metrics = this.metricsAggregatorService.getAggregatedMetrics();
    if (!metrics) {
      return { message: 'Metrics not yet available' };
    }
    return { alerts: metrics.alerts };
  }

  @Get('system')
  getSystemMetrics(): { system: AggregatedMetrics['system'] } | { message: string } {
    const metrics = this.metricsAggregatorService.getAggregatedMetrics();
    if (!metrics) {
      return { message: 'Metrics not yet available' };
    }
    return { system: metrics.system };
  }

  @Get('tenant/:tenantId')
  async getTenantSpecificMetrics(@Param('tenantId') tenantId: string) {
    return this.metricsAggregatorService.getTenantMetrics(tenantId);
  }
}
