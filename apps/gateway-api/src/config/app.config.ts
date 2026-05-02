import { registerAs } from '@nestjs/config';

/**
 * Application configuration
 * Centralizes all app-level settings
 */
export const appConfig = registerAs('app', () => ({
  // Server settings
  port: parseInt(process.env['PORT'] || '3000', 10),
  host: process.env['HOST'] || '0.0.0.0',
  nodeEnv: process.env['NODE_ENV'] || 'development',

  // API settings
  apiPrefix: process.env['API_PREFIX'] || 'api',
  apiVersion: process.env['API_VERSION'] || 'v1',

  // CORS settings
  cors: {
    enabled: process.env['CORS_ENABLED'] !== 'false',
    origins: process.env['CORS_ORIGINS']?.split(',') || ['http://localhost:5173'],
    credentials: process.env['CORS_CREDENTIALS'] === 'true',
  },

  // Request limits
  bodyLimit: process.env['BODY_LIMIT'] || '10mb',
  uploadLimit: process.env['UPLOAD_LIMIT'] || '50mb',

  // Timeouts (in milliseconds)
  requestTimeout: parseInt(process.env['REQUEST_TIMEOUT'] || '30000', 10),
  shutdownTimeout: parseInt(process.env['SHUTDOWN_TIMEOUT'] || '10000', 10),

  // Feature flags
  features: {
    // 2026-04-30: Deprecated GraphQL Playground is not exposed by config.
    // WHY: gateway developer UI policy must not advertise unsupported runtime behavior.
    introspection: process.env['NODE_ENV'] !== 'production',
    subscriptions: process.env['ENABLE_SUBSCRIPTIONS'] === 'true',
    federation: process.env['ENABLE_FEDERATION'] !== 'false',
  },

  // Logging
  logging: {
    level: process.env['LOG_LEVEL'] || 'info',
    format: process.env['LOG_FORMAT'] || 'json',
    prettyPrint: process.env['NODE_ENV'] !== 'production',
  },
}));

export type AppConfig = ReturnType<typeof appConfig>;
