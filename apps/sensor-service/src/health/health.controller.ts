import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { SkipTenantGuard } from '@platform/backend-common';
import { DataSource } from 'typeorm';

interface ExtensionQueryResult {
  extname: string;
}

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
   * Readiness probe - checks TimescaleDB connection
   */
  @Get('ready')
  @HttpCode(HttpStatus.OK)
  async readiness(): Promise<{
    status: 'ok' | 'not_ready';
    database: boolean;
    timescale: boolean;
  }> {
    const isDbConnected = this.dataSource.isInitialized;

    // Check if TimescaleDB extension is installed
    let isTimescaleReady = false;
    if (isDbConnected) {
      try {
        const result = await this.dataSource.query<ExtensionQueryResult[]>(
          "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'",
        );
        isTimescaleReady = result.length > 0;
      } catch {
        isTimescaleReady = false;
      }
    }

    if (!isDbConnected) {
      return { status: 'not_ready', database: false, timescale: false };
    }

    return {
      status: 'ok',
      database: true,
      timescale: isTimescaleReady,
    };
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
    timescale: boolean;
  }> {
    let timescale = false;
    try {
      const result = await this.dataSource.query<ExtensionQueryResult[]>(
        "SELECT extname FROM pg_extension WHERE extname = 'timescaledb'",
      );
      timescale = result.length > 0;
    } catch {
      // TimescaleDB not available
    }

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: this.dataSource.isInitialized,
      timescale,
    };
  }
}
