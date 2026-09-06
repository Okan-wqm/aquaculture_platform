// WHY: MUST be first import. tslib.__metadata() silently no-ops if Reflect.metadata
// is not yet a function. In Docker production (Alpine, --omit=dev), the leaner module
// graph can cause @nestjs/common to be mid-evaluation when decorated classes load,
// meaning reflect-metadata hasn't executed yet. This guarantees it loads first.
import 'reflect-metadata';
import { VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';
import { assertProductionPosture } from './config/production-posture';
import { ADMIN_OPENAPI_OPTIONS } from './openapi/admin-openapi.options';

// INFRA-HIGH-142: a production process whose environment does not state the
// debug / explorer flags as 'false' (and, via the factory's edge bundle,
// TRUST_PROXY) does not start.
// Before the app exists, so a misconfigured deploy fails at the first log
// line instead of serving requests with an accidental posture.
assertProductionPosture();

bootstrapService(AppModule, {
  serviceName: 'admin-api-service',
  // ADR-0006: nginx upstream (infrastructure/nginx/droplet.conf). The factory
  // requires TRUST_PROXY in production and mounts the access log on every request.
  serviceVisibility: 'public',
  portEnvVar: 'PORT',

  // API Versioning — URI-based (e.g., /v1/tenants)
  // VERSION_NEUTRAL keeps existing unversioned routes working.
  versioning: {
    type: VersioningType.URI,
    defaultVersion: ['1', VERSION_NEUTRAL],
  },

  // Swagger UI — auto-disabled in production (SEC-L14). The same options
  // build the committed openapi.json artifact (CONTRACT-CRITICAL-003).
  swagger: ADMIN_OPENAPI_OPTIONS,

  helmetOptions: { crossOriginEmbedderPolicy: false },

  // Idempotency-Key: ADR-0014. Without it in Access-Control-Allow-Headers the
  // browser drops every admin billing mutation at the preflight.
  additionalCorsHeaders: ['X-Tenant-ID', 'X-Request-ID', 'Idempotency-Key'],
});
