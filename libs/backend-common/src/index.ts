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

// Config - Secret provider (Docker Secrets / file-backed env resolution)
export { readSecret, bootstrapSecrets } from './config/secrets.provider';

// Auth - Centralised JWT verification options + strict token type enforcement
// All guards MUST use getJwtVerifyOptions() and enforceAccessTokenType().
export { getJwtVerifyOptions, enforceAccessTokenType } from './auth/jwt-verification.utils';
export type { JwtVerifyConfig } from './auth/jwt-verification.utils';

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

// Security - Rate Limiting, Token Blacklist, Session Management, GDPR, etc.
export * from './security';

// Pagination - Standard pagination types and utilities
export * from './pagination';

// Health - Standard K8s health check controller and module
export * from './health';

// Audit - Shared audit trail infrastructure (interceptor, service, entity, module)
export * from './audit';

// NATS - Shared connection factory with SEC-H01 authentication support
export { buildNatsConnectionOptions, buildNatsTransportOptions } from './nats/nats-connection.factory';

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
