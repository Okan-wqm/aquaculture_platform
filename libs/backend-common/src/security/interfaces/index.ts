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
   */
  add(jti: string, expiresAt: Date, reason?: string): Promise<void>;

  /**
   * Check if token is blacklisted
   */
  isBlacklisted(jti: string): Promise<boolean>;

  /**
   * Remove expired entries (maintenance)
   */
  cleanup(): Promise<number>;
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
  consents: Map<ConsentType, boolean>;
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

export interface SecurityEvent {
  id?: string;
  eventType: SecurityEventType;
  userId?: string;
  tenantId?: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

/**
 * Security Audit Logger Interface
 */
export interface ISecurityAuditLogger {
  log(event: SecurityEvent): Promise<void>;
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
export const TOKEN_BLACKLIST = 'TOKEN_BLACKLIST';
export const SESSION_MANAGER = 'SESSION_MANAGER';
export const IP_VALIDATOR = 'IP_VALIDATOR';
export const CONSENT_MANAGER = 'CONSENT_MANAGER';
export const GDPR_SERVICE = 'GDPR_SERVICE';
export const SECURITY_AUDIT_LOGGER = 'SECURITY_AUDIT_LOGGER';
