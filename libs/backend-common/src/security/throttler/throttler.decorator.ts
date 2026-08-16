import { SetMetadata } from '@nestjs/common';

/**
 * Throttle configuration metadata key
 */
export const THROTTLE_KEY = 'THROTTLE_CONFIG';
export const THROTTLE_SKIP_KEY = 'THROTTLE_SKIP';

/**
 * Throttle configuration options
 */
export interface ThrottleOptions {
  /**
   * Maximum number of requests allowed in the time window
   */
  limit: number;

  /**
   * Time window in seconds
   */
  ttl: number;

  /**
   * Optional key prefix for different rate limit buckets
   * e.g., 'login', 'api', 'upload'
   */
  keyPrefix?: string;

  /**
   * Whether to use IP-based rate limiting instead of user-based
   * @default false
   */
  byIp?: boolean;

  /**
   * Whether to apply stricter limits for anonymous users
   * @default true
   */
  strictAnonymous?: boolean;

  /**
   * Custom error message
   */
  errorMessage?: string;
}

/**
 * Default throttle configurations for common use cases
 */
export const ThrottleDefaults = {
  /**
   * Standard API rate limit
   * 100 requests per minute
   */
  API: { limit: 100, ttl: 60 },

  /**
   * Strict rate limit for login attempts
   * 5 attempts per 15 minutes
   */
  LOGIN: { limit: 5, ttl: 900, keyPrefix: 'login', byIp: true },

  /**
   * Password reset rate limit
   * 3 attempts per hour
   */
  PASSWORD_RESET: { limit: 3, ttl: 3600, keyPrefix: 'pwd_reset', byIp: true },

  /**
   * Registration rate limit
   * 3 registrations per hour per IP
   */
  REGISTRATION: { limit: 3, ttl: 3600, keyPrefix: 'register', byIp: true },

  /**
   * File upload rate limit
   * 10 uploads per minute
   */
  UPLOAD: { limit: 10, ttl: 60, keyPrefix: 'upload' },

  /**
   * Email sending rate limit
   * 5 emails per minute
   */
  EMAIL: { limit: 5, ttl: 60, keyPrefix: 'email' },

  /**
   * Sensitive operations (MFA, password change)
   * 3 attempts per 5 minutes
   */
  SENSITIVE: { limit: 3, ttl: 300, keyPrefix: 'sensitive' },

  /**
   * Search/query operations
   * 30 requests per minute
   */
  SEARCH: { limit: 30, ttl: 60, keyPrefix: 'search' },

  /**
   * Export operations
   * 5 exports per hour
   */
  EXPORT: { limit: 5, ttl: 3600, keyPrefix: 'export' },
} as const;

/**
 * Throttle decorator - applies rate limiting to a route or controller
 *
 * @example
 * // Apply standard API throttle
 * @Throttle(ThrottleDefaults.API)
 * @Get('users')
 * getUsers() {}
 *
 * @example
 * // Apply custom throttle
 * @Throttle({ limit: 10, ttl: 60 })
 * @Post('action')
 * doAction() {}
 *
 * @example
 * // Apply login throttle (IP-based)
 * @Throttle(ThrottleDefaults.LOGIN)
 * @Post('login')
 * login() {}
 */
export function Throttle(options: ThrottleOptions): MethodDecorator & ClassDecorator {
  return SetMetadata(THROTTLE_KEY, options);
}

/**
 * Skip throttling for a specific route
 *
 * @example
 * @SkipThrottle()
 * @Get('health')
 * healthCheck() {}
 */
export function SkipThrottle(): MethodDecorator & ClassDecorator {
  return SetMetadata(THROTTLE_SKIP_KEY, true);
}

/**
 * Convenience decorator for login endpoints
 * Applies strict IP-based rate limiting
 */
export function ThrottleLogin(): MethodDecorator {
  return Throttle(ThrottleDefaults.LOGIN);
}

/**
 * Convenience decorator for registration endpoints
 */
export function ThrottleRegistration(): MethodDecorator {
  return Throttle(ThrottleDefaults.REGISTRATION);
}

/**
 * Convenience decorator for password reset endpoints
 */
export function ThrottlePasswordReset(): MethodDecorator {
  return Throttle(ThrottleDefaults.PASSWORD_RESET);
}

/**
 * Convenience decorator for sensitive operations
 */
export function ThrottleSensitive(): MethodDecorator {
  return Throttle(ThrottleDefaults.SENSITIVE);
}

/**
 * Convenience decorator for export operations
 */
export function ThrottleExport(): MethodDecorator {
  return Throttle(ThrottleDefaults.EXPORT);
}
