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
import { Controller, Inject, Logger, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import { StandardHealthController } from '@aquaculture/backend-common/health';
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
   * A failing Redis or NATS check results in 'degraded' status (HTTP 200),
   * not 'not_ready' (HTTP 503) -- only total failure of ALL checks triggers 503.
   */
  protected override async getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
    const checks: Record<string, 'ok' | 'error'> = {};

    // Redis connectivity check (only if Redis client is injected)
    if (this.redis) {
      try {
        await this.redis.ping();
        checks['redis'] = 'ok';
      } catch (error) {
        this.healthLogger.warn(
          `Redis health check failed: ${(error as Error).message}`,
        );
        checks['redis'] = 'error';
      }
    }

    // NATS connectivity check (only if NATS client is injected)
    if (this.natsClient) {
      try {
        await this.natsClient.connect();
        checks['nats'] = 'ok';
      } catch (error) {
        this.healthLogger.warn(
          `NATS health check failed: ${(error as Error).message}`,
        );
        checks['nats'] = 'error';
      }
    }

    return checks;
  }
}
