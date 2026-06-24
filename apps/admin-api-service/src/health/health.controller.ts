import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@aquaculture/backend-common/security';
import { Response } from 'express';

import { Public } from '../decorators/public.decorator';

import { HealthService } from './health.service';

/**
 * Reads the version field from a package's package.json at runtime.
 * Returns 'unknown' if the package is not resolvable.
 */
function safeRequireVersion(packageJsonPath: string): string {
  try {
    return require(packageJsonPath).version;
  } catch {
    return 'unknown';
  }
}

/**
 * Admin API Health Controller
 *
 * Standardized K8s probe endpoints:
 *   GET /health/live    - Liveness: always 200 if process is alive
 *   GET /health/ready   - Readiness: 200 if database reachable, 503 otherwise
 *   GET /health         - General: sanitized status (timestamp, uptime, version)
 *   GET /health/startup - Startup probe for K8s (200 after full init)
 *
 * Internal (auth required):
 *   GET  /health/metrics              - Process metrics
 *   GET  /health/circuit-breakers     - Circuit breaker states
 *   POST /health/circuit-breakers/:name/reset - Reset a circuit breaker
 */
@ApiTags('Health')
@Controller('health')
@SkipThrottle()
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * K8s Liveness Probe.
   * Returns 200 as long as the process is running.
   */
  @Get('live')
  @Public()
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * K8s Readiness Probe.
   * Returns 200 if database is reachable, 503 otherwise.
   * Also reports draining status during graceful shutdown.
   */
  @Get('ready')
  @Public()
  async readiness(@Res() res: Response): Promise<void> {
    const draining = this.healthService.isDraining();
    const dbHealthy = draining ? false : await this.healthService.checkDatabase();
    const smtpStatus = this.healthService.getSmtpStatus();
    const isReady = dbHealthy && !draining;

    const status = isReady ? 'ok' : 'not_ready';
    const httpStatus = isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    const body = {
      status,
      checks: {
        database: dbHealthy ? 'ok' : 'error',
        smtp: smtpStatus.state === 'closed' ? 'ok' : 'error',
        ...(draining ? { draining: 'error' as const } : {}),
      },
    };

    res.status(httpStatus).json(body);
  }

  /**
   * General Health Endpoint (sanitized, public).
   * Returns timestamp, uptime, version. No sensitive data.
   *
   * ADR-013 Section 8.4: Includes framework version info so operators can
   * identify whether this service is running NestJS v10 or v11 during
   * phased upgrade rollouts.
   */
  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  health(): {
    status: 'ok';
    timestamp: string;
    uptime: number;
    version: string;
    service: string;
    framework: { nestjs: string; express: string; node: string };
  } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env['APP_VERSION'] || '0.0.0',
      service: 'admin-api-service',
      framework: {
        nestjs: safeRequireVersion('@nestjs/core/package.json'),
        express: safeRequireVersion('express/package.json'),
        node: process.version,
      },
    };
  }

  /**
   * Startup probe for K8s.
   * Returns 200 only after the application has fully initialized.
   */
  @Get('startup')
  @Public()
  startup(@Res() res: Response): void {
    const ready = this.healthService.isStartupComplete();
    const status = ready ? 'ok' : 'not_ready';
    const httpStatus = ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    res.status(httpStatus).json({
      status,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Internal metrics endpoint (auth required).
   */
  @Get('metrics')
  async metrics() {
    return this.healthService.getMetrics();
  }

  /**
   * Internal circuit breaker status (auth required).
   */
  @Get('circuit-breakers')
  getCircuitBreakers() {
    return this.healthService.getCircuitBreakers();
  }

  /**
   * Reset a circuit breaker (auth required).
   */
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
