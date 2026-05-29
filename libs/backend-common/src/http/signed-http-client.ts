import { generateServiceIdentityHeadersV2 } from '../utils/service-identity.util';

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
 * 3. Hard-fails if INTERNAL_SERVICE_SECRET is not configured. The service
 *    bootstrap already requires this in production; this helper makes
 *    the requirement explicit at every call site (no silent
 *    "unsigned request").
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
   * Override the environment-sourced INTERNAL_SERVICE_SECRET. For test
   * fixtures only — real call sites rely on the env var.
   */
  secret?: string;
  /**
   * Gateway-signed user assertion to bind into the service HMAC.
   */
  userAssertion?: string;
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
 * @throws Error if INTERNAL_SERVICE_SECRET is not configured and no
 *   `secret` override is provided.
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
  userAssertion?: string;
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
  const v2 = generateServiceIdentityHeadersV2({
    serviceName: args.serviceName,
    secret,
    tenantId: args.tenantId,
    method: args.method,
    path: args.path,
    body: args.body,
    userAssertion: args.userAssertion,
  });
  const headers: Record<string, string> = {
    'X-Service-Identity': v2['X-Service-Identity'],
    'X-Service-Timestamp': v2['X-Service-Timestamp'],
    'X-Service-Signature': v2['X-Service-Signature'],
    'X-Service-Sig-Version': v2['X-Service-Sig-Version'],
    'X-Service-Method': v2['X-Service-Method'],
    'X-Service-Path': v2['X-Service-Path'],
    'X-Service-Body-Hash': v2['X-Service-Body-Hash'],
    'X-Service-User-Assertion-Hash': v2['X-Service-User-Assertion-Hash'],
  };
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
 * are preserved; the eight X-Service-* headers are always overwritten with
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

  const signedHeaders = buildSignedInternalHeaders({
    serviceName: options.serviceName,
    tenantId: options.tenantId,
    method,
    path,
    body,
    userAssertion: options.userAssertion,
    secret: options.secret,
  });

  // Merge caller-supplied headers first, then overwrite the X-Service-*
  // and X-Tenant-ID keys so they always reflect the fresh signature.
  const merged = new Headers(options.headers);
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
    userAssertion: _ua,
    headers: _h,
    circuitBreaker,
    circuitBreakerOptions,
    ...init
  } = options;
  void _s;
  void _t;
  void _sec;
  void _ua;
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
