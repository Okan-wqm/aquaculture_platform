import { Module } from '@nestjs/common';

import { StandardHealthController } from './standard-health.controller';

/**
 * StandardHealthModule
 *
 * Import this module to get the standard health endpoints:
 *   GET /health/live   - K8s liveness probe
 *   GET /health/ready  - K8s readiness probe (database check)
 *   GET /health        - General health (timestamp, uptime, version)
 *
 * For services that need custom checks (e.g. TimescaleDB, NATS), extend
 * StandardHealthController and register your own HealthModule instead.
 */
@Module({
  controllers: [StandardHealthController],
})
export class StandardHealthModule {}
