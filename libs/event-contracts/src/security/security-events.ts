import { BaseEvent } from '../base-event';

// ==================== Security Event Types ====================

/**
 * Security event type enum.
 * Values are NATS subjects under the `security.events.*` namespace.
 */
export enum SecurityEventType {
  AUTH_LOGIN_FAILED = 'security.events.auth.login.failed',
  AUTH_LOGIN_SUCCESS = 'security.events.auth.login.success',
  AUTH_TOKEN_REJECTED = 'security.events.auth.token.rejected',
  AUTH_TOKEN_BLACKLISTED = 'security.events.auth.token.blacklisted',
  AUTH_PASSWORD_RESET = 'security.events.auth.password.reset',
  RATE_LIMIT_EXCEEDED = 'security.events.ratelimit.exceeded',
  CSP_VIOLATION = 'security.events.csp.violation',
  TENANT_ACCESS_DENIED = 'security.events.tenant.access.denied',
  SERVICE_IDENTITY_REJECTED = 'security.events.service.identity.rejected',
  SUSPICIOUS_ACTIVITY = 'security.events.suspicious.activity',
  REFRESH_TOKEN_REUSE_DETECTED = 'security.events.auth.refresh.token.reuse.detected',
}

// ==================== Flat Security Event Interfaces ====================
// Each security event type has a dedicated eventType discriminator and
// explicit top-level fields. No nested `details` bag.

/**
 * Common security event fields — extends BaseEvent with security-specific
 * fields shared by all security events. No nested `details` bag.
 */
interface SecurityEventCommon extends BaseEvent {
  /** The security event sub-type for routing */
  securityEventType: SecurityEventType;
  /** Client IP address (if available) */
  ip?: string;
  /** Client User-Agent header */
  userAgent?: string;
  /**
   * SEC-MEDIUM-104 (2026-08-23 scan №49): publishing service identity.
   * The security-event plane is publishable by every service CN — without
   * attribution, a compromised service injects untraceable fake security
   * telemetry (fake SUSPICIOUS_ACTIVITY floods to mask a real one,
   * metric inflation). The publisher sets this from its own SERVICE_NAME
   * env (never trusts the event payload for it).
   */
  sourceService?: string;
}

/**
 * Authentication login failed event.
 * Published when a login attempt fails (wrong password, user not found, account locked, etc.)
 */
export interface AuthLoginFailedEvent extends SecurityEventCommon {
  eventType: 'AuthLoginFailed';
  securityEventType: SecurityEventType.AUTH_LOGIN_FAILED;
  /** Email of the failed login attempt */
  email?: string;
  /** Reason for the failure */
  reason: string;
  /** Number of consecutive failed attempts */
  failedAttempts?: number;
}

/**
 * Authentication login success event.
 * Published when a user successfully logs in.
 */
export interface AuthLoginSuccessEvent extends SecurityEventCommon {
  eventType: 'AuthLoginSuccess';
  securityEventType: SecurityEventType.AUTH_LOGIN_SUCCESS;
  /** Email of the user who logged in */
  email?: string;
}

/**
 * Token rejected event.
 * Published when a JWT token fails validation (expired, invalid signature, etc.)
 */
export interface AuthTokenRejectedEvent extends SecurityEventCommon {
  eventType: 'AuthTokenRejected';
  securityEventType: SecurityEventType.AUTH_TOKEN_REJECTED;
  /** Reason for the rejection */
  reason: string;
  /** JWT ID of the rejected token */
  jti?: string;
}

/**
 * Token blacklisted event.
 * Published when a token or user's tokens are added to the blacklist.
 */
export interface AuthTokenBlacklistedEvent extends SecurityEventCommon {
  eventType: 'AuthTokenBlacklisted';
  securityEventType: SecurityEventType.AUTH_TOKEN_BLACKLISTED;
  /** Reason for blacklisting */
  reason: string;
  /** JWT ID of the blacklisted token */
  jti?: string;
  /** Scope of the blacklist operation */
  scope: 'token' | 'user';
}

/**
 * Password reset event.
 * Published when a password is successfully reset.
 */
export interface AuthPasswordResetEvent extends SecurityEventCommon {
  eventType: 'AuthPasswordReset';
  securityEventType: SecurityEventType.AUTH_PASSWORD_RESET;
  /** Email of the user whose password was reset */
  email?: string;
}

/**
 * Rate limit exceeded event.
 * Published when a client exceeds the configured rate limit.
 */
export interface RateLimitExceededEvent extends SecurityEventCommon {
  eventType: 'RateLimitExceeded';
  securityEventType: SecurityEventType.RATE_LIMIT_EXCEEDED;
  /** Rate limit key (e.g. IP, userId, tenantId) */
  key: string;
  /** Configured limit */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Actual count that exceeded the limit */
  count: number;
}

/**
 * CSP violation event.
 * Published when a browser reports a Content-Security-Policy violation.
 */
export interface CspViolationEvent extends SecurityEventCommon {
  eventType: 'CspViolation';
  securityEventType: SecurityEventType.CSP_VIOLATION;
  /** URI of the document that violated the policy */
  documentUri?: string;
  /** The directive that was violated */
  violatedDirective?: string;
  /** The effective directive that was enforced */
  effectiveDirective?: string;
  /** The URI of the blocked resource */
  blockedUri?: string;
  /** Enforcement disposition (enforce or report) */
  disposition?: string;
  /** Source file where the violation occurred */
  sourceFile?: string;
  /** Line number of the violation */
  lineNumber?: number;
  /** Column number of the violation */
  columnNumber?: number;
}

/**
 * Tenant access denied event.
 * Published when a user tries to access a resource in a different tenant.
 */
export interface TenantAccessDeniedEvent extends SecurityEventCommon {
  eventType: 'TenantAccessDenied';
  securityEventType: SecurityEventType.TENANT_ACCESS_DENIED;
  /** The tenant ID the user attempted to access */
  requestedTenantId: string;
  /** Reason for the denial */
  reason: string;
}

/**
 * Service identity rejected event.
 * Published when an inter-service identity verification fails.
 */
export interface ServiceIdentityRejectedEvent extends SecurityEventCommon {
  eventType: 'ServiceIdentityRejected';
  securityEventType: SecurityEventType.SERVICE_IDENTITY_REJECTED;
  /** Name of the service whose identity was rejected */
  serviceName?: string;
  /** Reason for the rejection */
  reason: string;
}

/**
 * Suspicious activity event.
 * Published when heuristic checks flag anomalous behaviour.
 */
export interface SuspiciousActivityEvent extends SecurityEventCommon {
  eventType: 'SuspiciousActivity';
  securityEventType: SecurityEventType.SUSPICIOUS_ACTIVITY;
  /** Description of the suspicious activity */
  description: string;
  /** Heuristic score or risk level */
  riskScore?: number;
  /** Category of the suspicious activity */
  category?: string;
}

/**
 * Refresh-token reuse detected event.
 *
 * Published by auth-service when a refresh-token rotation observes a
 * presented token whose family has already been rotated (i.e. an earlier
 * rotation invalidated this token but it has now been presented again).
 * Per OAuth 2.0 best practice (RFC 8252 §6, draft-ietf-oauth-security-topics),
 * detected reuse means the original family has been compromised — the
 * receiver MUST invalidate the entire family + log out the affected user.
 *
 * WHY: Pre-fix the rotation path detected reuse but emitted no event,
 * leaving the security team blind to refresh-token theft attempts —
 * DATA-HIGH-002. Adding an explicit event lets observability/notification
 * services raise an alert + email the user about the suspicious sign-in.
 */
export interface RefreshTokenReuseDetectedEvent extends SecurityEventCommon {
  eventType: 'RefreshTokenReuseDetected';
  securityEventType: SecurityEventType.REFRESH_TOKEN_REUSE_DETECTED;
  /** User whose refresh-token family was reused. */
  userId: string;
  /** Refresh-token family identifier (one family per user-device pair). */
  familyId: string;
  /** Whether the family was successfully invalidated post-detection. */
  familyRevoked: boolean;
  /** Number of tokens revoked when the family was nuked. */
  tokensRevokedCount: number;
}

// ==================== Type Union ====================

/**
 * Union type for all security events.
 * Each member has a unique eventType discriminator for stable schema-based routing.
 */
export type SecurityEvent =
  | AuthLoginFailedEvent
  | AuthLoginSuccessEvent
  | AuthTokenRejectedEvent
  | AuthTokenBlacklistedEvent
  | AuthPasswordResetEvent
  | RateLimitExceededEvent
  | CspViolationEvent
  | TenantAccessDeniedEvent
  | ServiceIdentityRejectedEvent
  | SuspiciousActivityEvent
  | RefreshTokenReuseDetectedEvent;
