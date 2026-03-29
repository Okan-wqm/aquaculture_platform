/**
 * @module HealthModule
 * @description Provides liveness and readiness health check endpoints
 * for Kubernetes probes and load balancer health checks.
 * @see ADR-012 section 10 (Observability)
 */
import { Module } from '@nestjs/common';
import { PresenceModule } from '../presence/presence.module';
import { HealthController } from './health.controller';

@Module({
  imports: [PresenceModule],
  controllers: [HealthController],
})
export class HealthModule {}
