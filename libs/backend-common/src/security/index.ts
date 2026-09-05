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

// User Token Revocation (canonical user-level invalidation SSoT — RBAC-HIGH-001)
export * from './user-token-revocation';

// Session Manager (Concurrent Session Limits)
export * from './session-manager';

// Timing Safe Utilities (Timing Attack Protection)
export * from './timing-safe';

// ADR-0011: the platform-admin MFA switch every enforcement point reads.
export * from './platform-admin-mfa-policy';

// IP Validation (X-Forwarded-For, Proxy Support)
export * from './ip-validation';

// Validators (Input Validation)
export * from './validators';

// GDPR Compliance (Consent Management, Data Subject Rights)
//
// IMPORTANT (DEFECT-1, INFRA-CRITICAL-021): the GdprModule + service +
// entities (UserConsent, GdprDataRequest) are NOT re-exported from the
// security barrel because their import chain reaches `entities/*.entity.ts`,
// whose @Entity decorators would otherwise register `shared.user_consents`
// + `shared.gdpr_data_requests` in TypeORM's global metadata storage on
// every backend-common consumer — surfacing as cross-service drift on
// services that have nothing to do with GDPR.
//
// Interface tokens (IGdprService, IConsentManager, GDPR_SERVICE,
// CONSENT_MANAGER) live in `./interfaces` and are exported above.
//
// Concrete consumers deep-import:
//   import { GdprModule } from '@aquaculture/backend-common/gdpr';
// (Path alias defined in tsconfig.base.json.)

// Encryption - AES-256-GCM column-level encryption for PII at rest
export * from './encryption';

// Security Event Service (Audit logging for security events)
export * from './security-event.service';

// SEC-HIGH-050: canonical direct-namespace self-scope authorization SSoT
export * from './assert-self-scope';

// SEC-HIGH-051: canonical object-level site authorization SSoT
export * from './site-authorization.service';
