// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';

import { bootstrapService } from '@aquaculture/backend-common/bootstrap';

import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'billing-service',
  // ADR-0006: nginx upstream (infrastructure/nginx/droplet.conf). The factory
  // requires TRUST_PROXY in production and mounts the access log on every request.
  serviceVisibility: 'public',
  portEnvVar: 'BILLING_SERVICE_PORT',
  hasGraphQL: true,
  natsTransport: { queue: 'billing-service' },
  nestFactoryOptions: { rawBody: true, bodyParser: true },
  // Faz C (D7): mount the Stripe webhook controller at /webhooks/stripe (not
  // /api/v1/webhooks/stripe) so the gateway nginx `location = /webhooks/stripe`
  // proxies it verbatim (raw body → Stripe HMAC survives). The default
  // exclusions (health/metrics) are preserved; graphql is auto-added by the
  // bootstrap since hasGraphQL is true.
  prefixExclusions: ['health', 'health/(.*)', 'metrics', 'webhooks', 'webhooks/(.*)'],
});
