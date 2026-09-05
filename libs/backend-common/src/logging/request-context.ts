import { AsyncLocalStorage } from 'async_hooks';

/**
 * Immutable request context carried through the entire async call chain
 * via Node.js AsyncLocalStorage. Every log entry automatically picks up
 * these fields without the caller having to pass them explicitly.
 */
export interface RequestContext {
  /** W3C / OpenTelemetry trace ID (32-char hex) */
  traceId?: string;
  /** Correlation ID propagated via X-Correlation-Id header */
  correlationId?: string;
  /** Resolved tenant ID for multi-tenant isolation */
  tenantId?: string;
  /** Authenticated user ID (JWT sub claim) */
  userId?: string;
  /**
   * ADMIN-CRITICAL-008: the verified principal's email and MFA state, set by
   * the guard that verified the JWT — never by a request body. Audit writers
   * that derive the actor from this frame cannot be handed a client string.
   */
  userEmail?: string;
  mfaVerified?: boolean;
  /** Client User-Agent as received at the ingress. */
  userAgent?: string;
  /** OpenTelemetry span ID (16-char hex) */
  spanId?: string;
  /** HTTP method of the incoming request */
  method?: string;
  /** Request URL / path */
  url?: string;
  /** Client IP address */
  ip?: string;
  /**
   * Resolved PostgreSQL schema name for tenant isolation (e.g. "tenant_4b529829ea7948da").
   * Set by TenantSchemaMiddleware; consumed by TenantConnectionBootstrap to inject
   * SET search_path at the pool connection checkout level.
   */
  schemaName?: string;
  /**
   * RLS bypass flag for SUPER_ADMIN endpoints, background workers, and any
   * legitimately cross-tenant code path. When true, RlsConnectionBootstrap
   * sets `app.bypass_rls = 'on'` on the checked-out connection so the
   * tenant_isolation_policy USING clause grants full visibility.
   *
   * SECURITY: This flag must NEVER be set from a tenant-scoped request
   * handler. It is reserved for admin-api-service controllers (which
   * already authenticate as SUPER_ADMIN) and for cron/queue workers that
   * explicitly iterate tenants on their own.
   */
  bypassRls?: boolean;
}

/**
 * Global AsyncLocalStorage instance for request context.
 * Shared across the entire process so that any code path
 * (service, repository, logger, etc.) can retrieve the current
 * request context without injecting a request-scoped provider.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Retrieve the current request context, or an empty object if none is set.
 * Safe to call from any async context (timers, event handlers, etc.).
 */
export function getRequestContext(): RequestContext {
  return requestContextStorage.getStore() ?? {};
}
