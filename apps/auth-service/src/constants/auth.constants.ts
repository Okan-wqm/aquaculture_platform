import { JWT_SECURITY_CONSTANTS } from '@aquaculture/backend-common/security';

/**
 * Security-related constants
 * SEC-L05: JWT_SECRET_MIN_LENGTH is imported from the shared backend-common library
 * to prevent divergence between auth-service, gateway-api, and admin-api-service.
 */
export const SECURITY_CONSTANTS = {
  /** Minimum length for JWT secret in characters (shared across all services) */
  JWT_SECRET_MIN_LENGTH: JWT_SECURITY_CONSTANTS.JWT_SECRET_MIN_LENGTH,

  /** bcrypt salt rounds for password hashing */
  BCRYPT_SALT_ROUNDS: 12,

  /** Minimum login duration in ms to prevent timing attacks */
  MIN_LOGIN_DURATION_MS: 200,

  /** Default JWT expiration time */
  DEFAULT_JWT_EXPIRES_IN: '15m',

  /** Default JWT expiration in seconds (15 minutes) */
  DEFAULT_JWT_EXPIRES_SECONDS: 900,

  /** Default max failed login attempts before lockout */
  DEFAULT_MAX_FAILED_ATTEMPTS: 5,

  /** Default lockout duration in minutes */
  DEFAULT_LOCKOUT_DURATION_MINUTES: 30,

  /** Default refresh token expiry in days (non-remembered / session login) */
  DEFAULT_REFRESH_TOKEN_EXPIRY_DAYS: 7,

  /**
   * Default refresh token expiry in days for a "remember me" session. When the
   * user opts in, the refresh cookie persists this long (vs a session cookie)
   * and the refresh-token row's expiresAt extends to match so the cookie never
   * outlives the row. Override via REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS.
   */
  DEFAULT_REMEMBER_ME_REFRESH_TOKEN_EXPIRY_DAYS: 30,

  /** Default max concurrent sessions per user */
  DEFAULT_MAX_SESSIONS_PER_USER: 5,
} as const;

/**
 * Tenant-related constants
 */
export const TENANT_CONSTANTS = {
  /** Trial period duration in days */
  TRIAL_PERIOD_DAYS: 14,

  /** Default max users for FREE plan */
  DEFAULT_MAX_USERS_FREE: 5,

  /** Default max users for STARTER plan */
  DEFAULT_MAX_USERS_STARTER: 20,

  /** Default max users for PROFESSIONAL plan */
  DEFAULT_MAX_USERS_PROFESSIONAL: 100,

  /** Default max users for ENTERPRISE plan */
  DEFAULT_MAX_USERS_ENTERPRISE: 1000,
} as const;

/**
 * SLA Configuration for Support Tickets
 */
export const SLA_CONFIG = {
  /** Response and resolution times in minutes by priority */
  CRITICAL: { response: 30, resolution: 240 },
  HIGH: { response: 60, resolution: 480 },
  MEDIUM: { response: 240, resolution: 1440 },
  LOW: { response: 480, resolution: 2880 },
} as const;

/**
 * Token-related constants
 */
export const TOKEN_CONSTANTS = {
  /** Token blacklist cleanup interval in ms (5 minutes) */
  BLACKLIST_CLEANUP_INTERVAL_MS: 300000,

  /** Max active tokens to check when using hashed refresh tokens */
  MAX_ACTIVE_REFRESH_TOKEN_CHECK: 10,

  /** Max revoked tokens to scan for refresh-token reuse detection */
  MAX_REVOKED_REFRESH_TOKEN_REUSE_CHECK: 5,

  /** Default invitation expiry in days */
  DEFAULT_INVITATION_EXPIRY_DAYS: 7,
} as const;

/**
 * HTTP Security Headers
 */
export const HTTP_SECURITY = {
  /** HSTS max age in seconds (1 year) */
  HSTS_MAX_AGE: 31536000,
} as const;

/**
 * MFA (Multi-Factor Authentication) constants
 */
export const MFA_CONSTANTS = {
  /** TOTP time step in seconds (RFC 6238) */
  TOTP_PERIOD: 30,

  /** Number of periods before/after current to accept (±1 = 30s tolerance) */
  TOTP_WINDOW: 1,

  /** Number of TOTP digits */
  TOTP_DIGITS: 6,

  /** Number of recovery codes to generate */
  RECOVERY_CODE_COUNT: 8,

  /** MFA token (intermediate JWT) TTL in seconds */
  MFA_TOKEN_TTL_SECONDS: 300, // 5 minutes

  /** Max failed MFA attempts before lockout */
  MFA_MAX_FAILED_ATTEMPTS: 5,

  /** MFA lockout duration in minutes */
  MFA_LOCKOUT_DURATION_MINUTES: 15,
} as const;

/**
 * Role hierarchy levels for permission checks
 */
export const ROLE_LEVELS = {
  SUPER_ADMIN: 100,
  TENANT_ADMIN: 70,
  MODULE_MANAGER: 50,
  MODULE_USER: 30,
  VIEWER: 10,
} as const;
