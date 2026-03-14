// Types - Canonical shared interfaces
export * from './types/tenant-request.interface';

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

// Database - Schema Manager and Tenant-Aware Repository
export * from './database';

// Redis
export * from './redis';

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
