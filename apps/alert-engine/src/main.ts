/**
 * Alert Engine — Rules engine, risk scoring, escalation, notification dispatch.
 *
 * Migrated to shared bootstrap factory (ADR-013 Phase 3).
 */
import { bootstrapService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'alert-engine',
  portEnvVar: 'ALERT_ENGINE_PORT',
  hasGraphQL: true,
  validationPipeOverrides: { enableImplicitConversion: true },
});
