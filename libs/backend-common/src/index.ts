// Types - Canonical shared interfaces
export * from './types/tenant-request.interface';

// Tenant - Shared tenant-scoped constants (GLOBAL_TENANT_UUID, etc.)
export * from './tenant/constants';

// Decorators
export * from './decorators/tenant.decorator';
export * from './decorators/current-user.decorator';
export * from './decorators/roles.decorator';
export * from './decorators/cacheable.decorator';
export * from './decorators/require-permission.decorator';

// Guards
export * from './guards/roles.guard';
export * from './guards/tenant.guard';
export * from './guards/tenant-permission.guard';
export * from './guards/service-identity.guard';
export * from './guards/token-revocation.service';

// Utils - Inter-service authentication
export * from './utils/service-identity.util';

// HTTP - Signed internal HTTP client (HMAC-signed + tenant-bound headers)
export * from './http/signed-http-client';
export * from './http/resolve-tenant-id.util';

// Config - Secret provider (Docker Secrets / file-backed env resolution)
export { readSecret, bootstrapSecrets } from './config/secrets.provider';

// Auth - Centralised JWT verification options + strict token type enforcement
// All guards MUST use getJwtVerifyOptions() and enforceAccessTokenType().
export { getJwtVerifyOptions, enforceAccessTokenType } from './auth/jwt-verification.utils';
export type { JwtVerifyConfig } from './auth/jwt-verification.utils';

// Auth - Shared RS256 JwtModule wiring for all token-CONSUMER services.
// Token ISSUER (auth-service) keeps its own JwtModule block; every other
// service must import PlatformJwtModule and never hand-roll JwtModule.
export { PlatformJwtModule } from './auth/platform-jwt.module';

// Auth - Password hashing with HMAC pepper + legacy lazy-migration path.
export { hashPassword, verifyPassword, PEPPERED_PREFIX_V1 } from './auth/password.util';
export type { VerifyPasswordResult } from './auth/password.util';

// Utils - PII masking for GDPR-compliant logging
export { maskEmail, logSafeUserId, maskPhone, maskPii, maskPiiDeep } from './utils/pii-mask.util';

// Utils - HMAC tenant hash for GDPR Art 17 cascade-safe pseudonymisation.
// Every table/event that persists a tenant identifier beyond tenant lifetime
// must hash via this helper (not raw sha256, which is rainbow-table reversible).
// Prereq for db-migrate enterprise-refactor plan Phase 0 observability schema.
// See docs/adr/022-pseudonymisation-key-management.md.
export {
  TENANT_HASH_PEPPER_ENV,
  hmacTenantHash,
  tenantHashesEqual,
  assertTenantHashPepperSet,
} from './utils/hmac-tenant-hash.util';

// Filters
export * from './filters/http-exception.filter';

// Middleware - includes TenantContextMiddleware, CorrelationIdMiddleware, RequestLoggingMiddleware
// Note: TenantRequest is excluded here; the canonical TenantRequest is exported from
// './types/tenant-request.interface' above. The middleware's extended TenantRequest
// (which adds tenantContext) is available by importing directly from the middleware file.
export {
  UserPayload,
  TenantContext,
  UserContextMiddleware,
  TenantContextMiddleware,
  TraceContext,
  TracedRequest,
  CorrelationIdMiddleware,
  RequestLoggingMiddleware,
} from './middleware/tenant-context.middleware';

// Tenant Schema Middleware (centralized factory)
export { createTenantSchemaMiddleware } from './middleware/tenant-schema.middleware';

// Database - Schema Manager and Tenant-Aware Repository
export * from './database';

// Redis
export * from './redis';

// Context - Tenant context for non-HTTP paths (MQTT, cron, NATS handlers)
export { withTenantContext } from './context/with-tenant-context';

// Logging - Structured JSON logger, request context, and middleware
export * from './logging';

// Telemetry
export * from './telemetry';

// Metrics - Per-service Prometheus metrics (module, middleware, controller)
export * from './metrics';

// Finding registry - NestJS wrapper over event_store.findings (Phase 12.1b)
//
// IMPORTANT (DEFECT-1, INFRA-CRITICAL-021): the FindingRegistry entity +
// service + module are NOT re-exported from the main backend-common barrel
// because their import chain reaches `finding.entity.ts`, whose `@Entity()`
// decorator side-effect would otherwise register `event_store.findings` in
// TypeORM's global metadata storage on every backend-common consumer —
// surfacing as cross-service drift in the SchemaDriftValidator output of
// every farm/sensor/auth/etc. service that has nothing to do with findings.
//
// Consumers that DO need finding registry access import via the deep path:
//   import { FindingRegistryModule } from '@aquaculture/backend-common/finding-registry';
//
// (Path alias defined in tsconfig.base.json.)

// Orchestrator leader election - Redis Redlock-lite (Phase 12.2)
export * from './orchestrator-leader-election';

// Orchestrator rate limit - Claude API token budget + 429 breaker (Phase 12.4)
export * from './orchestrator-rate-limit';

// Security - Rate Limiting, Token Blacklist, Session Management, GDPR, etc.
export * from './security';

// Pagination - Standard pagination types and utilities
export * from './pagination';

// Health - Standard K8s health check controller and module
export * from './health';

// Audit - Shared audit trail infrastructure
//
// Only NON-entity-touching surface is re-exported here so that importing
// from `@aquaculture/backend-common` does not transitively load
// `audit-log.entity.ts` (whose @Entity decorator pollutes TypeORM's global
// metadata storage and surfaces as cross-service drift — DEFECT-1,
// INFRA-CRITICAL-021).
//
// Token-based DI contract — TenantGuard et al inject via this token.
export {
  AUDIT_LOG_SERVICE,
  AuditSeverity,
} from './audit/audit-log.tokens';
export type {
  IAuditLogService,
  CreateAuditEntryDto,
} from './audit/audit-log.tokens';
// @AuditedOperation() decorator + metadata key + options type (no entity).
export {
  AuditedOperation,
  AUDITED_OPERATION_KEY,
  AuditedOperationStatus,
} from './audit/audited-operation.decorator';
export type { AuditedOperationOptions } from './audit/audited-operation.decorator';
//
// Concrete classes (AuditLogEntity, AuditLogService, AuditLogModule,
// AuditLogInterceptor, AuditedOperationInterceptor, AuditedOperationModule)
// are deep-import only:
//   import { AuditLogModule } from '@aquaculture/backend-common/audit';
// (Path alias defined in tsconfig.base.json.)

// NATS - Shared connection factory with SEC-H01 authentication support
export { buildNatsConnectionOptions, buildNatsTransportOptions } from './nats/nats-connection.factory';
export type { NatsAuthMode } from './nats/nats-connection.factory';

// NATS - Tenant-validating consumer base class for cross-tenant isolation
export { TenantValidatingConsumer, TenantValidationResult } from './nats/tenant-validating-consumer';

// Constants - Shared NATS patterns and validation regexes
export { NATS_PATTERNS } from './constants/nats-patterns';
export {
  DEVICE_CODE_REGEX,
  TENANT_ID_REGEX,
  UUID_REGEX,
  VALIDATION_PATTERNS,
} from './constants/validation-patterns';

// Decorators - Audit logging
export * from './decorators/audit-log.decorator';

// Bootstrap - Shared NestJS application factory (eliminates main.ts duplication)
export * from './bootstrap';

// Monitoring - Legacy token metrics for JWT sunset tracking
export * from './monitoring';

// WebSocket - Shared CORS config helper with production fail-closed policy
export * from './websocket';

// Monetary - Immutable Money value object with Decimal.js precision
// Replaces parseFloat()-based DecimalTransformer for all financial arithmetic
export * from './monetary';
