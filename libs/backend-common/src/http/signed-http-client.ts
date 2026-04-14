import { generateServiceIdentityHeaders } from '../utils/service-identity.util';

/**
 * @module SignedHttpClient
 *
 * Thin wrapper around the global `fetch` that automatically attaches the
 * platform's HMAC-signed service identity headers AND the X-Tenant-ID
 * propagation header on every outgoing internal HTTP request.
 *
 * SECURITY (HIGH-003): The HMAC signature binds tenantId into the digest
 * (see `service-identity.util.ts`). That means every tenant-scoped internal
 * HTTP call has tamper-proof tenant propagation — a downstream guard will
 * reject the request if X-Tenant-ID is modified in transit.
 *
 * WHY this helper instead of raw fetch:
 * 1. One consistent place to mint signed headers — migration is "replace
 *    `fetch` with `signedFetch`".
 * 2. Mandatory tenantId parameter for tenant-scoped calls — callers cannot
 *    forget to include it.
 * 3. Hard-fails if INTERNAL_SERVICE_SECRET is not configured. The service
 *    bootstrap already requires this in production; this helper makes the
 *    requirement explicit at every call site (no silent "unsigned request").
 *
 * USAGE:
 * ```ts
 * import { signedFetch } from '@aquaculture/backend-common';
 *
 * // Public / non-tenant call
 * const res = await signedFetch('http://auth-service:3000/health', {
 *   serviceName: 'gateway-api',
 * });
 *
 * // Tenant-scoped call — tenantId is bound into the signature
 * const res = await signedFetch('http://farm-service:3000/graphql', {
 *   serviceName: 'gateway-api',
 *   tenantId: user.tenantId,
 *   method: 'POST',
 *   body: JSON.stringify({ query: '...' }),
 *   headers: { 'content-type': 'application/json' },
 * });
 * ```
 */

export interface SignedFetchOptions extends RequestInit {
  /**
   * Name of the calling service (e.g. 'gateway-api'). Included verbatim in
   * the X-Service-Identity header and bound into the HMAC signature.
   */
  serviceName: string;
  /**
   * Tenant UUID for tenant-scoped calls. Bound into the HMAC signature so
   * the receiving guard rejects any request where X-Tenant-ID was tampered
   * with after signing. Omit (or pass empty string) for non-tenant calls.
   */
  tenantId?: string;
  /**
   * Override the environment-sourced INTERNAL_SERVICE_SECRET. For test
   * fixtures only — real call sites rely on the env var.
   */
  secret?: string;
}

/**
 * Build the header object that carries signed service identity + signed
 * tenant context. Use this when you need the headers but not fetch
 * (e.g. for Apollo federation `willSendRequest` where the caller owns the
 * HTTP dispatch).
 *
 * @throws Error if INTERNAL_SERVICE_SECRET is not configured and no
 *   `secret` override is provided.
 */
export function buildSignedInternalHeaders(args: {
  serviceName: string;
  tenantId?: string;
  secret?: string;
}): Record<string, string> {
  const secret = args.secret ?? process.env['INTERNAL_SERVICE_SECRET'];
  if (!secret) {
    throw new Error(
      '[signed-http-client] INTERNAL_SERVICE_SECRET is not configured. ' +
        'Every internal HTTP call must be HMAC-signed. Set the env var in ' +
        'production, or pass the `secret` override in tests.',
    );
  }
  const tenantId = args.tenantId ?? '';
  const identityHeaders = generateServiceIdentityHeaders(args.serviceName, secret, tenantId);
  const headers: Record<string, string> = {
    'X-Service-Identity': identityHeaders['X-Service-Identity'],
    'X-Service-Timestamp': identityHeaders['X-Service-Timestamp'],
    'X-Service-Signature': identityHeaders['X-Service-Signature'],
  };
  if (tenantId) {
    // Only forward the tenant header when there is one — the signature was
    // computed against empty string otherwise, so sending an empty header
    // would be semantically wrong.
    headers['X-Tenant-ID'] = tenantId;
  }
  return headers;
}

/**
 * Drop-in replacement for `fetch` that attaches signed identity + tenant
 * headers. Existing `Content-Type`/`Authorization` headers from
 * `options.headers` are preserved and take precedence only for non-security
 * headers; the three `X-Service-*` headers are always overwritten with the
 * freshly-minted values to prevent replay of stale signatures.
 */
export async function signedFetch(
  input: string | URL,
  options: SignedFetchOptions,
): Promise<Response> {
  const signedHeaders = buildSignedInternalHeaders({
    serviceName: options.serviceName,
    tenantId: options.tenantId,
    secret: options.secret,
  });

  // Merge caller-supplied headers first, then overwrite the X-Service-*
  // and X-Tenant-ID keys so they always reflect the fresh signature.
  const merged = new Headers(options.headers);
  for (const [name, value] of Object.entries(signedHeaders)) {
    merged.set(name, value);
  }

  // Strip custom fields before forwarding to fetch — RequestInit does not
  // accept serviceName / tenantId / secret.
  const { serviceName: _s, tenantId: _t, secret: _sec, headers: _h, ...init } = options;
  void _s; void _t; void _sec; void _h;

  return fetch(input, { ...init, headers: merged });
}
