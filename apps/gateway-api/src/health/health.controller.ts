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
 * ARCH-GW-004 / ARCH-GW-006: Health probe architecture for the API gateway.
 *
 * The gateway has no database of its own. Liveness and readiness are now fully
 * decoupled (ARCH-GW-006): composition runs in the BACKGROUND, so the HTTP
 * listener binds in <1s and /health/live answers immediately, while the live
 * supergraph composes asynchronously and /health/ready gates real traffic.
 *
 * Probe endpoints:
 *   GET /health/live   - PURE LIVENESS: 200 the moment the HTTP listener is
 *                        bound. It carries NO composition implication — a 200
 *                        here means "the process is up and accepting
 *                        connections", nothing more. This is the Docker
 *                        healthcheck target AND the deploy script's health gate,
 *                        precisely because it must NOT wait on supergraph
 *                        composition (which previously blocked ~83-94s and broke
 *                        the gate).
 *   GET /health/ready  - READINESS: 200 only once (a) the supergraph has composed
 *                        AND (b) auth is reachable AND (c) no subgraph is
 *                        degraded; 503 with a `checks` breakdown otherwise. This
 *                        is the load-balancer / readiness-sweep target. While the
 *                        background composition is still running, /health/ready
 *                        returns 503 with checks.composition = 'pending'.
 *   GET /health        - General: sanitized status with timestamp, uptime, version.
 *   GET /health/detail - Auth required: full internal details for monitoring.
 *   GET /health/ping   - Simple connectivity check.
 *
 * Deploy integration:
 *   - Docker healthcheck: /health/live (start_period covers process boot, NOT
 *     composition — composition is background, so a short start_period is fine)
 *   - CI deploy script: curl /health/live to confirm the listener is up, then a
 *     readiness sweep on /health/ready to confirm the supergraph is live
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
   *
   * ARCH-GW-006: Returns 200 only once the supergraph has composed AND auth is
   * reachable AND no subgraph is degraded. Returns 503 with the `checks`
   * breakdown otherwise (composition: 'pending' while still composing).
   */
  @Get('ready')
  @Public()
  async readiness(@Res() res: Response): Promise<void> {
    const result = await this.healthService.getReadiness();

    const isReady = result.status === 'ok';
    const httpStatus = isReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    res.status(httpStatus).json({
      status: result.status,
      checks: result.checks,
      ...(result.message !== undefined ? { message: result.message } : {}),
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
