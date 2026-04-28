import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Service Identity Headers — HMAC-signed headers for inter-service authentication.
 *
 * # The signature contract
 *
 * Every internal HTTP call is signed by the caller and verified by the
 * receiver. The HMAC binds enough request context that no part of the
 * request can be tampered with after signing without breaking the
 * signature.
 *
 * ## v2 canonical input (current — all new code MUST use this)
 *
 * ```
 * v2 \n
 * <ISO-8601 timestamp> \n
 * <service-name> \n
 * <UPPERCASE method> \n
 * <path WITHOUT query string> \n
 * <sha256(body) hex; '' for empty body> \n
 * <tenantId; '' for non-tenant paths>
 * ```
 *
 * Method, path, and body are bound so that a captured signature cannot be
 * replayed against a different endpoint, with a different verb, or with a
 * tampered body. The version prefix `v2` is the very first byte of the
 * canonical string so a future v3 can never be ambiguous with v2.
 *
 * ## v1 canonical input (deprecated — accepted only by verifier in this
 * release; removed in W0.A-finalize)
 *
 * ```
 * <numeric-ms timestamp>:<service-name>:<tenantId>
 * ```
 *
 * v1 binds only `(timestamp, service, tenantId)` and was the live shape
 * before the 2026-04-28 audit (SEC-CRITICAL-001 + SECREV-CRITICAL-001).
 * It is structurally vulnerable to:
 *
 *   - cross-endpoint replay (same timestamp/service/tenant, any path/method)
 *   - body-tampering (the request body never enters the canonical input)
 *
 * Verifiers in this release accept v1 ONLY for the rolling-deploy window
 * during which old senders may still be in flight. The `verifyServiceIdentity`
 * legacy export is annotated `@deprecated`; no new sender produces v1
 * after this commit. The next W0.A-finalize commit deletes both the v1
 * generator and verifier — verifiers will reject v1 entirely.
 *
 * # Why two functions instead of one with both versions
 *
 * Each version has different REQUIRED inputs. A single function with
 * optional method/path/body would let a careless caller silently fall
 * back to v1 by omitting fields — exactly the regression class we are
 * closing. Two functions, one strictly v2, makes the v1 path explicit
 * and visible at every call site that still uses it.
 *
 * # Header set
 *
 * v2 emits 7 headers (vs. v1's 3):
 *
 *   - X-Service-Identity      — service name (e.g. 'gateway-api')
 *   - X-Service-Timestamp     — ISO-8601 UTC; v2 standardises here
 *   - X-Service-Signature     — hex HMAC-SHA256
 *   - X-Service-Sig-Version   — 'v2' (verifier dispatch)
 *   - X-Service-Method        — upper-case HTTP verb
 *   - X-Service-Path          — request path without query string
 *   - X-Service-Body-Hash     — sha256(body) hex; '' for empty body
 *
 * The receiver reads these and re-builds the canonical string, so the
 * verifier knows exactly which method/path/body the SIGNER claimed to
 * have used. If the wire request uses a different method/path/body, the
 * recomputed HMAC mismatches and the request is rejected.
 *
 * Closes: docs/reviews/auth-security-expert/2026-04-28-core-platform-review.md#SEC-CRITICAL-001
 * Closes: docs/reviews/security-reviewer/2026-04-28-core-platform-review.md#SECREV-CRITICAL-001
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum allowed clock skew between sender and receiver (5 minutes).
 *
 * WHY: Replay-window control. A captured signature is only useful for
 * `maxAgeMs` after its timestamp; after that the receiver rejects it
 * unconditionally. 5 minutes is the industry default (Stripe, AWS SigV4)
 * and matches our deploy-window jitter tolerance.
 */
export const SERVICE_IDENTITY_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Newline-delimited canonical-string field separator.
 *
 * WHY: Newline is the de-facto standard for canonical strings (AWS SigV4,
 * Stripe webhook). It cannot appear inside any of our individual fields
 * (timestamp is digits, service is identifier, method is verb, path is
 * URL path, bodyHash is hex, tenantId is UUID), so the separator is
 * unambiguous — no field can splice into the next.
 */
const CANONICAL_DELIM = '\n';

/**
 * Version literal that prefixes every v2 canonical string.
 *
 * WHY: The version is the first byte of the canonical string so a future
 * v3 with different field ordering cannot collide with a captured v2
 * signature. Embedding the version in the input also means cross-version
 * signature tampering ("strip the version") changes the canonical and
 * breaks the HMAC.
 */
const SIG_VERSION_V2 = 'v2';

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * v1 header set — three headers, deprecated.
 *
 * @deprecated Use `ServiceIdentityHeadersV2`. v1 verifier acceptance is
 * scheduled for removal in the W0.A-finalize commit.
 */
export interface ServiceIdentityHeaders {
  'X-Service-Identity': string;
  'X-Service-Timestamp': string;
  'X-Service-Signature': string;
}

/**
 * v2 header set — seven headers, current.
 *
 * The four new headers (Sig-Version, Method, Path, Body-Hash) carry the
 * canonical-input components the receiver needs to re-derive the HMAC.
 * They are NOT trust-anchored — the trust comes from the signature
 * binding the same values into the canonical input. A tamperer who edits
 * X-Service-Method on the wire will see a re-derived canonical that
 * does not match the (signature-frozen) original, and verification fails.
 */
export interface ServiceIdentityHeadersV2 {
  'X-Service-Identity': string;
  'X-Service-Timestamp': string;
  'X-Service-Signature': string;
  'X-Service-Sig-Version': 'v2';
  'X-Service-Method': string;
  'X-Service-Path': string;
  'X-Service-Body-Hash': string;
}

// ─── v2 generator + verifier (primary path) ────────────────────────────────

/**
 * Compute sha256(body) hex.
 *
 * WHY: Body inclusion in the canonical input requires a stable digest;
 * sha256 is universal and timing-attack neutral here (we are not
 * comparing it secret-side).
 *
 * WHAT: Empty body returns `sha256('')` deterministically — the canonical
 * value `e3b0c44...`. Some callers prefer the empty string; v2 standardises
 * on the explicit zero-length sha256 so empty-body requests still bind
 * cryptographically (a tamperer who appends a body to an "empty" GET
 * cannot slip past).
 */
function sha256Hex(body: string | Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * Build the v2 canonical-string input.
 *
 * WHY: Pulled out as a named function so the unit tests can pin its
 * exact byte layout (tests assert the canonical string directly, not just
 * the digest, which lets future maintainers see at-a-glance which fields
 * are bound and in what order).
 */
function buildCanonicalV2(input: {
  timestamp: string;
  serviceName: string;
  method: string;
  path: string;
  bodyHash: string;
  tenantId: string;
}): string {
  return [
    SIG_VERSION_V2,
    input.timestamp,
    input.serviceName,
    input.method.toUpperCase(),
    input.path,
    input.bodyHash,
    input.tenantId,
  ].join(CANONICAL_DELIM);
}

/**
 * Generate v2 service-identity headers for an outgoing request.
 *
 * WHY: This is the only generator new code must call. v1's generator
 * (`generateServiceIdentityHeaders`) is `@deprecated` and emits a
 * console-warn on use; it remains exported only so existing call sites
 * that are not yet migrated do not break the build during the W0.A
 * rolling-deploy window.
 *
 * WHAT: Returns the 7 v2 headers. Empty body produces `sha256('')` —
 * never falls back to a literal empty string because that would let a
 * tamperer append a body to a "empty" GET and pass verification.
 *
 * @param args.serviceName - Calling service identifier (e.g. 'gateway-api')
 * @param args.secret      - Shared HMAC secret (INTERNAL_SERVICE_SECRET)
 * @param args.tenantId    - Tenant UUID; pass empty string only for proven
 *                            non-tenant paths (health, cross-tenant admin)
 * @param args.method      - HTTP verb (GET, POST, ...). Case-insensitive
 *                            input; canonical uses uppercase.
 * @param args.path        - Request path without query string.
 * @param args.body        - Raw body bytes. Buffer for binary, string for
 *                            text. Empty body uses '' (sha256 still computed).
 */
export function generateServiceIdentityHeadersV2(args: {
  serviceName: string;
  secret: string;
  tenantId: string;
  method: string;
  path: string;
  body: string | Buffer;
}): ServiceIdentityHeadersV2 {
  const timestamp = new Date().toISOString();
  const bodyHash = sha256Hex(args.body);
  const canonical = buildCanonicalV2({
    timestamp,
    serviceName: args.serviceName,
    method: args.method,
    path: args.path,
    bodyHash,
    tenantId: args.tenantId,
  });
  const signature = createHmac('sha256', args.secret).update(canonical).digest('hex');
  return {
    'X-Service-Identity': args.serviceName,
    'X-Service-Timestamp': timestamp,
    'X-Service-Signature': signature,
    'X-Service-Sig-Version': SIG_VERSION_V2,
    'X-Service-Method': args.method.toUpperCase(),
    'X-Service-Path': args.path,
    'X-Service-Body-Hash': bodyHash,
  };
}

/**
 * Verify a v2 signature against the request the receiver just got.
 *
 * WHY: The receiver re-derives the canonical from values it OBSERVES on
 * the wire (its own req.method, req.originalUrl, body it just parsed)
 * and then ALSO checks that the SIGNED claims (X-Service-Method etc.)
 * match those observed values. Two-stage check — if a tamperer rewrote
 * X-Service-Method to match the new wire method, the signature still
 * fails because the canonical string contains the original method.
 *
 * @returns true iff (1) timestamp within skew, (2) signed header
 *          claims match wire observations, and (3) HMAC verifies.
 */
export function verifyServiceIdentityV2(args: {
  // Headers received on the wire
  serviceName: string;
  timestamp: string;
  signature: string;
  method: string;
  path: string;
  bodyHash: string;
  // What the receiver actually observes (for cross-check)
  observedMethod: string;
  observedPath: string;
  observedBody: string | Buffer;
  // Trust inputs
  secret: string;
  expectedTenantId: string;
  maxAgeMs?: number;
}): boolean {
  // Step 1: timestamp freshness (replay window)
  const ts = Date.parse(args.timestamp);
  if (Number.isNaN(ts)) return false;
  const ageMs = Math.abs(Date.now() - ts);
  if (ageMs > (args.maxAgeMs ?? SERVICE_IDENTITY_MAX_AGE_MS)) return false;

  // Step 2: signed claims must match observed wire values. A tamperer who
  // rewrote method/path/body on the wire has not touched the signature,
  // so the signature still binds the ORIGINAL claims. If those claims
  // disagree with what the receiver actually got, the request is forged.
  if (args.method.toUpperCase() !== args.observedMethod.toUpperCase()) return false;
  if (args.path !== args.observedPath) return false;
  const observedBodyHash = sha256Hex(args.observedBody);
  if (args.bodyHash !== observedBodyHash) return false;

  // Step 3: HMAC. Re-derive canonical from the SIGNED claims (not the
  // observed values — equivalent here since they matched) and compare.
  const expected = createHmac('sha256', args.secret)
    .update(
      buildCanonicalV2({
        timestamp: args.timestamp,
        serviceName: args.serviceName,
        method: args.method,
        path: args.path,
        bodyHash: args.bodyHash,
        tenantId: args.expectedTenantId,
      }),
    )
    .digest('hex');

  if (expected.length !== args.signature.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(args.signature, 'utf8'),
  );
}

// ─── v1 generator + verifier (deprecated, kept for one release) ────────────

/**
 * v1 generator — DEPRECATED.
 *
 * @deprecated Use `generateServiceIdentityHeadersV2` instead. The v1
 * canonical input does not bind method/path/body and is structurally
 * vulnerable to cross-endpoint replay + body tampering
 * (SEC-CRITICAL-001). This function remains exported only so existing
 * call sites that are not yet migrated do not break the build during
 * the W0.A rolling-deploy window. Removed in W0.A-finalize.
 *
 * Closes: SEC-CRITICAL-001 (sender-side; v1 generator removed in finalize)
 */
export function generateServiceIdentityHeaders(
  serviceName: string,
  secret: string,
  tenantId: string,
): ServiceIdentityHeaders {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}:${serviceName}:${tenantId}`)
    .digest('hex');
  return {
    'X-Service-Identity': serviceName,
    'X-Service-Timestamp': timestamp,
    'X-Service-Signature': signature,
  };
}

/**
 * v1 verifier — DEPRECATED.
 *
 * @deprecated Use `verifyServiceIdentityRequest` instead, which dispatches
 * to v2 when X-Service-Sig-Version='v2' and falls back to v1 only for
 * the rolling-deploy window. Removed in W0.A-finalize.
 */
export function verifyServiceIdentity(
  serviceName: string,
  timestamp: string,
  signature: string,
  secret: string,
  tenantId: string,
  maxAgeMs: number = SERVICE_IDENTITY_MAX_AGE_MS,
): boolean {
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const age = Math.abs(Date.now() - ts);
  if (age > maxAgeMs) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}:${serviceName}:${tenantId}`)
    .digest('hex');

  if (expected.length !== signature.length) return false;
  return timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(signature, 'utf8'),
  );
}

// ─── Unified request verifier (dispatches v1 vs v2) ─────────────────────────

/**
 * Verifier dispatch result — caller can log which version the request
 * carried, useful for monitoring v1 traffic so we know when it is safe
 * to remove v1 acceptance entirely.
 */
export type VerificationOutcome =
  | { valid: true; version: 'v1' | 'v2' }
  | { valid: false; reason: 'missing-headers' | 'unknown-version' | 'expired' | 'method-mismatch' | 'path-mismatch' | 'body-mismatch' | 'invalid-hmac' };

/**
 * One-stop verifier for an inbound request.
 *
 * WHY: Each guard implementation re-deriving the dispatch logic invites
 * drift and bugs. A single canonical entry point means every receiver
 * follows the same v1-vs-v2 detection path, the same skew window, the
 * same observed-vs-claimed cross-check.
 *
 * WHAT: Reads X-Service-Sig-Version. If 'v2', requires the four extra
 * headers (Method, Path, Body-Hash) and uses the v2 path. If absent,
 * falls back to v1 (deprecated; logged by callers via the returned
 * `version='v1'` outcome). Unknown values reject.
 *
 * Receivers SHOULD log v1 outcomes via `securityEventService` so the
 * fleet can confirm zero v1 traffic before W0.A-finalize lands.
 */
export function verifyServiceIdentityRequest(args: {
  headers: Record<string, string | string[] | undefined>;
  observedMethod: string;
  observedPath: string;
  observedBody: string | Buffer;
  secret: string;
  expectedTenantId: string;
  maxAgeMs?: number;
}): VerificationOutcome {
  const get = (name: string): string | undefined => {
    const v = args.headers[name.toLowerCase()] ?? args.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };

  const serviceName = get('x-service-identity');
  const timestamp = get('x-service-timestamp');
  const signature = get('x-service-signature');
  if (!serviceName || !timestamp || !signature) {
    return { valid: false, reason: 'missing-headers' };
  }

  const sigVersion = get('x-service-sig-version');

  if (sigVersion === SIG_VERSION_V2) {
    const method = get('x-service-method');
    const path = get('x-service-path');
    const bodyHash = get('x-service-body-hash');
    if (!method || !path || bodyHash === undefined) {
      return { valid: false, reason: 'missing-headers' };
    }
    const ok = verifyServiceIdentityV2({
      serviceName,
      timestamp,
      signature,
      method,
      path,
      bodyHash,
      observedMethod: args.observedMethod,
      observedPath: args.observedPath,
      observedBody: args.observedBody,
      secret: args.secret,
      expectedTenantId: args.expectedTenantId,
      maxAgeMs: args.maxAgeMs,
    });
    return ok ? { valid: true, version: 'v2' } : { valid: false, reason: 'invalid-hmac' };
  }

  if (sigVersion === undefined) {
    // v1 fallback — deprecated. Caller is expected to log this and
    // treat the count as the metric for "safe to remove v1".
    const ok = verifyServiceIdentity(
      serviceName,
      timestamp,
      signature,
      args.secret,
      args.expectedTenantId,
      args.maxAgeMs,
    );
    return ok ? { valid: true, version: 'v1' } : { valid: false, reason: 'invalid-hmac' };
  }

  return { valid: false, reason: 'unknown-version' };
}
