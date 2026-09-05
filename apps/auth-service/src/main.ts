// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';

import { readPlatformAdminMfaPolicy } from '@aquaculture/backend-common/security';
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
  // ADR-0011: the platform-admin MFA switch must parse before the app exists —
  // production refuses to boot without an explicit SUPER_ADMIN_MFA_ENFORCED_AT
  // ('detective' or an ISO-8601 date-time), so an omission cannot silently
  // disable the control.
  environmentGuards: [
    (): void => {
      readPlatformAdminMfaPolicy();
    },
  ],
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
