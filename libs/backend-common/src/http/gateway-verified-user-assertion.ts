import { randomUUID } from 'crypto';

import type { VerifiedUserAssertion } from '../types/tenant-request.interface';

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
  };

  return Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url');
}
