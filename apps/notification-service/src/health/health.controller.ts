import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException, Optional } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SmsService } from '../notification/services/sms.service';
import { PushService } from '../notification/services/push.service';

@Controller('health')
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @Optional() private readonly smsService?: SmsService,
    @Optional() private readonly pushService?: PushService,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<{
    status: 'ok';
    database: boolean;
    sms: { enabled: boolean; healthy: boolean } | null;
    push: { enabled: boolean; healthy: boolean } | null;
  }> {
    let dbHealthy = false;
    try {
      await this.dataSource.query('SELECT 1');
      dbHealthy = true;
    } catch {
      // DB is not reachable
    }

    const smsStatus = this.smsService
      ? this.smsService.getProviderStatus()
      : null;
    const pushStatus = this.pushService
      ? this.pushService.getProviderStatus()
      : null;

    // A provider is only considered unhealthy if it is enabled but unhealthy
    // (e.g. a misconfigured production provider). Disabled providers are fine.
    const smsHealthy = !smsStatus || !smsStatus.enabled || smsStatus.healthy;
    const pushHealthy = !pushStatus || !pushStatus.enabled || pushStatus.healthy;

    if (!dbHealthy || !smsHealthy || !pushHealthy) {
      throw new ServiceUnavailableException({
        status: 'not_ready',
        database: dbHealthy,
        sms: smsStatus ? { enabled: smsStatus.enabled, healthy: smsStatus.healthy } : null,
        push: pushStatus ? { enabled: pushStatus.enabled, healthy: pushStatus.healthy } : null,
      });
    }

    return {
      status: 'ok',
      database: true,
      sms: smsStatus ? { enabled: smsStatus.enabled, healthy: smsStatus.healthy } : null,
      push: pushStatus ? { enabled: pushStatus.enabled, healthy: pushStatus.healthy } : null,
    };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async health(): Promise<{
    status: 'ok';
    timestamp: string;
    uptime: number;
    database: boolean;
    sms: { provider: string; enabled: boolean; healthy: boolean } | null;
    push: { provider: string; enabled: boolean; healthy: boolean } | null;
  }> {
    let dbHealthy = false;
    try {
      await this.dataSource.query('SELECT 1');
      dbHealthy = true;
    } catch {
      // DB is not reachable
    }

    const smsStatus = this.smsService ? this.smsService.getProviderStatus() : null;
    const pushStatus = this.pushService ? this.pushService.getProviderStatus() : null;

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: dbHealthy,
      sms: smsStatus
        ? { provider: smsStatus.provider, enabled: smsStatus.enabled, healthy: smsStatus.healthy }
        : null,
      push: pushStatus
        ? { provider: pushStatus.provider, enabled: pushStatus.enabled, healthy: pushStatus.healthy }
        : null,
    };
  }
}
