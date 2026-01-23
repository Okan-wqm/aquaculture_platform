import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { SkipTenantGuard } from '@platform/backend-common';
import { DataSource } from 'typeorm';

@Controller('health')
@SkipTenantGuard()
export class HealthController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @HttpCode(HttpStatus.OK)
  readiness(): { status: 'ok' | 'not_ready'; database: boolean } {
    return {
      status: this.dataSource.isInitialized ? 'ok' : 'not_ready',
      database: this.dataSource.isInitialized,
    };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  health(): {
    status: 'ok';
    timestamp: string;
    uptime: number;
    database: boolean;
  } {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: this.dataSource.isInitialized,
    };
  }
}
