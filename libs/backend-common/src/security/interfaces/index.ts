// Security Interfaces - Following Interface Segregation Principle (ISP)

/**
 * Rate Limiter Strategy Interface
 * Allows different rate limiting strategies (fixed window, sliding window, token bucket)
 */
export interface IRateLimiterStrategy {
  /**
   * Check if request should be allowed
   * @returns remaining requests count or -1 if blocked
   */
  consume(key: string, points?: number): Promise<RateLimitResult>;

  /**
   * Reset rate limit for a key
   */
  reset(key: string): Promise<void>;

  /**
   * Get current state without consuming
   */
  get(key: string): Promise<RateLimitResult | null>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: Date;
  retryAfter?: number;
}

/**
 * Token Blacklist Interface
 * Abstraction for access token invalidation
 */
export interface ITokenBlacklist {
  /**
   * Add token to blacklist
   * @param jti - JWT ID
   * @param expiresAt - Token expiration time (for cleanup)
   * @param reason - Optional reason for blacklisting
   */
  add(jti: string, expiresAt: Date, reason?: string): Promise<void>;

  /**
   * Check if token is blacklisted
   * @param jti - JWT ID to check
   */
  isBlacklisted(jti: string): Promise<boolean>;

  /**
   * Remove expired entries (maintenance)
   * @returns Number of entries cleaned up
   */
  cleanup(): Promise<number>;

  /**
   * Blacklist all tokens for a user (logout from all devices)
   * @param userId - User ID to blacklist tokens for
   * @param expiresAt - Expiration time for the blacklist entry
   * @param reason - Optional reason for blacklisting
   */
  blacklistUserTokens(userId: string, expiresAt: Date, reason?: string): Promise<void>;

  /**
   * Check if all user tokens are blacklisted
   * @param userId - User ID to check
   * @param tokenIssuedAt - Token issue time to compare against blacklist
   * @returns true if token was issued before user blacklist entry
   */
  isUserBlacklisted(userId: string, tokenIssuedAt: Date): Promise<boolean>;

  /**
   * Composite check: validates a token is not individually blacklisted
   * AND the user's tokens have not been bulk-invalidated.
   *
   * Auth guards MUST call this single method instead of calling
   * isBlacklisted() and isUserBlacklisted() separately, to ensure
   * both checks are always performed atomically.
   *
   * @param jti - JWT ID
   * @param userId - User ID from token
   * @param issuedAt - Token issued-at date
   * @returns true if the token is valid (not blacklisted), false if invalid
   */
  isValidToken(jti: string, userId: string, issuedAt: Date): Promise<boolean>;
}

/**
 * Session Manager Interface
 * Handles concurrent session limits and session tracking
 */
export interface ISessionManager {
  /**
   * Create a new session
   * @returns session ID
   */
  createSession(userId: string, metadata: SessionMetadata): Promise<string>;

  /**
   * Validate session is active
   */
  validateSession(sessionId: string): Promise<boolean>;

  /**
   * Get all active sessions for user
   */
  getUserSessions(userId: string): Promise<SessionInfo[]>;

  /**
   * Revoke a specific session
   */
  revokeSession(sessionId: string, reason?: string): Promise<void>;

  /**
   * Revoke all sessions for user
   */
  revokeAllSessions(userId: string, exceptSessionId?: string): Promise<number>;

  /**
   * Enforce concurrent session limit
   * Revokes oldest sessions if limit exceeded
   */
  enforceSessionLimit(userId: string, maxSessions: number): Promise<string[]>;
}

export interface SessionMetadata {
  ipAddress?: string;
  userAgent?: string;
  deviceId?: string;
  tenantId?: string;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  createdAt: Date;
  lastActivityAt: Date;
  expiresAt: Date;
  metadata: SessionMetadata;
  isActive: boolean;
}

/**
 * IP Validator Interface
 * Validates and extracts client IP addresses
 */
export interface IIpValidator {
  /**
   * Extract client IP from request with proxy support
   */
  extractClientIp(request: IpExtractionRequest): string;

  /**
   * Validate IP address format
   */
  isValidIp(ip: string): boolean;

  /**
   * Check if IP is in a trusted range
   */
  isTrustedProxy(ip: string): boolean;

  /**
   * Validate X-Forwarded-For header chain
   */
  validateForwardedFor(header: string, trustedProxies: string[]): string | null;
}

export interface IpExtractionRequest {
  ip?: string;
  headers: {
    'x-forwarded-for'?: string | string[];
    'x-real-ip'?: string | string[];
    'cf-connecting-ip'?: string;
    'true-client-ip'?: string;
  };
  connection?: {
    remoteAddress?: string;
  };
  socket?: {
    remoteAddress?: string;
  };
}

/**
 * Consent Manager Interface
 * GDPR/CCPA consent tracking
 */
export interface IConsentManager {
  /**
   * Record user consent
   */
  recordConsent(consent: ConsentRecord): Promise<string>;

  /**
   * Get current consent status for user
   */
  getConsentStatus(userId: string): Promise<ConsentStatus>;

  /**
   * Withdraw consent
   */
  withdrawConsent(userId: string, consentType: ConsentType, reason?: string): Promise<void>;

  /**
   * Get consent history for user
   */
  getConsentHistory(userId: string): Promise<ConsentRecord[]>;

  /**
   * Check if user has given specific consent
   */
  hasConsent(userId: string, consentType: ConsentType): Promise<boolean>;
}

export enum ConsentType {
  ESSENTIAL = 'essential',
  ANALYTICS = 'analytics',
  MARKETING = 'marketing',
  THIRD_PARTY = 'third_party',
  DATA_PROCESSING = 'data_processing',
  DATA_SHARING = 'data_sharing',
  PROFILING = 'profiling',
}

export interface ConsentRecord {
  id?: string;
  userId: string;
  tenantId?: string;
  consentType: ConsentType;
  granted: boolean;
  version: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp?: Date;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface ConsentStatus {
  userId: string;
  /** Record instead of Map for correct JSON serialization */
  consents: Record<ConsentType, boolean>;
  lastUpdated: Date;
  consentVersion: string;
}

/**
 * GDPR Data Subject Rights Interface
 */
export interface IGdprService {
  /**
   * Export all user data (Right to Access / Data Portability)
   */
  exportUserData(userId: string, format?: 'json' | 'csv'): Promise<DataExportResult>;

  /**
   * Delete all user data (Right to Erasure)
   */
  deleteUserData(userId: string, options?: DataDeletionOptions): Promise<DataDeletionResult>;

  /**
   * Anonymize user data (alternative to deletion)
   */
  anonymizeUserData(userId: string): Promise<void>;

  /**
   * Rectify user data (Right to Rectification)
   */
  rectifyUserData(userId: string, data: Record<string, unknown>): Promise<void>;

  /**
   * Restrict data processing
   */
  restrictProcessing(userId: string, reason: string): Promise<void>;

  /**
   * Get data processing status
   */
  getProcessingStatus(userId: string): Promise<ProcessingStatus>;
}

export interface DataExportResult {
  requestId: string;
  userId: string;
  format: string;
  data: Record<string, unknown>;
  generatedAt: Date;
  expiresAt: Date;
  downloadUrl?: string;
}

export interface DataDeletionOptions {
  /**
   * Controls deletion execution mode.
   *
   * - `true`  – Synchronous deletion: all user data is deleted within the
   *   current request/transaction before the caller receives a response.
   *   Use only for small datasets or in administrative/test contexts where
   *   latency is acceptable.
   *
   * - `false` (default) – Asynchronous/queued deletion: a deletion job is
   *   enqueued and the caller receives an immediate acknowledgement with a
   *   `requestId`. The actual deletion happens in the background. This is
   *   the recommended mode for production use as it prevents request
   *   timeouts and allows for audit trails and rollback windows.
   */
  immediate?: boolean;
  retainAuditLogs?: boolean;
  notifyThirdParties?: boolean;
}

export interface DataDeletionResult {
  requestId: string;
  userId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  deletedRecords: number;
  scheduledDeletionDate?: Date;
  errors?: string[];
}

export interface ProcessingStatus {
  userId: string;
  isRestricted: boolean;
  restrictedSince?: Date;
  reason?: string;
}

/**
 * Security Event Types for Audit
 */
export enum SecurityEventType {
  LOGIN_SUCCESS = 'login_success',
  LOGIN_FAILURE = 'login_failure',
  LOGOUT = 'logout',
  PASSWORD_CHANGE = 'password_change',
  PASSWORD_RESET_REQUEST = 'password_reset_request',
  PASSWORD_RESET_COMPLETE = 'password_reset_complete',
  MFA_ENABLED = 'mfa_enabled',
  MFA_DISABLED = 'mfa_disabled',
  SESSION_CREATED = 'session_created',
  SESSION_REVOKED = 'session_revoked',
  TOKEN_BLACKLISTED = 'token_blacklisted',
  RATE_LIMIT_EXCEEDED = 'rate_limit_exceeded',
  SUSPICIOUS_ACTIVITY = 'suspicious_activity',
  CONSENT_GRANTED = 'consent_granted',
  CONSENT_WITHDRAWN = 'consent_withdrawn',
  DATA_EXPORT_REQUESTED = 'data_export_requested',
  DATA_DELETION_REQUESTED = 'data_deletion_requested',
  ACCOUNT_LOCKED = 'account_locked',
  ACCOUNT_UNLOCKED = 'account_unlocked',
}

/** Security event input (pre-insert, no ID yet) */
export interface SecurityEventInput {
  eventType: SecurityEventType;
  userId?: string;
  tenantId?: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/** Security event (post-insert, always has ID) */
export interface SecurityEvent extends SecurityEventInput {
  id: string;
}

/**
 * Security Audit Logger Interface
 */
export interface ISecurityAuditLogger {
  log(event: SecurityEventInput): Promise<void>;
  query(filters: SecurityEventFilters): Promise<SecurityEvent[]>;
}

export interface SecurityEventFilters {
  userId?: string;
  tenantId?: string;
  eventTypes?: SecurityEventType[];
  startDate?: Date;
  endDate?: Date;
  severity?: ('low' | 'medium' | 'high' | 'critical')[];
  limit?: number;
  offset?: number;
}

// Injection Tokens
export const RATE_LIMITER_STRATEGY = 'RATE_LIMITER_STRATEGY';

/**
 * Canonical platform-wide token-blacklist DI symbol.
 *
 * # SEC-LOW-001 cross-reference
 *
 * apps/gateway-api/src/guards/redis-token-blacklist.store.ts has a
 * gateway-local `TOKEN_BLACKLIST_STORE` symbol that pre-dates this
 * canonical declaration. The two surfaces differ structurally
 * (gateway uses `exp: number`/Unix-seconds + composite
 * isValidToken check; canonical uses `exp: Date` + simpler
 * isBlacklisted). Consolidation is the SEC-LOW-001 follow-on,
 * blocked on SEC-MEDIUM-006's broader auth-blacklist
 * convergence. See the gateway-local declaration's class
 * docstring for the full divergence trace.
 */
export const TOKEN_BLACKLIST = 'TOKEN_BLACKLIST';
export const SESSION_MANAGER = 'SESSION_MANAGER';
export const IP_VALIDATOR = 'IP_VALIDATOR';
export const CONSENT_MANAGER = 'CONSENT_MANAGER';
export const GDPR_SERVICE = 'GDPR_SERVICE';
export const SECURITY_AUDIT_LOGGER = 'SECURITY_AUDIT_LOGGER';
