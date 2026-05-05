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
