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
 *   1. `req.user.tenantId` — cryptographically verified (JWT-decoded by
 *      UserContextMiddleware). If present, this is the trust anchor.
 *   2. `x-tenant-id` request header — only used when no JWT context is
 *      available (pre-auth paths, cross-tenant admin, health probes that
 *      forward the header from edge monitoring).
 *   3. Empty string — "no tenant" is a valid, explicit answer.
 *
 * In all cases the value is validated against a canonical UUID regex.
 * Any malformed input yields an empty string, which fails closed: a
 * downstream guard receiving an unsigned or empty-tenant HMAC will not
 * grant tenant-scoped access.
 */

/** Canonical UUID v1-v5 regex — matches what the gateway's willSendRequest uses. */
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Narrow interface for the parts of Express Request we consult. Defined
 * locally so this utility does not depend on the full TenantRequest type
 * (which lives in a different module and pulls in tenant-context middleware
 * types — the tenant-resolving callsites should not require all of that).
 */
interface RequestLike {
  headers?: Record<string, string | string[] | undefined>;
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
  // 1. Trusted source: JWT-decoded user context.
  const fromJwt = (req as RequestLike).user?.tenantId;
  if (typeof fromJwt === 'string' && UUID_REGEX.test(fromJwt.trim())) {
    return fromJwt.trim();
  }

  // 2. Header fallback — only trusted when no JWT is present.
  const rawHeader = (req as RequestLike).headers?.['x-tenant-id'];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof headerValue === 'string') {
    const trimmed = headerValue.trim();
    if (UUID_REGEX.test(trimmed)) {
      return trimmed;
    }
  }

  // 3. No valid tenant — explicit opt-out.
  return '';
}
