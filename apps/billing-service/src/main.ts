// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
/**
 * Billing Service — Subscription management, metered billing, invoicing.
 *
 * Migrated to shared bootstrap factory (ADR-013 Phase 3).
 * Custom config: rawBody enabled for Stripe webhook signature verification.
 */
import { bootstrapService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'billing-service',
  portEnvVar: 'BILLING_SERVICE_PORT',
  hasGraphQL: true,
  nestFactoryOptions: { rawBody: true, bodyParser: true },
});
