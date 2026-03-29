/**
 * @module HealthController
 * @description Health check endpoints for liveness and readiness probes.
 * Checks database connectivity for readiness.
 * @see ADR-012 section 10 (Observability)
 */
import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ClientProxy } from '@nestjs/microservices';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../shared/redis.provider';

@Controller('health')
export class HealthController {
  constructor(
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redis?: Redis,
    @Optional()
    @Inject('NATS_SERVICE')
    private readonly natsClient?: ClientProxy,
  ) {}

  @Get('live')
  liveness() {
    return {
      status: 'ok',
      service: 'messaging-service',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async readiness() {
    const checks: Record<string, string> = {};

    // Database check
    try {
      await this.dataSource.query('SELECT 1');
      checks['database'] = 'ok';
    } catch {
      checks['database'] = 'error';
    }

    // Redis connectivity check
    try {
      if (this.redis) {
        await this.redis.ping();
        checks['redis'] = 'ok';
      } else {
        checks['redis'] = 'not_configured';
      }
    } catch {
      checks['redis'] = 'error';
    }

    // NATS connectivity check
    try {
      if (this.natsClient) {
        await this.natsClient.connect();
        checks['nats'] = 'ok';
      } else {
        checks['nats'] = 'not_configured';
      }
    } catch {
      checks['nats'] = 'error';
    }

    const allOk = Object.values(checks).every(
      (v) => v === 'ok' || v === 'not_configured',
    );

    return {
      status: allOk ? 'ok' : 'degraded',
      service: 'messaging-service',
      checks,
      timestamp: new Date().toISOString(),
    };
  }
}
