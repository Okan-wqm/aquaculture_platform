import { Controller, Get, HttpCode, HttpException, HttpStatus } from '@nestjs/common';

import { Public } from '../guards/auth.guard';

import { HealthService, HealthStatus, PublicHealthStatus } from './health.service';

/**
 * Health Controller
 * Provides health check endpoints for kubernetes probes
 *
 * /health/live  - Public (K8s liveness probe)
 * /health/ready - Public (K8s readiness probe)
 * /health/ping  - Public (connectivity check)
 * /health       - Public but sanitized (no internal URLs, memory, uptime)
 * /health/detail - Auth required (full internal details for monitoring)
 */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * Liveness probe endpoint
   * Returns 200 if the gateway is running
   * Used by kubernetes to determine if pod should be restarted
   */
  @Get('live')
  @Public()
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return this.healthService.getLiveness();
  }

  /**
   * Readiness probe endpoint
   * Returns 200 if the gateway is ready to accept traffic
   * Used by kubernetes to determine if pod should receive traffic
   */
  @Get('ready')
  @Public()
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<{ status: 'ok' | 'not_ready'; message?: string }> {
    const result = await this.healthService.getReadiness();

    if (result.status !== 'ok') {
      // Return 503 if not ready
      throw new ServiceUnavailableException(result.message);
    }

    return result;
  }

  /**
   * Public health check endpoint (sanitized)
   * Returns overall status and service names only
   * Does NOT expose: URLs, memory, uptime, version, error details
   */
  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  async health(): Promise<PublicHealthStatus> {
    return this.healthService.getPublicHealth();
  }

  /**
   * Detailed health check endpoint (auth required)
   * Returns full internal details including service URLs, memory, uptime
   * For monitoring dashboards and debugging only
   * No @Public() decorator = requires authentication via global AuthGuard
   */
  @Get('detail')
  @HttpCode(HttpStatus.OK)
  async healthDetail(): Promise<HealthStatus> {
    return this.healthService.getHealth();
  }

  /**
   * Simple ping endpoint
   * Returns pong - useful for simple connectivity checks
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

/**
 * Custom exception for service unavailable
 */
class ServiceUnavailableException extends HttpException {
  constructor(message?: string) {
    super(
      {
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        message: message || 'Service temporarily unavailable',
        error: 'Service Unavailable',
      },
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }
}
