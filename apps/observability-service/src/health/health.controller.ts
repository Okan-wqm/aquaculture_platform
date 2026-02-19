import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { HealthService } from './health.service';
import { Public } from '../guards/internal-api.guard';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly healthService: HealthService,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.pingCheck('database'),
      () => this.memory.checkHeap('memory_heap', 500 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 1024 * 1024 * 1024),
    ]);
  }

  @Get('live')
  @Public()
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @Public()
  async readiness() {
    const dbHealthy = await this.healthService.checkDatabase();
    if (!dbHealthy) {
      throw new HttpException(
        {
          status: 'not_ready',
          timestamp: new Date().toISOString(),
          checks: { database: false },
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        database: true,
      },
    };
  }

  @Get('metrics')
  async metrics() {
    return this.healthService.getMetrics();
  }
}
