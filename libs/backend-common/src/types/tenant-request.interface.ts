import type { GatewayVerifiedUserAssertionV1 } from '@aquaculture/shared-contracts';
import { Request } from 'express';

/**
 * The gateway-signed verified-user assertion claims (ADR-015 / SEC-HIGH-156).
 * Emitted by gateway-api, verified by every tenant-scoped subgraph, and used
 * across guards, decorators, middleware, and repositories as the SSoT identity.
 */
export type VerifiedUserAssertion = GatewayVerifiedUserAssertionV1;

export interface VerifiedServiceIdentity {
  serviceName: string;
  tenantId: string;
  effectiveTenantId: string;
  keyId: string;
  audience?: string;
  nonce: string;
  version: 'v2';
}

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
  /**
   * SEC-HIGH-051: farm-service Site ids the user is assigned to (object-level
   * site authorization). Populated from the verified assertion / direct JWT.
   */
  assignedSiteIds?: string[];
  /**
   * SEC-HIGH-052: enabled mobile feature keys the user is entitled to. Read by
   * MobileFeatureGuard to enforce mobile entitlements server-side.
   */
  mobileFeatures?: string[];
  /**
   * SSOT-C-13: tenant plan tier ordinal (PLAN_LEVEL) for per-plan quota
   * enforcement. Populated from the verified assertion / direct JWT.
   */
  planLevel?: number;
  /**
   * MT-HIGH-054: tenant-RBAC capability strings (`resource:action`) the user is
   * granted. Populated from the verified assertion / direct JWT (SEC-HIGH-054).
   * Read by TenantPermissionGuard and programmatic hasResourcePermission checks.
   */
  resourcePermissions?: string[];
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
  /** HMAC-verified service caller identity. */
  verifiedIdentity?: VerifiedServiceIdentity;
  /** Gateway-minted business identity assertion. */
  verifiedUserAssertion?: VerifiedUserAssertion;
}
