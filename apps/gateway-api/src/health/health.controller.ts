import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { HealthService, HealthStatus } from './health.service';
import { Public } from '../guards/graphql-auth.guard';

/**
 * Health Controller
 * Provides health check endpoints for kubernetes probes
 * All endpoints are public (no auth required)
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
  async liveness(): Promise<{ status: 'ok' }> {
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
   * Comprehensive health check endpoint
   * Returns detailed health status of all services
   * Used for monitoring dashboards and debugging
   */
  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  async health(): Promise<HealthStatus> {
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
import { HttpException } from '@nestjs/common';

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
