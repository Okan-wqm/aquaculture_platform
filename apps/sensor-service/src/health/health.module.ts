import { Module } from '@nestjs/common';

import { HealthController } from './health.controller';

/**
 * Health Module
 * Provides health check endpoints for kubernetes probes
 */
@Module({
  controllers: [HealthController],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class HealthModule {}
