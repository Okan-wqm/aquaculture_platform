/**
 * Hydroponics Service — Hydroponics system setup and configuration.
 *
 * Migrated to shared bootstrap factory (ADR-013 Phase 3).
 */
import { bootstrapService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'hydroponics-service',
  portEnvVar: 'HYDROPONICS_SERVICE_PORT',
  hasGraphQL: true,
  /** SEC-M12: Disable implicit type conversion to prevent type confusion attacks.
   *  Explicit @Type() decorators must be used on DTOs that need transformation. */
  validationPipeOverrides: { transformOptions: { enableImplicitConversion: false } },
});
