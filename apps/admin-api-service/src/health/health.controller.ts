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
import { SkipThrottle, ThrottleSensitive } from '@aquaculture/backend-common/security';
import { Response } from 'express';

import { Public } from '@aquaculture/backend-common/decorators';
import { AdminManualResponse } from '../shared/admin-response-contract.decorator';
import { sendAdminHealthResponse } from '../shared/admin-manual-response.sender';

import { HealthService } from './health.service';
import { AdminResponseContract } from '../shared/admin-response-contract.decorator';
import {
  healthMetricsResponseContract,
  type HealthMetricsResponseDto,
  healthCircuitBreakerStatusContract,
  type HealthCircuitBreakerStatusDto,
  healthResetCircuitBreakerResponseContract,
  type HealthResetCircuitBreakerResponseDto,
  healthGeneralProfile,
  healthLivenessProfile,
  healthReadinessProfile,
  healthStartupProfile,
} from './contracts/admin-http-response.contract';

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
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  /**
   * K8s Liveness Probe.
   * Returns 200 as long as the process is running.
   */
  @Get('live')
  @Public()
  @SkipThrottle()
  @AdminManualResponse(healthLivenessProfile)
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * K8s Readiness Probe.
   * Returns 200 if mandatory database and NATS dependencies are reachable.
   * Also reports draining status during graceful shutdown.
   */
  @Get('ready')
  @Public()
  @SkipThrottle()
  @AdminManualResponse(healthReadinessProfile)
  async readiness(@Res() res: Response): Promise<void> {
    const draining = this.healthService.isDraining();
    const [dbHealthy, natsHealthy] = draining
      ? [false, false]
      : await Promise.all([this.healthService.checkDatabase(), this.healthService.checkNats()]);
    const smtpStatus = this.healthService.getSmtpStatus();
    const isReady = dbHealthy && natsHealthy && !draining;

    const status = isReady ? ('ok' as const) : ('not_ready' as const);
    const httpStatus = isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    const body = {
      status,
      checks: {
        database: dbHealthy ? ('ok' as const) : ('error' as const),
        nats: natsHealthy ? ('ok' as const) : ('error' as const),
        smtp: smtpStatus.state === 'closed' ? ('ok' as const) : ('error' as const),
        ...(draining ? { draining: 'error' as const } : {}),
      },
    };

    sendAdminHealthResponse(res, healthReadinessProfile, httpStatus, body);
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
  @SkipThrottle()
  @AdminManualResponse(healthGeneralProfile)
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
  @SkipThrottle()
  @AdminManualResponse(healthStartupProfile)
  startup(@Res() res: Response): void {
    const ready = this.healthService.isStartupComplete();
    const status = ready ? 'ok' : 'not_ready';
    const httpStatus = ready ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    sendAdminHealthResponse(res, healthStartupProfile, httpStatus, {
      status,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Internal metrics endpoint (auth required).
   */
  @AdminResponseContract(healthMetricsResponseContract)
  @Get('metrics')
  async metrics(): Promise<HealthMetricsResponseDto> {
    return this.healthService.getMetrics();
  }

  /**
   * Internal circuit breaker status (auth required).
   */
  @AdminResponseContract(healthCircuitBreakerStatusContract)
  @Get('circuit-breakers')
  getCircuitBreakers(): HealthCircuitBreakerStatusDto {
    return this.healthService.getCircuitBreakers();
  }

  /**
   * Reset a circuit breaker (auth required).
   */
  @AdminResponseContract(healthResetCircuitBreakerResponseContract)
  @ThrottleSensitive()
  @Post('circuit-breakers/:name/reset')
  @HttpCode(HttpStatus.OK)
  resetCircuitBreaker(@Param('name') name: string): HealthResetCircuitBreakerResponseDto {
    const success = this.healthService.resetCircuitBreaker(name);
    if (!success) {
      throw new NotFoundException(`Circuit breaker '${name}' not found`);
    }
    return { success: true, name, state: 'closed' };
  }
}
