/**
 * Notification Service — Email, SMS, and push notification dispatch.
 * Event-driven only (no direct user-facing GraphQL).
 *
 * Migrated to shared bootstrap factory (ADR-013 Phase 3).
 */
import { bootstrapService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'notification-service',
  portEnvVar: 'NOTIFICATION_SERVICE_PORT',
  hasGraphQL: true,
  validationPipeOverrides: { enableImplicitConversion: true },
});
