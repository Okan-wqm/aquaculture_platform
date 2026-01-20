import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SkipTenantGuard } from '@platform/backend-common';

/**
 * Health Controller
 * Provides health check endpoints for kubernetes probes
 */
@Controller('health')
@SkipTenantGuard()
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Liveness probe
   */
  @Get('live')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness probe
   */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<{ status: 'ok' | 'not_ready'; database: boolean }> {
    const isDbConnected = this.dataSource.isInitialized;

    if (!isDbConnected) {
      return { status: 'not_ready', database: false };
    }

    return { status: 'ok', database: true };
  }

  /**
   * Full health check
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  async health(): Promise<{
    status: 'ok';
    timestamp: string;
    uptime: number;
    database: boolean;
  }> {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: this.dataSource.isInitialized,
    };
  }
}
