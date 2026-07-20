import { createHash, randomUUID } from 'crypto';

import { serviceIdentityAudienceForService } from '../../../../platform/libs/service-catalog/src/index';
import {
  generateServiceIdentityHeadersV2,
  parseServiceIdentityKeyring,
} from '../utils/service-identity.util';

/**
 * @module SignedHttpClient
 *
 * Thin wrapper around the global `fetch` that automatically attaches the
 * platform's HMAC-signed v2 service-identity headers AND the X-Tenant-ID
 * propagation header on every outgoing internal HTTP request.
 *
 * # Why this helper instead of raw fetch
 *
 * 1. One consistent place to mint v2 signed headers — migration is
 *    "replace `fetch` with `signedFetch`". Anything signing v1 by hand
 *    is a SEC-CRITICAL-001-class footgun.
 * 2. Mandatory tenantId parameter for tenant-scoped calls — callers
 *    cannot forget to include it.
 * 3. Hard-fails if service-identity signing material is not configured.
 *    Production requires SERVICE_IDENTITY_KEYRING and
 *    SERVICE_IDENTITY_SIGNING_KID; local development may use a dev secret.
 * 4. v2 signatures bind method, path, and body — so a captured signature
 *    cannot be replayed against a different endpoint or with a tampered
 *    body. signedFetch reads method/body from the RequestInit and the
 *    path from the URL automatically; callers do not have to thread
 *    additional fields.
 *
 * # USAGE
 *
 * ```ts
 * import { signedFetch } from '@aquaculture/backend-common/signed-http-client.ts';
 *
 * // Public / non-tenant call (e.g. health probe)
 * const res = await signedFetch('http://auth-service:3000/health', {
 *   serviceName: 'gateway-api',
 *   tenantId: '',  // explicit opt-out — proven non-tenant path
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
 *
 * Closes: docs/reviews/auth-security-expert/2026-04-28-core-platform-review.md#SEC-CRITICAL-001
 */

/**
 * Optional circuit-breaker integration for signedFetch.
 *
 * # Why this is on the canonical helper (CIRCUIT-MEDIUM-004 cure)
 *
 * Pre-cure `signedFetch` was the platform-wide canonical
 * helper for internal HMAC-signed cross-service calls. It
 * attached HMAC + tenant headers but performed the raw fetch
 * with NO resilience layer. Only one caller (gateway-api's
 * service-proxy) wrapped externally; every other internal-
 * service consumer (admin-api → auth-service, billing →
 * admin-api, notification → auth, ...) executed unbreakered
 * fetches.
 *
 * Auditing every callsite individually would be a per-service
 * sweep. Centralising the breaker integration ON the canonical
 * helper means callers opt into circuit protection by passing
 * the same `circuitBreaker` they already inject for everything
 * else — no per-callsite refactor needed beyond the wiring.
 *
 * # Why optional, not mandatory
 *
 * Some signedFetch consumers run in contexts that don't
 * register a CircuitBreakerService (cron-only services, CLI
 * scripts, test harnesses). Forcing the parameter would force
 * every caller to either inject or fake-inject. Optional with
 * an explicit per-call opt-in keeps the helper usable in both
 * worlds while making the breaker the documented happy path.
 *
 * The `tests/invariants/signed-fetch-breakered.spec.ts` invariant
 * (added alongside) flags every signedFetch call that omits the
 * breaker arg in `apps/**` so the rollout can complete one
 * service at a time without losing the discipline gate.
 */
export interface SignedFetchCircuitBreakerOption {
  /** Canonical CircuitBreakerService instance. */
  service: SignedFetchCircuitBreakerLike;
  /** Per-(serviceName, operationName) breaker key. */
  serviceName: string;
}

/**
 * Minimal interface SignedFetch needs from CircuitBreakerService.
 * Mirrors the canonical execute() shape from
 * `libs/backend-common/src/resilience/circuit-breaker/`. Declared
 * here as a structural type so signedFetch doesn't need to
 * import the heavy resilience module at the http-client layer
 * (avoids circular-import risk between http and resilience).
 */
export interface SignedFetchCircuitBreakerLike {
  execute<T>(args: {
    serviceName: string;
    tenantId?: string;
    fn: () => Promise<T>;
    options: SignedFetchCircuitBreakerOptionsLike;
    fallback?: () => T | Promise<T>;
    shouldRecordFailure?: (error: unknown) => boolean;
  }): Promise<T>;
}

/**
 * Subset of CircuitBreakerOptions signedFetch surfaces. Callers
 * who need the full options (slowCallMs, halfOpenRequests, etc.)
 * pass the canonical DEFAULT_BREAKER_OPTIONS spread + their
 * failureMode override.
 */
export interface SignedFetchCircuitBreakerOptionsLike {
  failureMode: 'fail-closed' | 'fail-open-degraded';
  failureThreshold: number;
  successThreshold: number;
  volumeThreshold: number;
  failureRatePct: number;
  slowCallMs: number;
  slowCallRatePct: number;
  halfOpenRequests: number;
  openTimeoutMs: number;
  windowSeconds: number;
  bucketSeconds: number;
}

export interface SignedFetchOptions extends RequestInit {
  /**
   * Name of the calling service (e.g. 'gateway-api'). Included verbatim in
   * the X-Service-Identity header and bound into the v2 HMAC canonical input.
   */
  serviceName: string;
  /**
   * Tenant UUID for tenant-scoped calls. Bound into the v2 HMAC canonical
   * input so the receiving guard rejects any request where X-Tenant-ID was
   * tampered with after signing.
   *
   * REQUIRED — no default. Pass the empty string ONLY for provably
   * non-tenant paths (health probes, cross-tenant admin RPC). Every other
   * call site MUST pass the real tenant UUID. This opts every caller into
   * explicit review of tenant-binding correctness.
   */
  tenantId: string;
  /**
   * Test/dev-only secret override. Production rejects overrides and uses
   * SERVICE_IDENTITY_KEYRING plus SERVICE_IDENTITY_SIGNING_KID.
   */
  secret?: string;
  /** Service-identity key id override for tests/controlled rotations. */
  keyId?: string;
  /** Expected downstream service audience bound into the HMAC. */
  audience?: string;
  /** Exact request query string, including the leading '?' when present. */
  query?: string;
  /** Exact outbound Content-Type bound into the HMAC. */
  contentType?: string;
  /** SHA-256 hex digest of the gateway verified-user assertion header. */
  assertionHash?: string;
  /** Effective tenant, when distinct from tenantId. */
  effectiveTenantId?: string;
  /** Nonce override for deterministic tests. */
  nonce?: string;
  /**
   * Optional canonical CircuitBreakerService integration
   * (CIRCUIT-MEDIUM-004 cure). When provided, the actual fetch is
   * wrapped in `breaker.service.execute({ serviceName: breaker.serviceName,
   * tenantId, fn, options })` so the breaker counts failures and
   * trips per-(callee, tenant) keying. When omitted, signedFetch
   * runs the raw fetch as before. Callers MUST pass this on
   * production paths; the invariant gate flags omissions in
   * `apps/**`.
   */
  circuitBreaker?: SignedFetchCircuitBreakerOption;
  /**
   * CircuitBreaker options when `circuitBreaker` is supplied. The
   * canonical lib exports DEFAULT_BREAKER_OPTIONS — most callers
   * spread that and override only failureMode.
   */
  circuitBreakerOptions?: SignedFetchCircuitBreakerOptionsLike;
}

/**
 * Build the v2 header object that carries signed identity + tenant + method
 * + path + body context. Use this when you need the headers but not fetch
 * (e.g. for Apollo federation `willSendRequest` where the caller owns the
 * HTTP dispatch — see apps/gateway-api/src/app.module.ts).
 *
 * @throws Error if service-identity signing material is not configured.
 */
export function buildSignedInternalHeaders(args: {
  serviceName: string;
  /** Required — pass empty string only for provably non-tenant paths. */
  tenantId: string;
  /** HTTP verb (GET/POST/PUT/DELETE/...). Bound into v2 canonical input. */
  method: string;
  /** Request path WITHOUT query string. Bound into v2 canonical input. */
  path: string;
  /**
   * Request body bytes. '' for GET/empty-body — note the bodyHash is
   * STILL computed (sha256('')) so empty-body requests bind cryptographically;
   * a tamperer cannot append a body to a "empty" GET and pass verification.
   */
  body: string | Buffer;
  secret?: string;
  keyId?: string;
  audience?: string;
  query?: string;
  contentType?: string;
  assertionHash?: string;
  effectiveTenantId?: string;
  nonce?: string;
}): Record<string, string> {
  const signingMaterial = resolveServiceIdentitySigningMaterial(args.secret, args.keyId);
  const v2 = generateServiceIdentityHeadersV2({
    serviceName: args.serviceName,
    secret: signingMaterial.secret,
    tenantId: args.tenantId,
    method: args.method,
    path: args.path,
    body: args.body,
    keyId: signingMaterial.keyId,
    audience: args.audience,
    query: args.query,
    contentType: args.contentType,
    effectiveTenantId: args.effectiveTenantId,
    assertionHash: args.assertionHash,
    nonce: args.nonce ?? randomUUID(),
  });
  const headers: Record<string, string> = {
    'X-Service-Identity': v2['X-Service-Identity'],
    'X-Service-Timestamp': v2['X-Service-Timestamp'],
    'X-Service-Signature': v2['X-Service-Signature'],
    'X-Service-Sig-Version': v2['X-Service-Sig-Version'],
    'X-Service-Method': v2['X-Service-Method'],
    'X-Service-Path': v2['X-Service-Path'],
    'X-Service-Body-Hash': v2['X-Service-Body-Hash'],
  };
  for (const optionalHeader of [
    'X-Service-Key-Id',
    'X-Service-Audience',
    'X-Service-Query-Hash',
    'X-Service-Content-Type',
    'X-Service-Assertion-Hash',
    'X-Service-Nonce',
    'X-Service-Effective-Tenant-ID',
  ] as const) {
    const value = v2[optionalHeader];
    if (value !== undefined) {
      headers[optionalHeader] = value;
    }
  }
  if (args.tenantId) {
    // Only forward the tenant header when there is one — the signature was
    // computed against empty string otherwise, so sending an empty header
    // would be semantically wrong (but the canonical tenantId is still '').
    headers['X-Tenant-ID'] = args.tenantId;
  }
  return headers;
}

/**
 * Drop-in replacement for `fetch` that attaches v2 signed identity + tenant
 * headers. Existing Content-Type/Authorization headers from `options.headers`
 * are preserved; the seven X-Service-* headers are always overwritten with
 * the freshly-minted values to prevent replay of stale signatures.
 *
 * # Body normalisation for HMAC
 *
 * v2 binds sha256(body) into the canonical input. To produce a stable hash
 * the helper normalises supported BodyInit shapes:
 *   - undefined / null      → ''
 *   - string                → as-is
 *   - Buffer / Uint8Array   → byte-exact
 *   - URLSearchParams       → toString()
 *   - object (legacy)       → JSON.stringify (rare; emits deprecation log
 *                                   because the caller should pre-stringify)
 *
 * Streaming bodies (ReadableStream) are explicitly rejected — we cannot
 * sign what we cannot hash. Callers with stream bodies must either buffer
 * first or use a different signing path designed for streaming (none today).
 */
export async function signedFetch(
  input: string | URL,
  options: SignedFetchOptions,
): Promise<Response> {
  const method = (options.method ?? 'GET').toUpperCase();
  const url = typeof input === 'string' ? new URL(input) : input;
  const path = url.pathname;
  const body = normalizeBodyForSigning(options.body);

  const merged = new Headers(options.headers);
  const assertion = merged.get('x-verified-user-assertion') ?? undefined;
  const signedHeaders = buildSignedInternalHeaders({
    serviceName: options.serviceName,
    tenantId: options.tenantId,
    method,
    path,
    body,
    secret: options.secret,
    keyId: options.keyId,
    audience: options.audience ?? inferAudienceFromUrl(url),
    query: options.query ?? url.search,
    contentType: options.contentType ?? merged.get('content-type') ?? undefined,
    assertionHash: options.assertionHash ?? (assertion ? sha256Hex(assertion) : undefined),
    effectiveTenantId: options.effectiveTenantId,
    nonce: options.nonce,
  });

  // Merge caller-supplied headers first, then overwrite the X-Service-*
  // and X-Tenant-ID keys so they always reflect the fresh signature.
  for (const [name, value] of Object.entries(signedHeaders)) {
    merged.set(name, value);
  }
  // When the caller explicitly declared a non-tenant path (empty string),
  // scrub any pre-existing X-Tenant-ID from caller headers so the signed
  // contract and the wire match — empty signature bound to empty header.
  if (options.tenantId === '') {
    merged.delete('X-Tenant-ID');
    merged.delete('x-tenant-id');
  }

  // Strip custom fields before forwarding to fetch — RequestInit does not
  // accept serviceName / tenantId / secret / circuitBreaker.
  const {
    serviceName: _s,
    tenantId: _t,
    secret: _sec,
    keyId: _kid,
    audience: _aud,
    query: _q,
    contentType: _ct,
    assertionHash: _ah,
    effectiveTenantId: _et,
    nonce: _nonce,
    headers: _h,
    circuitBreaker,
    circuitBreakerOptions,
    ...init
  } = options;
  void _s;
  void _t;
  void _sec;
  void _kid;
  void _aud;
  void _q;
  void _ct;
  void _ah;
  void _et;
  void _nonce;
  void _h;

  const finalInit = { ...init, headers: merged };

  // CIRCUIT-MEDIUM-004 cure: optional circuit breaker wrap. When
  // the caller supplied `circuitBreaker`, route the actual fetch
  // through `circuitBreaker.service.execute()` so failures are
  // counted and the breaker trips per-(callee, tenant). Without
  // it, fall back to the raw-fetch behaviour (back-compat for
  // local-dev / cron-only consumers). The signed-fetch-breakered
  // invariant flags omissions in apps/** during the rollout
  // window.
  if (circuitBreaker && circuitBreakerOptions) {
    return circuitBreaker.service.execute<Response>({
      serviceName: circuitBreaker.serviceName,
      tenantId: options.tenantId || '*',
      fn: async () => fetch(input, finalInit),
      options: circuitBreakerOptions,
    });
  }

  return fetch(input, finalInit);
}

function inferAudienceFromUrl(url: URL): string | undefined {
  return serviceIdentityAudienceForService(url.hostname) ?? undefined;
}

/**
 * Coerce a BodyInit-compatible value into the byte-stable form used by
 * the v2 signature canonical input. See module docblock for the full
 * mapping table.
 *
 * WHY: `BodyInit` admits many shapes; sha256 needs a deterministic input.
 * Stream bodies cannot be signed without buffering, which would break
 * latency expectations of streaming endpoints. We reject them explicitly
 * so the failure mode is loud, not a silent "" hash.
 */

function resolveServiceIdentitySigningMaterial(
  secretOverride?: string,
  keyIdOverride?: string,
): { keyId?: string; secret: string } {
  const isProduction = process.env['NODE_ENV'] === 'production';
  if (secretOverride) {
    if (isProduction) {
      throw new Error(
        '[signed-http-client] secret overrides are forbidden in production; use SERVICE_IDENTITY_KEYRING',
      );
    }
    return { keyId: keyIdOverride ?? 'test', secret: secretOverride };
  }

  const keyring = parseServiceIdentityKeyring(process.env['SERVICE_IDENTITY_KEYRING']);
  if (keyring.length > 0) {
    const configuredKid = keyIdOverride ?? process.env['SERVICE_IDENTITY_SIGNING_KID'];
    if (isProduction && !configuredKid) {
      throw new Error(
        '[signed-http-client] SERVICE_IDENTITY_SIGNING_KID is required in production',
      );
    }
    const selected = configuredKid
      ? keyring.find((entry) => entry.kid === configuredKid)
      : keyring.find((entry) => entry.status === 'active');
    if (!selected || selected.status !== 'active') {
      throw new Error(
        '[signed-http-client] SERVICE_IDENTITY_SIGNING_KID must resolve to an active key',
      );
    }
    return { keyId: selected.kid, secret: selected.secret };
  }

  const devSecret =
    process.env['SERVICE_IDENTITY_SIGNING_SECRET'] ?? process.env['INTERNAL_SERVICE_SECRET'];
  if (devSecret && !isProduction) {
    return { keyId: keyIdOverride ?? 'local-dev', secret: devSecret };
  }

  throw new Error(
    '[signed-http-client] SERVICE_IDENTITY_KEYRING is not configured. ' +
      'Every internal HTTP call must be HMAC-signed with a keyed v2 identity. ' +
      'Set SERVICE_IDENTITY_KEYRING and SERVICE_IDENTITY_SIGNING_KID, or pass ' +
      'the `secret` override in tests.',
  );
}

function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeBodyForSigning(body: BodyInit | null | undefined): string | Buffer {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer?.(body as unknown)) {
    return body as Buffer;
  }
  // Reject streams and other unsupported shapes loudly.
  if (typeof (body as { getReader?: () => unknown }).getReader === 'function') {
    throw new Error(
      '[signed-http-client] streaming bodies cannot be signed. ' +
        'Buffer the stream before calling signedFetch, or use a non-signed ' +
        'transport for streaming endpoints.',
    );
  }
  // Unknown shape — refuse rather than emit a degenerate hash.
  throw new Error(
    `[signed-http-client] unsupported body shape ${(body as { constructor?: { name?: string } }).constructor?.name ?? typeof body}; ` +
      'normalize to string/Buffer/URLSearchParams before calling signedFetch.',
  );
}
