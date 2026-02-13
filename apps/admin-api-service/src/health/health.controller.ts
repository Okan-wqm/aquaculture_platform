import { SkipThrottle } from '@aquaculture/backend-common';
import { Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
} from '@nestjs/terminus';
import { Response } from 'express';

import { Public } from '../decorators/public.decorator';

import { HealthService } from './health.service';


@ApiTags('Health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly memory: MemoryHealthIndicator,
    private readonly healthService: HealthService,
  ) {}

  @Get()
  @Public()
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
  @HttpCode(HttpStatus.OK)
  liveness() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  @Public()
  async readiness(@Res() res: Response) {
    const draining = this.healthService.isDraining();
    const dbHealthy = draining ? false : await this.healthService.checkDatabase();
    const smtpStatus = this.healthService.getSmtpStatus();
    const isReady = dbHealthy && !draining;

    const body = {
      status: isReady ? 'ok' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        database: dbHealthy,
        smtp: smtpStatus.state,
        ...(draining ? { draining: true } : {}),
      },
    };

    res.status(isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(body);
  }

  /**
   * Startup probe — returns 200 only after the application has fully initialized.
   * Use as Kubernetes startupProbe to avoid premature liveness/readiness checks.
   */
  @Get('startup')
  @Public()
  startup(@Res() res: Response) {
    const ready = this.healthService.isStartupComplete();
    const body = {
      status: ready ? 'started' : 'starting',
      timestamp: new Date().toISOString(),
    };
    res.status(ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json(body);
  }

  @Get('metrics')
  @Public()
  async metrics() {
    return this.healthService.getMetrics();
  }

  @Get('circuit-breakers')
  getCircuitBreakers() {
    return this.healthService.getCircuitBreakers();
  }

  @Post('circuit-breakers/:name/reset')
  @HttpCode(HttpStatus.OK)
  resetCircuitBreaker(@Param('name') name: string) {
    const success = this.healthService.resetCircuitBreaker(name);
    if (!success) {
      throw new NotFoundException(`Circuit breaker '${name}' not found`);
    }
    return { success: true, name, state: 'closed' };
  }
}
