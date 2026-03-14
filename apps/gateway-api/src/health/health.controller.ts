import { Controller, Get, HttpCode, HttpException, HttpStatus, Res } from '@nestjs/common';
import { Response } from 'express';

import { Public } from '../guards/auth.guard';

import { HealthService, HealthStatus } from './health.service';

/**
 * Gateway Health Controller
 *
 * The gateway is a special case: it has no database of its own but checks
 * downstream microservices for readiness.
 *
 * Standard K8s probe endpoints:
 *   GET /health/live   - Liveness: always 200 if process is alive
 *   GET /health/ready  - Readiness: 200 if auth service reachable, 503 otherwise
 *   GET /health        - General: sanitized status with timestamp, uptime, version
 *   GET /health/detail - Auth required: full internal details for monitoring
 *   GET /health/ping   - Simple connectivity check
 */
@Controller('health')
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
   * Returns 200 if the gateway can reach critical downstream services.
   * Returns 503 if not ready.
   */
  @Get('ready')
  @Public()
  async readiness(@Res() res: Response): Promise<void> {
    const result = await this.healthService.getReadiness();

    const isReady = result.status === 'ok';
    const httpStatus = isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    res.status(httpStatus).json({
      status: isReady ? 'ok' : 'not_ready',
      checks: {
        downstream: isReady ? 'ok' : 'error',
      },
    });
  }

  /**
   * General Health Endpoint (sanitized, public).
   * Returns timestamp, uptime, version. No internal service details.
   */
  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  health(): {
    status: 'ok';
    timestamp: string;
    uptime: number;
    version: string;
  } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.APP_VERSION || '0.0.0',
    };
  }

  /**
   * Detailed health check endpoint (auth required).
   * Returns full internal details including service URLs, memory, uptime.
   * For monitoring dashboards and debugging only.
   * No @Public() decorator = requires authentication via global AuthGuard.
   */
  @Get('detail')
  @HttpCode(HttpStatus.OK)
  async healthDetail(): Promise<HealthStatus> {
    return this.healthService.getHealth();
  }

  /**
   * Simple ping endpoint.
   */
  @Get('ping')
  @Public()
  @HttpCode(HttpStatus.OK)
  ping(): { message: 'pong'; timestamp: string } {
    return {
      message: 'pong',
      timestamp: new Date().toISOString(),
    };
  }
}
