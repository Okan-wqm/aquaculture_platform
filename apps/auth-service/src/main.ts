// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'auth-service',
  portEnvVar: 'AUTH_SERVICE_PORT',
  enableTelemetry: true,
  hasGraphQL: true,
  // SECURITY: cookie-parser required for httpOnly refresh token cookies
  earlyMiddleware: [cookieParser()],
  // CSP is handled by the edge nginx — auth-service sits behind gateway behind nginx
  helmetOptions: { contentSecurityPolicy: false },
  prefixExclusions: ['health', 'health/live', 'health/ready', 'metrics'],
});
