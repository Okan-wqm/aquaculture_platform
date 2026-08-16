import { Controller, Get, HttpCode, HttpStatus, Res, Logger } from '@nestjs/common';
import nestPackage from '@nestjs/core/package.json';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import expressPackage from 'express/package.json';
import { DataSource } from 'typeorm';

import { Public } from '../decorators/roles.decorator';
import { SkipThrottle } from '../security/throttler/throttler.decorator';

/**
 * Runtime framework versions exposed by the health endpoint.
 * Used to identify NestJS v10 vs v11 and Express v4 vs v5 during
 * phased upgrade rollouts (ADR-013 Section 8.4).
 */
export interface FrameworkVersionInfo {
  /** NestJS framework version — e.g. "10.4.15" or "11.0.1" */
  nestjs: string;
  /** Express HTTP adapter version — v4 (NestJS v10) vs v5 (NestJS v11) */
  express: string;
  /** Node.js runtime version */
  node: string;
}

/**
 * Standard health check response for the general /health endpoint.
 * Contains only non-sensitive information safe for public exposure.
 */
export interface StandardHealthResponse {
  status: 'ok';
  timestamp: string;
  uptime: number;
  version: string;
  /** Service name for identification in multi-service monitoring */
  service: string;
  /** Framework versions for v10/v11 identification during phased upgrade */
  framework: FrameworkVersionInfo;
}

/**
 * Readiness check response for the /health/ready endpoint.
 * Reports service readiness and dependency checks.
 */
export interface ReadinessResponse {
  status: 'ok' | 'degraded' | 'not_ready';
  checks: {
    database: 'ok' | 'error';
    [key: string]: 'ok' | 'error';
  };
}

/**
 * Configuration options for the StandardHealthController.
 * Services can extend this controller and provide service-specific options.
 */
export interface HealthControllerOptions {
  /**
   * Service name for logging purposes.
   */
  serviceName: string;

  /**
   * Service version. Defaults to process.env.APP_VERSION or '0.0.0'.
   */
  version?: string;

  /**
   * Additional readiness checks beyond the standard database check.
   * Each check returns 'ok' or 'error'.
   */
  additionalChecks?: () => Promise<Record<string, 'ok' | 'error'>>;
}

/**
 * StandardHealthController
 *
 * Provides a unified health check format across all microservices for K8s probes:
 *
 *   GET /health/live  -> Liveness probe. Always returns 200 if process is alive.
 *   GET /health/ready -> Readiness probe. Returns 200 if database (and custom checks)
 *                        are reachable, 503 otherwise.
 *   GET /health       -> General health. Returns sanitized status with timestamp,
 *                        uptime, and version. No sensitive data.
 *
 * All endpoints are public (no auth/tenant required) and skip throttling so that
 * K8s probes and load balancers always get a response.
 *
 * Services can extend this controller to add service-specific checks (e.g. TimescaleDB,
 * NATS, MQTT) by overriding `getAdditionalChecks()`.
 */
@Controller('health')
@Public()
@SkipThrottle()
export class StandardHealthController {
  protected serviceName = 'service';
  protected version: string = process.env['APP_VERSION'] || '0.0.0';

  private _logger?: Logger;

  /** Lazily creates a Logger using the (possibly overridden) serviceName. */
  protected get logger(): Logger {
    if (!this._logger) {
      this._logger = new Logger(`${this.serviceName}:HealthController`);
    }
    return this._logger;
  }

  /** Allow subclasses to replace the logger. */
  protected set logger(value: Logger) {
    this._logger = value;
  }

  constructor(
    @InjectDataSource()
    protected readonly dataSource: DataSource,
  ) {}

  /**
   * K8s Liveness Probe.
   * Returns 200 as long as the process is running.
   * K8s restarts the pod if this fails.
   */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * K8s Readiness Probe.
   * Returns 200 if the database is reachable (via `SELECT 1`).
   * Returns 503 if the database is unreachable.
   * K8s removes the pod from service endpoints if this fails.
   */
  @Get('ready')
  async readiness(@Res() res: Response): Promise<void> {
    const checks: Record<string, 'ok' | 'error'> = {
      database: await this.checkDatabase(),
    };

    // Merge additional checks from subclasses
    const extra = await this.getAdditionalChecks();
    Object.assign(checks, extra);

    const hasError = Object.values(checks).some((v) => v === 'error');
    const allError = Object.values(checks).every((v) => v === 'error');

    let status: ReadinessResponse['status'];
    if (allError) {
      status = 'not_ready';
    } else if (hasError) {
      status = 'degraded';
    } else {
      status = 'ok';
    }

    const httpStatus = status === 'not_ready' ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK;

    const body: ReadinessResponse = { status, checks: checks as ReadinessResponse['checks'] };
    res.status(httpStatus).json(body);
  }

  /**
   * General Health Endpoint.
   * Returns sanitized health information (no memory, connection counts, etc.).
   * Safe for public exposure.
   *
   * ADR-013 Section 8.4: Includes framework version info so operators can
   * identify whether a running service is NestJS v10 or v11 during phased
   * upgrade rollouts. The `framework` block exposes NestJS core version,
   * Express adapter version, and Node.js runtime version.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  health(): StandardHealthResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: this.version,
      service: this.serviceName,
      framework: {
        nestjs: nestPackage.version,
        express: expressPackage.version,
        node: process.version,
      },
    };
  }

  /**
   * Check database connectivity using a real query.
   * Subclasses should NOT override this; use getAdditionalChecks() instead.
   */
  protected async checkDatabase(): Promise<'ok' | 'error'> {
    try {
      if (!this.dataSource.isInitialized) {
        return 'error';
      }
      await this.dataSource.query('SELECT 1');
      return 'ok';
    } catch (error) {
      this.logger.warn(`Database health check failed: ${(error as Error).message}`);
      return 'error';
    }
  }

  /**
   * Override in subclasses to add service-specific readiness checks.
   * Return a map of check-name -> 'ok' | 'error'.
   *
   * @example
   * // In SensorHealthController:
   * protected async getAdditionalChecks() {
   *   return { timescale: await this.checkTimescale() };
   * }
   */
  protected getAdditionalChecks(): Promise<Record<string, 'ok' | 'error'>> {
    return Promise.resolve({});
  }
}
