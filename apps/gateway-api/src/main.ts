// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { GATEWAY_MARINE_PREFIX_EXCLUSIONS } from './routes/marine.routes';
import { registerRedisIoAdapter } from './websocket/adapters/redis-io.adapter';

bootstrapService(AppModule, {
  serviceName: 'gateway-api',
  portEnvVar: 'GATEWAY_PORT',
  enableTelemetry: true,
  hasGraphQL: true,
  // Browser REST clients use /api as their base URL. MarineRoutesController
  // deliberately owns /api/marine, so exclude that explicit path from the
  // shared /api/v1 prefix instead of exposing the accidental
  // /api/v1/api/marine route.
  prefixExclusions: ['health', 'health/(.*)', 'metrics', ...GATEWAY_MARINE_PREFIX_EXCLUSIONS],

  // SECURITY: In production, v2 service-identity keyring signing is required for
  // authenticating inter-service requests. Without it, gateway subgraph requests
  // cannot produce audience-bound signatures.
  environmentGuards: [
    () => {
      if (
        process.env['NODE_ENV'] === 'production' &&
        (!process.env['SERVICE_IDENTITY_KEYRING'] || !process.env['SERVICE_IDENTITY_SIGNING_KID'])
      ) {
        throw new Error(
          'FATAL: SERVICE_IDENTITY_KEYRING and SERVICE_IDENTITY_SIGNING_KID must be set in production. ' +
            'Without them, inter-service authentication is disabled and attackers can ' +
            'spoof internal service headers to bypass authorization.',
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

  additionalCorsHeaders: [
    'X-Requested-With',
    'X-Impersonation-Token',
    'X-Impersonation-Session-Id',
  ],

  // BUG-05: HEAD /graphql returns 200 for mobile connectivity probes.
  // P-M6: Register the Redis-backed Socket.IO adapter so ALL Socket.IO
  //       namespaces (/messaging, /farms, /sensor-readings, /st-language)
  //       broadcast across horizontally scaled gateway-api pods. Without
  //       this, every @WebSocketGateway runs a pod-local in-memory
  //       adapter: a client connected to pod A misses any event whose
  //       NATS message landed on pod B — which silently breaks
  //       multi-pod production. The adapter must be registered BEFORE
  //       app.listen(), which is why this lives in onBeforeListen and
  //       not in a module provider.
  onBeforeListen: async (app) => {
    app.use('/graphql', (req: any, res: any, next: any) => {
      if (req.method === 'HEAD') {
        res.status(200).end();
        return;
      }
      next();
    });

    // ── Socket.IO Redis adapter ─────────────────────────────────────
    const logger = new Logger('GatewayBootstrap');
    const configService = app.get(ConfigService);
    const redisUrl = configService.get<string>('REDIS_URL') ?? process.env['REDIS_URL'];
    const isProduction =
      configService.get<string>('NODE_ENV') === 'production' ||
      process.env['NODE_ENV'] === 'production';

    if (redisUrl) {
      try {
        await registerRedisIoAdapter(app, redisUrl);
        logger.log('Socket.IO Redis adapter registered for all gateway namespaces');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (isProduction) {
          // FAIL-LOUD: in production, a Redis-less gateway-api is a
          // silently broken one — multi-pod broadcasts do not work, and
          // failures cascade into missed mortality/feeding/harvest
          // real-time updates across the farm domain. The correct
          // response is to refuse to start so the orchestrator retries
          // or an operator intervenes. Dev can tolerate the fallback.
          throw new Error(
            `FATAL: Socket.IO Redis adapter failed to connect in production: ${message}. ` +
              `REDIS_URL was set but the gateway could not reach Redis. ` +
              `Refusing to start — multi-pod Socket.IO broadcast would be broken otherwise.`,
          );
        }
        logger.warn(
          `Socket.IO Redis adapter failed to connect (dev fallback to in-memory): ${message}`,
        );
      }
    } else if (isProduction) {
      // FAIL-LOUD: missing REDIS_URL in production is the same silent
      // break — refuse to start. Mirrors the existing pattern for
      // WS_CORS_ORIGINS and SERVICE_IDENTITY_KEYRING (see
      // environmentGuards above).
      throw new Error(
        'FATAL: REDIS_URL must be set in production — Socket.IO Redis adapter requires it for horizontal-scale broadcast. ' +
          'Without it, @WebSocketGateway namespaces run an in-memory adapter and multi-pod broadcasts are silently pod-local, ' +
          'causing clients on peer pods to miss real-time events.',
      );
    } else {
      logger.warn(
        'REDIS_URL not configured — Socket.IO running with in-memory adapter (single-instance only, dev mode).',
      );
    }
  },
});
