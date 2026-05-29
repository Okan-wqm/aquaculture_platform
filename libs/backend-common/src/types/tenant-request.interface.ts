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
  /**
   * Whether the user has completed MFA verification in the current session.
   * Set by the auth service when MFA challenge is successfully completed.
   * Used by TenantGuard to enforce MFA step-up for SUPER_ADMIN cross-tenant access
   * when MFA_REQUIRED_FOR_CROSS_TENANT=true.
   */
  mfaVerified?: boolean;
  /** User email address, decoded from JWT if present */
  email?: string;
}

export interface VerifiedServiceIdentity {
  serviceName: string;
  tenantId?: string;
  signatureVersion: 'v1' | 'v2';
  verifiedAt: string;
}

export interface FarmVerifiedIdentity {
  callerServiceName: string;
  actorUserId?: string;
  actorTenantId?: string;
  effectiveTenantId?: string;
  roles: string[];
  mfaVerified?: boolean;
  assertionId?: string;
  verifiedAt: string;
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
  /** HMAC-verified service identity attached by the service identity boundary. */
  verifiedIdentity?: VerifiedServiceIdentity;
  /** Unified farm identity built only from verified service/user assertions. */
  farmVerifiedIdentity?: FarmVerifiedIdentity;
}
