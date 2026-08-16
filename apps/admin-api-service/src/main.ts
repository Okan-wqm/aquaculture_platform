// WHY: MUST be first import. tslib.__metadata() silently no-ops if Reflect.metadata
// is not yet a function. In Docker production (Alpine, --omit=dev), the leaner module
// graph can cause @nestjs/common to be mid-evaluation when decorated classes load,
// meaning reflect-metadata hasn't executed yet. This guarantees it loads first.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { ADMIN_HTTP_ROUTE_POLICY } from '@platform/admin-http-contracts';
import { AppModule } from './app.module';
import { adminHttpBootstrapRouteOptions } from './bootstrap/admin-http-route-policy';

bootstrapService(AppModule, {
  serviceName: 'admin-api-service',
  portEnvVar: 'PORT',
  ...adminHttpBootstrapRouteOptions(ADMIN_HTTP_ROUTE_POLICY),

  // Swagger UI — auto-disabled in production (SEC-L14)
  swagger: {
    title: 'Aquaculture Admin API',
    description: 'Platform administration API for the Aquaculture SaaS platform',
    version: '1.0.0',
    path: 'docs',
  },

  helmetOptions: { crossOriginEmbedderPolicy: false },

  additionalCorsHeaders: [
    'X-Tenant-ID',
    'X-Request-ID',
  ],
});
