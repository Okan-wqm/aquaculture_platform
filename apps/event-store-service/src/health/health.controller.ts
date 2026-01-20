import { Controller, Get } from '@nestjs/common';
import { HealthService, HealthStatus } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(): Promise<HealthStatus> {
    return this.healthService.check();
  }

  @Get('live')
  liveness(): { status: string } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<{ status: string }> {
    const health = await this.healthService.check();
    return {
      status: health.status === 'healthy' ? 'ok' : 'not ready',
    };
  }
}
