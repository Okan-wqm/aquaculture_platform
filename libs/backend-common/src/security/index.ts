// Security Module - Comprehensive security utilities for NestJS
// Following SOLID principles and best practices

// SEC-L15: Centralized sensitive field constants for consistent PII redaction
export * from './security-constants';

// Interfaces and Types
export * from './interfaces';

// Main Security Module
export * from './security.module';

// Throttler (Rate Limiting)
export * from './throttler';

// Token Blacklist (Access Token Invalidation)
export * from './token-blacklist';

// Session Manager (Concurrent Session Limits)
export * from './session-manager';

// Timing Safe Utilities (Timing Attack Protection)
export * from './timing-safe';

// IP Validation (X-Forwarded-For, Proxy Support)
export * from './ip-validation';

// Validators (Input Validation, IDOR Protection)
export * from './validators';

// GDPR Compliance (Consent Management, Data Subject Rights)
export * from './gdpr';

// Encryption - AES-256-GCM column-level encryption for PII at rest
export * from './encryption';

// Security Event Service (Audit logging for security events)
export * from './security-event.service';
