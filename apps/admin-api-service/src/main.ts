// WHY: MUST be first import. tslib.__metadata() silently no-ops if Reflect.metadata
// is not yet a function. In Docker production (Alpine, --omit=dev), the leaner module
// graph can cause @nestjs/common to be mid-evaluation when decorated classes load,
// meaning reflect-metadata hasn't executed yet. This guarantees it loads first.
import 'reflect-metadata';
import { VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'admin-api-service',
  portEnvVar: 'PORT',

  // NATS microservice transport. admin-api-service is a hybrid app: it serves
  // HTTP (the admin REST surface) AND consumes platform events over NATS —
  // TenantOnboardingAckHandler subscribes to events.*.TenantOnboardingAck /
  // .TenantOnboardingFailed (PLATFORM_EVENT_REGISTRY declares admin-api-service
  // as their consumer). Without this transport the @EventPattern handlers are
  // dead code and the tenant-provisioning saga never receives the acks it waits
  // on. Identity is the broker-verified mTLS cert CN (ADR-015); no user/pass.
  // Enforced by tests/invariants/event-consumer-liveness.spec.ts and the
  // orphaned-microservice-handler bootstrap guard in create-service-app.
  natsTransport: { queue: 'admin-api-service' },

  // API Versioning — URI-based (e.g., /v1/tenants)
  // VERSION_NEUTRAL keeps existing unversioned routes working.
  versioning: {
    type: VersioningType.URI,
    defaultVersion: ['1', VERSION_NEUTRAL],
  },

  // Swagger UI — auto-disabled in production (SEC-L14)
  swagger: {
    title: 'Aquaculture Admin API',
    description: 'Platform administration API for the Aquaculture SaaS platform',
    version: '1.0.0',
    path: 'docs',
  },

  helmetOptions: { crossOriginEmbedderPolicy: false },

  // APA-373: 'X-Impersonate-User' removed — a repo-wide grep proves nothing
  // reads it (impersonation runs through /impersonation REST + JWT, not a
  // header), so allow-listing it was misleading drift on a security surface.
  // X-Tenant-ID / X-Request-ID are already in DEFAULT_CORS_HEADERS; kept
  // explicit here for parity with the FE http-client's emitted headers.
  additionalCorsHeaders: [
    'X-Tenant-ID',
    'X-Request-ID',
  ],
});
