// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'gateway-api',
  portEnvVar: 'GATEWAY_PORT',
  enableTelemetry: true,
  hasGraphQL: true,

  // SECURITY: In production, INTERNAL_SERVICE_SECRET is required for authenticating
  // inter-service requests. Without it, any external client could forge internal
  // service headers and bypass auth.
  environmentGuards: [
    () => {
      if (
        process.env['NODE_ENV'] === 'production' &&
        !process.env['INTERNAL_SERVICE_SECRET']
      ) {
        throw new Error(
          'FATAL: INTERNAL_SERVICE_SECRET must be set in production. ' +
          'Without it, inter-service authentication is disabled and attackers can ' +
          'spoof internal service headers to bypass authorization. ' +
          'Generate a strong secret: openssl rand -base64 48',
        );
      }
    },
  ],

  nestFactoryOptions: { rawBody: false },

  // SECURITY: cookie-parser + body limits before helmet
  earlyMiddleware: [
    cookieParser(),
    json({ limit: process.env['REQUEST_JSON_LIMIT'] || '1mb' }),
    urlencoded({ limit: process.env['REQUEST_URLENCODED_LIMIT'] || '1mb', extended: true }),
  ],

  // CSP is handled by the edge nginx
  helmetOptions: {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin' as const },
    crossOriginResourcePolicy: { policy: 'same-origin' as const },
    dnsPrefetchControl: { allow: false },
    ieNoOpen: true,
  },

  additionalCorsHeaders: ['X-Requested-With', 'X-CSRF-Token'],

  // BUG-05: HEAD /graphql returns 200 for mobile connectivity probes.
  onBeforeListen: async (app) => {
    app.use('/graphql', (req: any, res: any, next: any) => {
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      next();
    });
  },
});
