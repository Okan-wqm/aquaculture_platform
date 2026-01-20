import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { HealthService } from './health.service';

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
      // Database check
      () => this.db.pingCheck('database'),
      // Memory check (heap should be < 500MB)
      () => this.memory.checkHeap('memory_heap', 500 * 1024 * 1024),
      // RSS memory check (< 1GB)
      () => this.memory.checkRSS('memory_rss', 1024 * 1024 * 1024),
    ]);
  }

  @Get('live')
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async readiness() {
    const dbHealthy = await this.healthService.checkDatabase();
    return {
      status: dbHealthy ? 'ok' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbHealthy,
      },
    };
  }

  @Get('metrics')
  async metrics() {
    return this.healthService.getMetrics();
  }
}
