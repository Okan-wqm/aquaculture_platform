/**
 * @module HealthController
 * @description Health check endpoints for liveness and readiness probes.
 *
 * Extends StandardHealthController to inherit:
 *   - @Public() decorator: bypasses TenantGuard + RolesGuard (critical for
 *     Docker healthcheck which sends plain wget without auth headers)
 *   - @SkipThrottle(): prevents rate-limiting of probe requests
 *   - Consistent response format across all microservices
 *   - Proper HTTP 503 when all checks fail (not just body status)
 *
 * Adds Redis and NATS connectivity as additional readiness checks
 * beyond the standard database check.
 *
 * @see ADR-012 section 10 (Observability)
 */
import { Controller, Get, HttpStatus, Inject, Logger, Optional, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { ReadinessResponse, StandardHealthController } from '@aquaculture/backend-common/health';
import { Public } from '@aquaculture/backend-common/decorators';
import { SkipThrottle } from '@aquaculture/backend-common/security';
import { Response } from 'express';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../shared/redis.provider';

@Controller('health')
export class HealthController extends StandardHealthController {
  private readonly healthLogger = new Logger('messaging-service:HealthController');

  constructor(
    @InjectDataSource() dataSource: DataSource,
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis?: Redis,
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {
    super(dataSource);
    this.serviceName = 'messaging-service';
  }

  /**
   * Additional readiness checks for Redis and NATS connectivity.
   * These supplement the standard database check from StandardHealthController.
   *
   * Optional dependencies that are not injected (undefined) are silently
   * skipped rather than reported as errors. This avoids false 'degraded'
   * status when the provider is simply not in the current module scope.
   *
   * A failing Redis or NATS check is release-critical for messaging and
   * must return HTTP 503, not HTTP 200 degraded.
   */
  @Get('ready')
  @Public()
  @SkipThrottle()
  override async readiness(@Res() res: Response): Promise<void> {
    const checks: Record<string, 'ok' | 'error'> = {
      database: await this.checkDatabase(),
      ...(await this.getAdditionalChecks()),
    };
    const hasError = Object.values(checks).some((value) => value === 'error');
    const body: ReadinessResponse = {
      status: hasError ? 'not_ready' : 'ok',
      checks: checks as ReadinessResponse['checks'],
    };
    res.status(hasError ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK).json(body);
  }

  protected override async getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
    const checks: Record<string, 'ok' | 'error'> = {};

    // Redis connectivity check (only if Redis client is injected)
    if (this.redis) {
      try {
        await this.redis.ping();
        checks['redis'] = 'ok';
      } catch (error) {
        this.healthLogger.warn(`Redis health check failed: ${(error as Error).message}`);
        checks['redis'] = 'error';
      }
    }

    // NATS connectivity check (only if NATS client is injected)
    if (this.natsClient) {
      try {
        await this.natsClient.connect();
        checks['nats'] = 'ok';
      } catch (error) {
        this.healthLogger.warn(`NATS health check failed: ${(error as Error).message}`);
        checks['nats'] = 'error';
      }
    }

    return checks;
  }
}
