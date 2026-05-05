/**
 * @aquaculture/backend-common/middleware
 *
 * NestJS middleware: tenant context, correlation-id, request logging,
 * tenant schema.
 *
 * WHY explicit named exports: the middleware module has a local
 * `TenantRequest` extension that would collide with the canonical
 * `TenantRequest` from `types/tenant-request.interface`. Consumers that
 * need the extended shape (with tenantContext) deep-import the middleware
 * file; the barrel only exposes the classes + DI payload types.
 */

export {
  UserPayload,
  TenantContext,
  UserContextMiddleware,
  TenantContextMiddleware,
  TraceContext,
  TracedRequest,
  CorrelationIdMiddleware,
  RequestLoggingMiddleware,
} from './tenant-context.middleware';

export { createTenantSchemaMiddleware } from './tenant-schema.middleware';

// Strip-internal-headers middleware (SEC-CRITICAL-002 / SECREV-CRITICAL-002).
// Canonical, cross-service. Mount FIRST in every service's AppModule
// before any auth middleware so forged x-user-payload / x-tenant-id
// headers cannot survive into UserContextMiddleware.
export { StripInternalHeadersMiddleware } from './strip-internal-headers.middleware';

// AUDITTRAIL-HIGH-004 cure: low-level HTTP access log middleware.
// Mount in every service's AppModule on `forRoutes('*')` so every
// HTTP request emits a row to shared.access_logs (request-level
// forensic stream, distinct from the semantic-action audit_logs).
export { AccessLogMiddleware } from './access-log.middleware';
