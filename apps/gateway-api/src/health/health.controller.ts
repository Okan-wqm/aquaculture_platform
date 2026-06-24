import { Controller, Get, HttpCode, HttpException, HttpStatus, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';

import { Role, Roles } from '@aquaculture/backend-common/decorators';
import { RolesGuard } from '@aquaculture/backend-common/guards';
import { Public } from '../guards/auth.guard';

import { HealthService, HealthStatus } from './health.service';

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
 * Gateway Health Controller
 *
 * ARCH-GW-004: Health probe architecture for the API gateway.
 *
 * The gateway has no database of its own. Its health depends on:
 *   1. NestJS process running (liveness)
 *   2. Supergraph composed successfully (implicit in liveness -- NestFactory.create
 *      blocks until RetryableIntrospectAndCompose completes)
 *   3. Critical downstream service reachable (readiness -- auth service)
 *
 * Probe endpoints:
 *   GET /health/live   - Liveness: 200 if NestJS process started (supergraph is composed).
 *                        Used by Docker healthcheck and deploy script. This endpoint only
 *                        becomes available AFTER NestFactory.create() completes, which
 *                        requires successful supergraph composition. Therefore, a 200 from
 *                        /health/live implicitly confirms federation is operational.
 *   GET /health/ready  - Readiness: 200 if auth service is reachable, 503 otherwise.
 *                        Intentionally checks only the auth service (critical path), NOT
 *                        all subgraphs. A single degraded subgraph should not remove the
 *                        gateway from the load balancer.
 *   GET /health        - General: sanitized status with timestamp, uptime, version.
 *   GET /health/detail - Auth required: full internal details for monitoring.
 *   GET /health/ping   - Simple connectivity check.
 *
 * Deploy integration:
 *   - Docker healthcheck: /health/live (start_period: 120s, interval: 30s)
 *   - CI deploy script: curl /health/live (30 attempts x 10s = 300s window)
 *   - Rollback trigger: deploy script exits 1 if /health/live never returns 200
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
   *
   * ADR-013 Section 8.4: Includes framework version info so operators can
   * identify whether this gateway is running NestJS v10 or v11 during
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
      service: 'gateway-api',
      framework: {
        nestjs: safeRequireVersion('@nestjs/core/package.json'),
        express: safeRequireVersion('express/package.json'),
        node: process.version,
      },
    };
  }

  /**
   * SEC-L06: Detailed health check endpoint restricted to platform administrators.
   *
   * Returns full internal details including service URLs, memory usage, and uptime.
   * This information is valuable for infrastructure reconnaissance attacks if exposed
   * to regular users, so access is limited to SUPER_ADMIN and TENANT_ADMIN roles.
   * The global AuthGuard handles JWT verification; RolesGuard enforces role check.
   */
  @UseGuards(RolesGuard)
  @Roles(Role.SUPER_ADMIN, Role.TENANT_ADMIN)
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
