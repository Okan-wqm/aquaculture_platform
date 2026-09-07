import { randomUUID } from 'crypto';

import type { ActAsAssertionClaims, VerifiedUserAssertion } from '../types/tenant-request.interface';

export interface GatewayVerifiedUserAssertionInput {
  readonly subject: string;
  readonly tenantId?: string | null;
  readonly effectiveTenantId?: string | null;
  readonly roles?: readonly string[];
  readonly email?: string | null;
  readonly mfaVerified?: boolean;
  readonly assertionId?: string;
  readonly issuedAt?: Date;
  /** SEC-HIGH-051: farm-service Site ids the user is assigned to. */
  readonly assignedSiteIds?: readonly string[];
  /** SEC-HIGH-052: enabled mobile feature keys the user is entitled to. */
  readonly mobileFeatures?: readonly string[];
  /** SSOT-C-13: tenant plan tier ordinal for per-plan quota enforcement. */
  readonly planLevel?: number;
  /**
   * MT-HIGH-054: tenant-RBAC capability strings (`resource:action`) the user is
   * granted. Threaded so subgraph @RequireTenantPermission / hasResourcePermission
   * checks work on the production gateway path (where req.user is rebuilt from
   * the assertion, not the raw JWT). Without this every non-admin fails closed.
   */
  readonly resourcePermissions?: readonly string[];
  /** ORPHAN-MEDIUM-319: gateway-resolved end-client IP (req.ip under TRUST_PROXY). */
  readonly clientIp?: string | null;
  /** ORPHAN-MEDIUM-319: end-client User-Agent as received by the gateway. */
  readonly clientUserAgent?: string | null;
  /** ADR-0007: cross-tenant act-as claims resolved by EffectiveTenantMiddleware. */
  readonly actAs?: ActAsAssertionClaims;
}

/**
 * Gateway-minted user assertion for internal farm-service calls.
 *
 * The assertion is not a replacement for service HMAC. It is bound into the
 * service-identity canonical input via X-Service-Assertion-Hash, then parsed by
 * farm only after service identity has verified the caller as gateway-api.
 */
export function buildGatewayVerifiedUserAssertion(
  input: GatewayVerifiedUserAssertionInput,
): string {
  const tenantId = input.tenantId ?? null;
  const assertion: VerifiedUserAssertion = {
    issuer: 'gateway-api',
    subject: input.subject,
    tenantId,
    effectiveTenantId: input.effectiveTenantId ?? tenantId,
    roles: [...(input.roles ?? [])],
    email: input.email ?? null,
    mfaVerified: input.mfaVerified === true,
    issuedAt: (input.issuedAt ?? new Date()).toISOString(),
    assertionId: input.assertionId ?? randomUUID(),
    // SEC-HIGH-051 / SEC-HIGH-052: carry the object-level authorization claims
    // into the HMAC-protected blob ONLY when present (mirrors the JWT's
    // length>0 ? : undefined shape). The assertionHash already covers the full
    // base64 body, so these added fields are integrity-protected with no
    // signing change. Managers carry no assignedSiteIds (they bypass).
    ...(input.assignedSiteIds && input.assignedSiteIds.length > 0
      ? { assignedSiteIds: [...input.assignedSiteIds] }
      : {}),
    ...(input.mobileFeatures && input.mobileFeatures.length > 0
      ? { mobileFeatures: [...input.mobileFeatures] }
      : {}),
    // SSOT-C-13: carry the plan tier ordinal into the HMAC-protected blob only
    // when present (platform SUPER_ADMIN tokens omit it). Integrity-protected by
    // the assertionHash with no signing change, same as the claims above.
    ...(typeof input.planLevel === 'number'
      ? { planLevel: input.planLevel }
      : {}),
    // MT-HIGH-054: carry tenant-RBAC capabilities into the HMAC-protected blob
    // only when present (admins carry none — they bypass). Integrity-protected by
    // the assertionHash with no signing change, same as the claims above.
    ...(input.resourcePermissions && input.resourcePermissions.length > 0
      ? { resourcePermissions: [...input.resourcePermissions] }
      : {}),
    // ORPHAN-MEDIUM-319: carry the gateway-resolved client network identity
    // into the HMAC-protected blob only when present. Integrity-protected by
    // the assertionHash with no signing change, same as the claims above.
    ...(input.clientIp ? { clientIp: input.clientIp } : {}),
    ...(input.clientUserAgent ? { clientUserAgent: input.clientUserAgent } : {}),
    // ADR-0007: carry the act-as justification into the HMAC-protected blob
    // only for a cross-tenant act-as, so subgraph audit rows record the actor's
    // home tenant, the reason and the ticket. Integrity-protected by the
    // assertionHash with no signing change, same as the claims above.
    ...(input.actAs
      ? {
          actAs: {
            homeTenantId: input.actAs.homeTenantId,
            reason: input.actAs.reason,
            ticket: input.actAs.ticket,
          },
        }
      : {}),
  };

  return Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url');
}
