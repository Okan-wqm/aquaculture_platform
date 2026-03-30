/**
 * Config Service — Centralized configuration management for all platform services.
 *
 * Migrated to shared bootstrap factory (ADR-013 Phase 3).
 * Standard config: trust proxy, helmet, CORS, validation pipe, port resolution.
 * Custom config: additionalCorsHeaders includes 'X-Api-Key' for M2M authentication.
 */
import { bootstrapService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'config-service',
  portEnvVar: 'CONFIG_SERVICE_PORT',
  hasGraphQL: true,
  additionalCorsHeaders: ['X-Api-Key'],
});
