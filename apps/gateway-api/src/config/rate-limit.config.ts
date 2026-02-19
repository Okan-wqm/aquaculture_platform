import { registerAs } from '@nestjs/config';

/**
 * Rate limiting configuration
 * Protects against abuse and DoS attacks
 */
export const rateLimitConfig = registerAs('rateLimit', () => ({
  // Global rate limit settings
  enabled: process.env['RATE_LIMIT_ENABLED'] !== 'false',
  windowMs: parseInt(process.env['RATE_LIMIT_WINDOW_MS'] || '60000', 10), // 1 minute
  max: parseInt(process.env['RATE_LIMIT_MAX'] || '100', 10), // 100 requests per window

  // Storage backend
  store: {
    type: (process.env['RATE_LIMIT_STORE'] || 'memory') as 'memory' | 'redis',
    useRedis: process.env['RATE_LIMIT_USE_REDIS'] === 'true',
  },

  // Skip conditions
  skip: {
    healthChecks: process.env['RATE_LIMIT_SKIP_HEALTH'] !== 'false',
    internalRequests: process.env['RATE_LIMIT_SKIP_INTERNAL'] === 'true',
  },

  // Whitelist IPs (comma-separated)
  whitelist: process.env['RATE_LIMIT_WHITELIST']?.split(',').filter(Boolean) || [],

  // Per-endpoint limits (override global)
  endpoints: {
    // Authentication endpoints (stricter)
    login: {
      windowMs: parseInt(process.env['RATE_LIMIT_LOGIN_WINDOW_MS'] || '900000', 10), // 15 minutes
      max: parseInt(process.env['RATE_LIMIT_LOGIN_MAX'] || '5', 10), // 5 attempts
    },
    // Registration (very strict - prevent mass account creation)
    register: {
      windowMs: parseInt(process.env['RATE_LIMIT_REGISTER_WINDOW_MS'] || '900000', 10), // 15 minutes
      max: parseInt(process.env['RATE_LIMIT_REGISTER_MAX'] || '3', 10), // 3 attempts per 15 minutes
    },
    // Password reset (very strict)
    passwordReset: {
      windowMs: parseInt(process.env['RATE_LIMIT_RESET_WINDOW_MS'] || '3600000', 10), // 1 hour
      max: parseInt(process.env['RATE_LIMIT_RESET_MAX'] || '3', 10), // 3 attempts
    },
    // GraphQL mutations (moderate)
    mutations: {
      windowMs: parseInt(process.env['RATE_LIMIT_MUTATION_WINDOW_MS'] || '60000', 10), // 1 minute
      max: parseInt(process.env['RATE_LIMIT_MUTATION_MAX'] || '30', 10), // 30 mutations
    },
    // File uploads (strict)
    uploads: {
      windowMs: parseInt(process.env['RATE_LIMIT_UPLOAD_WINDOW_MS'] || '60000', 10), // 1 minute
      max: parseInt(process.env['RATE_LIMIT_UPLOAD_MAX'] || '10', 10), // 10 uploads
    },
  },

  // Response headers
  headers: {
    remaining: process.env['RATE_LIMIT_HEADER_REMAINING'] !== 'false',
    reset: process.env['RATE_LIMIT_HEADER_RESET'] !== 'false',
    total: process.env['RATE_LIMIT_HEADER_TOTAL'] !== 'false',
  },

  // Error response customization
  message: process.env['RATE_LIMIT_MESSAGE'] || 'Too many requests, please try again later.',
  statusCode: parseInt(process.env['RATE_LIMIT_STATUS_CODE'] || '429', 10),
}));

export type RateLimitConfig = ReturnType<typeof rateLimitConfig>;
