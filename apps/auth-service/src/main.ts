// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';

import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'auth-service',
  // ADR-0006: reached only over the Docker network (gateway federation / NATS);
  // nginx proxies nothing here, so no CORS and no edge bundle.
  serviceVisibility: 'internal',
  portEnvVar: 'AUTH_SERVICE_PORT',
  enableTelemetry: true,
  hasGraphQL: true,
  // SECURITY: cookie-parser required for httpOnly refresh token cookies
  earlyMiddleware: [cookieParser()],
  // CSP is handled by the edge nginx — auth-service sits behind gateway behind nginx
  helmetOptions: { contentSecurityPolicy: false },
  prefixExclusions: ['health', 'health/live', 'health/ready', 'metrics'],
  // NATS microservice transport — exposes `request.auth.admin.*` message
  // patterns (see AuthAdminNatsHandler). This replaces the previous
  // admin-api-service → raw SQL INSERT/UPDATE path against `auth.users`
  // (CRITICAL-001), making column drift structurally impossible.
  natsTransport: { queue: 'auth-service' },
  secrets: [
    'JWT_PRIVATE_KEY',
    'PASSWORD_PEPPER',
    'MFA_ENCRYPTION_KEY',
    'SUPER_ADMIN_PASSWORD',
  ],
});
