import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Response } from 'express';
import { Public, SkipTenantGuard } from '@platform/backend-common';

@Controller('health')
@Public()
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
  async readiness(@Res() res: Response): Promise<void> {
    let dbReady = false;
    try {
      if (this.dataSource.isInitialized) {
        await this.dataSource.query('SELECT 1');
        dbReady = true;
      }
    } catch {
      dbReady = false;
    }

    const status = dbReady ? 'ok' : 'not_ready';
    const httpStatus = dbReady ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    res.status(httpStatus).json({ status, database: dbReady });
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  health(): { status: 'ok' } {
    // Minimal response: uptime and database connectivity are omitted to prevent
    // reconnaissance. Detailed readiness is available via /health/ready (internal only).
    return { status: 'ok' };
  }
}
