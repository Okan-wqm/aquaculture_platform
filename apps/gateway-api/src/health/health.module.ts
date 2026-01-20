import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Health Module
 * Provides health check endpoints for kubernetes probes
 * and service monitoring
 */
@Module({
  imports: [ConfigModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
