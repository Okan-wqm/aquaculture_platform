import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { StandardHealthController } from '@aquaculture/backend-common/health';
import { DataSource } from 'typeorm';

import { Public } from '../guards/internal-api.guard';
import { HealthService } from './health.service';

/**
 * Observability Service Health Controller
 * Extends the standard health controller with consistent K8s probe format.
 * Retains the /health/metrics endpoint for internal monitoring.
 */
@Controller('health')
export class HealthController extends StandardHealthController {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
    private readonly healthService: HealthService,
  ) {
    super(dataSource);
    this.serviceName = 'observability-service';
  }

  /**
   * Internal metrics endpoint (auth required via controller-level guard).
   * Not part of the standard K8s probe set.
   */
  @Get('metrics')
  async metrics() {
    return this.healthService.getMetrics();
  }
}
