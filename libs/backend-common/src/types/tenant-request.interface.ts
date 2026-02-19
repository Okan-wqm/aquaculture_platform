import { Request } from 'express';

/**
 * Minimal JWT user payload attached to the request by the auth guard.
 * This is the canonical shape used across guards, decorators, middleware, and repositories.
 */
export interface JwtUser {
  sub: string;
  tenantId?: string;
  roles?: string[];
  /** @deprecated Use `roles` array instead */
  role?: string;
}

/**
 * Canonical TenantRequest interface.
 *
 * A single authoritative definition of the augmented Express Request used
 * throughout the platform. Previously this interface was copy-pasted into:
 *  - guards/tenant.guard.ts
 *  - decorators/tenant.decorator.ts
 *  - database/tenant-aware.repository.ts
 *  - middleware/tenant-context.middleware.ts
 *
 * All four files now import from this location.
 */
export interface TenantRequest extends Request {
  /** Resolved tenant ID – set by TenantContextMiddleware or TenantGuard */
  tenantId?: string;
  /** Decoded JWT payload – set by JwtAuthGuard / UserContextMiddleware */
  user?: JwtUser;
}
