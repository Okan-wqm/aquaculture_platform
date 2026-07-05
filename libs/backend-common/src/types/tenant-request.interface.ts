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
  /**
   * SSOT-C-13: the tenant's plan tier ordinal (canonical PLAN_LEVEL: FREE/TRIAL=0,
   * STARTER=1, PROFESSIONAL=2, ENTERPRISE=3). Threaded from the JWT `planLevel`
   * claim so resource-create handlers can enforce per-plan quotas without a
   * cross-service tenant lookup. Absent for platform SUPER_ADMIN tokens.
   */
  planLevel?: number;
  /**
   * MT-HIGH-054: tenant-RBAC capability strings (`resource:action`) the user is
   * granted. Threaded from the JWT `resourcePermissions` claim so subgraph
   * @RequireTenantPermission / hasResourcePermission checks work on the
   * production gateway path (req.user is rebuilt from the assertion, not the raw
   * JWT). Absent for admins (they bypass) and ungranted users.
   */
  resourcePermissions?: string[];
  /**
   * ORPHAN-MEDIUM-319: the gateway-resolved end-client IP (nginx → gateway
   * `req.ip` under TRUST_PROXY). Threaded through the HMAC-bound assertion so
   * subgraph audit rows / lastLoginIp record the ACTUAL actor instead of the
   * gateway container IP. Integrity-protected by X-Service-Assertion-Hash —
   * no signing change (same mechanism as assignedSiteIds / planLevel).
   */
  clientIp?: string | null;
  /**
   * ORPHAN-MEDIUM-319: the end-client User-Agent as received by the gateway.
   * The subgraph's own `user-agent` header is the gateway's internal fetcher
   * (minipass-fetch), useless for forensics.
   */
  clientUserAgent?: string | null;
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
  /**
   * SSOT-C-13: tenant plan tier ordinal (PLAN_LEVEL) for per-plan quota
   * enforcement. Populated from the verified assertion / direct JWT.
   */
  planLevel?: number;
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
