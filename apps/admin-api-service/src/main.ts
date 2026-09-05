// WHY: MUST be first import. tslib.__metadata() silently no-ops if Reflect.metadata
// is not yet a function. In Docker production (Alpine, --omit=dev), the leaner module
// graph can cause @nestjs/common to be mid-evaluation when decorated classes load,
// meaning reflect-metadata hasn't executed yet. This guarantees it loads first.
import 'reflect-metadata';
import { VersioningType, VERSION_NEUTRAL } from '@nestjs/common';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';
import { assertProductionPosture } from './config/production-posture';

// INFRA-HIGH-142: a production process whose environment does not state the
// debug / explorer flags as 'false' and TRUST_PROXY as set does not start.
// Before the app exists, so a misconfigured deploy fails at the first log
// line instead of serving requests with an accidental posture.
assertProductionPosture();

bootstrapService(AppModule, {
  serviceName: 'admin-api-service',
  portEnvVar: 'PORT',

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

  additionalCorsHeaders: ['X-Tenant-ID', 'X-Request-ID', 'X-Impersonate-User'],
});
