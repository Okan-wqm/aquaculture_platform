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
}

// ==================== Security Event Interfaces ====================

/**
 * Base security event — extends the platform BaseEvent with
 * security-specific fields common to all security events.
 */
export interface SecurityEventBase extends BaseEvent {
  /** The security event sub-type */
  securityEventType: SecurityEventType;
  /** Client IP address (if available) */
  ip?: string;
  /** Client User-Agent header */
  userAgent?: string;
  /** Arbitrary detail bag for event-type-specific data */
  details: Record<string, unknown>;
}

/**
 * Authentication login failed event.
 * Published when a login attempt fails (wrong password, user not found, account locked, etc.)
 */
export interface AuthLoginFailedEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.AUTH_LOGIN_FAILED;
  details: {
    email?: string;
    reason: string;
    failedAttempts?: number;
  };
}

/**
 * Authentication login success event.
 * Published when a user successfully logs in.
 */
export interface AuthLoginSuccessEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.AUTH_LOGIN_SUCCESS;
  details: {
    email?: string;
  };
}

/**
 * Token rejected event.
 * Published when a JWT token fails validation (expired, invalid signature, etc.)
 */
export interface AuthTokenRejectedEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.AUTH_TOKEN_REJECTED;
  details: {
    reason: string;
    jti?: string;
  };
}

/**
 * Token blacklisted event.
 * Published when a token or user's tokens are added to the blacklist.
 */
export interface AuthTokenBlacklistedEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.AUTH_TOKEN_BLACKLISTED;
  details: {
    reason: string;
    jti?: string;
    scope: 'token' | 'user';
  };
}

/**
 * Password reset event.
 * Published when a password is successfully reset.
 */
export interface AuthPasswordResetEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.AUTH_PASSWORD_RESET;
  details: {
    email?: string;
  };
}

/**
 * Rate limit exceeded event.
 * Published when a client exceeds the configured rate limit.
 */
export interface RateLimitExceededEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.RATE_LIMIT_EXCEEDED;
  details: {
    key: string;
    limit: number;
    windowMs: number;
    count: number;
  };
}

/**
 * CSP violation event.
 * Published when a browser reports a Content-Security-Policy violation.
 */
export interface CspViolationEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.CSP_VIOLATION;
  details: {
    documentUri?: string;
    violatedDirective?: string;
    effectiveDirective?: string;
    blockedUri?: string;
    disposition?: string;
    sourceFile?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

/**
 * Tenant access denied event.
 * Published when a user tries to access a resource in a different tenant.
 */
export interface TenantAccessDeniedEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.TENANT_ACCESS_DENIED;
  details: {
    requestedTenantId: string;
    reason: string;
  };
}

/**
 * Service identity rejected event.
 * Published when an inter-service identity verification fails.
 */
export interface ServiceIdentityRejectedEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.SERVICE_IDENTITY_REJECTED;
  details: {
    serviceName?: string;
    reason: string;
  };
}

/**
 * Suspicious activity event.
 * Published when heuristic checks flag anomalous behaviour.
 */
export interface SuspiciousActivityEvent extends SecurityEventBase {
  eventType: 'SecurityEvent';
  securityEventType: SecurityEventType.SUSPICIOUS_ACTIVITY;
  details: {
    description: string;
    [key: string]: unknown;
  };
}

// ==================== Type Union ====================

/**
 * Union type for all security events
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
  | SuspiciousActivityEvent;
