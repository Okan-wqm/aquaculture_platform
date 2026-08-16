import { Controller, Get, HttpCode, HttpStatus, ServiceUnavailableException } from '@nestjs/common';

import { FeedingSchedulerTelemetryService } from './feeding-scheduler-telemetry.service';

@Controller('health')
export class FeedingSchedulerHealthController {
  constructor(private readonly telemetry: FeedingSchedulerTelemetryService) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  liveness(): { readonly status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<{
    readonly status: 'ok';
    readonly scheduler: Awaited<ReturnType<FeedingSchedulerTelemetryService['readHealth']>>;
  }> {
    try {
      const health = await this.telemetry.readHealth(new Date());
      if (!health.healthy) {
        throw new ServiceUnavailableException({ status: 'not_ready', scheduler: health });
      }
      return { status: 'ok', scheduler: health };
    } catch (error: unknown) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw new ServiceUnavailableException({
        status: 'not_ready',
        scheduler: { healthy: false },
      });
    }
  }
}
