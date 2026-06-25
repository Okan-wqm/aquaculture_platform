import { Request } from 'express';

/**
 * The gateway-signed verified-user assertion claims (ADR-015 / SEC-HIGH-156).
 * Emitted by gateway-api, verified by every tenant-scoped subgraph, and used
 * across guards, decorators, middleware, and repositories as the SSoT identity.
 */
export interface VerifiedUserAssertion {
  issuer: 'gateway-api';
  subject: string;
  tenantId: string | null;
  effectiveTenantId: string | null;
  roles: string[];
  email: string | null;
  mfaVerified: boolean;
  issuedAt: string;
  assertionId?: string;
  /**
   * SEC-HIGH-051: farm-service Site ids the user is assigned to. Threaded from
   * the JWT `assignedSiteIds` claim through the HMAC-bound assertion so the
   * production gateway path exposes object-level site authorization data.
   */
  assignedSiteIds?: string[];
  /**
   * SEC-HIGH-052: enabled mobile feature keys
   * (`auth.mobile_user_settings.allowedFeatures`). Threaded from the JWT
   * `mobileFeatures` claim so MobileFeatureGuard can enforce entitlements.
   */
  mobileFeatures?: string[];
}

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
