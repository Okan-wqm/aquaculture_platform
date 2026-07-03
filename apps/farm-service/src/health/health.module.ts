import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { TenantSchemaReadinessService } from './tenant-schema-readiness.service';

/**
 * Health Module
 * Provides health check endpoints for kubernetes probes.
 *
 * Registers TenantSchemaReadinessService so the readiness probe can verify
 * tenant-schema routing topology (source-schema completeness + a bounded
 * single-tenant sync sample) on top of the standard `SELECT 1` DB check.
 */
@Module({
  controllers: [HealthController],
  providers: [TenantSchemaReadinessService],
})
export class HealthModule {}
