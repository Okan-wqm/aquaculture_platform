import { Controller, Get, HttpCode, HttpStatus, SetMetadata } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { SkipTenantGuard } from '@aquaculture/backend-common';

const Public = () => SetMetadata('isPublic', true);

@Controller('health')
@SkipTenantGuard()
@Public()
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
  async readiness(): Promise<{ status: 'ok' | 'not_ready'; database: boolean }> {
    return {
      status: this.dataSource.isInitialized ? 'ok' : 'not_ready',
      database: this.dataSource.isInitialized,
    };
  }

  // LOW-04: The unauthenticated root health endpoint must not expose internal
  // operational details (uptime, database connectivity). That information is
  // available on /health/ready, which is consumed by internal orchestrators.
  // Exposing database status to unauthenticated callers aids attacker timing.
  @Get()
  @HttpCode(HttpStatus.OK)
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
