import type { Request } from 'express';

/**
 * @module ResolveTenantId
 *
 * Single canonical way to extract the tenant UUID from an incoming HTTP
 * request before signing an outbound internal fetch. Every callsite that
 * proxies/forwards a request to another internal service MUST use this —
 * inlining the logic invites drift.
 *
 * SECURITY (HIGH-003): the returned value is bound into the HMAC signature
 * via signedFetch. Returning an empty string is the explicit "no tenant
 * applies" opt-out — the signed contract covers "empty tenant", which
 * means downstream guards will verify against empty and reject any
 * request that later tries to inject a spoofed X-Tenant-ID.
 *
 * Resolution order:
 *   1. `req.farmVerifiedIdentity.effectiveTenantId` — gateway-signed
 *      effective tenant for farm/internal calls.
 *   2. `req.tenantId` — server-set tenant context from middleware/guard.
 *   3. `req.user.tenantId` — cryptographically verified JWT/assertion context.
 *   4. Empty string — "no tenant" is a valid, explicit answer.
 *
 * In all cases the value is validated against a canonical UUID regex.
 * Any malformed input yields an empty string, which fails closed: a
 * downstream guard receiving an unsigned or empty-tenant HMAC will not
 * grant tenant-scoped access.
 */

/** Canonical UUID v1-v5 regex — matches what the gateway's willSendRequest uses. */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow interface for the parts of Express Request we consult. Defined
 * locally so this utility does not depend on the full TenantRequest type
 * (which lives in a different module and pulls in tenant-context middleware
 * types — the tenant-resolving callsites should not require all of that).
 */
interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
  farmVerifiedIdentity?: { effectiveTenantId?: string | null } | null | undefined;
  tenantId?: string | null | undefined;
  user?: { tenantId?: string | null } | null | undefined;
}

/**
 * Resolve the tenant UUID for signing an outbound internal fetch.
 *
 * @returns the validated tenant UUID, or `''` when no tenant context
 *          applies. Callers pass the result directly into `signedFetch`'s
 *          REQUIRED `tenantId` option.
 */
export function resolveTenantIdFromRequest(req: RequestLike | Request): string {
  const request = req as RequestLike;
  const candidates = [
    request.farmVerifiedIdentity?.effectiveTenantId,
    request.tenantId,
    request.user?.tenantId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && UUID_REGEX.test(candidate.trim())) {
      return candidate.trim();
    }
  }

  // No valid tenant — explicit opt-out.
  return '';
}
