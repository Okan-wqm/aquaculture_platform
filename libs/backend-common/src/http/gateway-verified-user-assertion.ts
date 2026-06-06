import { randomUUID } from 'crypto';

import type { FarmVerifiedIdentity } from '../types/tenant-request.interface';

export interface GatewayVerifiedUserAssertionInput {
  readonly subject: string;
  readonly tenantId?: string | null;
  readonly effectiveTenantId?: string | null;
  readonly roles?: readonly string[];
  readonly email?: string | null;
  readonly mfaVerified?: boolean;
  readonly assertionId?: string;
  readonly issuedAt?: Date;
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
  const assertion: FarmVerifiedIdentity = {
    issuer: 'gateway-api',
    subject: input.subject,
    tenantId,
    effectiveTenantId: input.effectiveTenantId ?? tenantId,
    roles: [...(input.roles ?? [])],
    email: input.email ?? null,
    mfaVerified: input.mfaVerified === true,
    issuedAt: (input.issuedAt ?? new Date()).toISOString(),
    assertionId: input.assertionId ?? randomUUID(),
  };

  return Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url');
}
