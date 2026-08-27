/**
 * backend-common root barrel — aggregates every sub-barrel for
 * back-compat with existing consumers (449 files import from this path
 * as of AUDIT-MEDIUM-005).
 *
 * NEW CODE should import from a specific subtree path instead:
 *   import { hashPassword } from '@aquaculture/backend-common/auth';
 *   import { TenantGuard } from '@aquaculture/backend-common/guards';
 *   import { maskPii } from '@aquaculture/backend-common/utils';
 *
 * Rationale: the root barrel re-exports ~20 subtrees, so every change in
 * any one of them invalidates every consumer of the root barrel, even
 * consumers that only use an unrelated subtree. Sub-barrel imports limit
 * TypeScript + bundler invalidation to the consumers that actually pull
 * from the changed subtree. See AUDIT-MEDIUM-005 + ADR-028 lib-creation
 * rubric.
 *
 * The two deliberately-NOT-re-exported subtrees remain deep-import-only:
 *   @aquaculture/backend-common/audit
 *   @aquaculture/backend-common/finding-registry
 *   @aquaculture/backend-common/ai-safety
 *   @aquaculture/backend-common/gdpr
 * These carry @Entity() decorators whose side-effect registers tables in
 * TypeORM's global metadata storage; re-exporting them from the root
 * barrel would pollute every backend-common consumer (DEFECT-1,
 * INFRA-CRITICAL-021). Consumers that need them import via the deep path.
 */

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
export * from './redis';
export * from './context';
export * from './logging';
export * from './telemetry';
export * from './metrics';
export * from './orchestrator-leader-election';
export * from './orchestrator-rate-limit';
export * from './security';
export * from './pagination';
export * from './health';

// Audit — DI-token-level exports only (see audit/audit-log.tokens);
// entity-touching classes remain deep-import-only to avoid TypeORM
// metadata pollution in unrelated services.
export {
  AUDIT_LOG_SERVICE,
  AuditMethod,
  AuditResult,
  AuditSeverity,
} from './audit/audit-log.tokens';
export type {
  IAuditLogService,
  CreateAuditEntryDto,
} from './audit/audit-log.tokens';
export {
  AuditedOperation,
  AUDITED_OPERATION_KEY,
  AuditedOperationStatus,
} from './audit/audited-operation.decorator';
export type { AuditedOperationOptions } from './audit/audited-operation.decorator';

export * from './nats';
export * from './constants';
export * from './bootstrap';
export * from './monitoring';
export * from './websocket';
export * from './monetary';
export * from './sensor';
export * from './event-dedup';
