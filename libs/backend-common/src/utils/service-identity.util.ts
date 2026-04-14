import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Service Identity Headers — HMAC-signed headers for inter-service authentication.
 *
 * The gateway signs every outgoing request to subgraphs with these headers so that
 * subgraphs can verify the request actually originated from the trusted gateway
 * (or another trusted service), rather than an arbitrary process on the Docker network.
 *
 * Signature = HMAC-SHA256(timestamp:serviceName:tenantId, INTERNAL_SERVICE_SECRET)
 *
 * SECURITY (HIGH-003): tenantId is bound into the signature so a compromised
 * caller cannot forward a valid signature with a spoofed X-Tenant-ID header.
 * When no tenant context applies (public / pre-auth paths), tenantId is the
 * empty string and the signature is effectively scoped to "no tenant".
 *
 * Backwards compatibility: callers that omit tenantId produce the same
 * signature as before (empty tenant). Verifiers check tenantId from the
 * header; if the header is absent, they verify with empty tenantId. Any
 * attempt to tamper with X-Tenant-ID post-signing fails verification.
 */

export interface ServiceIdentityHeaders {
  'X-Service-Identity': string;
  'X-Service-Timestamp': string;
  'X-Service-Signature': string;
}

/**
 * Generate HMAC-signed service identity headers.
 *
 * SECURITY (HIGH-003, strict-mode 2026-04-14): `tenantId` is REQUIRED — no
 * default. The compiler refuses to build call sites that omit it. Callers
 * with no tenant context MUST pass the empty string explicitly to signal
 * "I reviewed this, no tenant applies". That explicit-opt-out pattern is
 * the only way to make tenant binding "make impossible" rather than
 * "encouraged but optional".
 *
 * @param serviceName - The name of the calling service (e.g. 'gateway-api')
 * @param secret - The shared HMAC secret (INTERNAL_SERVICE_SECRET env var)
 * @param tenantId - Tenant UUID bound into the signature. Pass empty string
 *                   ONLY for provably non-tenant paths (health probes,
 *                   cross-tenant admin calls). Every other call site MUST
 *                   pass the real tenant UUID.
 * @returns Headers object to merge into the outgoing request
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
 * Maximum allowed clock skew between gateway and subgraph (5 minutes).
 * Requests older than this are rejected to prevent replay attacks.
 */
export const SERVICE_IDENTITY_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Verify a service identity signature.
 *
 * @param serviceName - Value of X-Service-Identity header
 * @param timestamp - Value of X-Service-Timestamp header
 * @param signature - Value of X-Service-Signature header
 * @param secret - The shared HMAC secret
 * @param tenantId - Optional tenant UUID from X-Tenant-ID header. Pass empty
 *                   string when no tenant header is present. See the module
 *                   docblock for the tenant-binding rationale.
 * @param maxAgeMs - Maximum age of the timestamp in ms (default 5 min)
 * @returns true if the signature is valid and the timestamp is within the allowed window
 */
export function verifyServiceIdentity(
  serviceName: string,
  timestamp: string,
  signature: string,
  secret: string,
  tenantId: string,
  maxAgeMs: number = SERVICE_IDENTITY_MAX_AGE_MS,
): boolean {
  // Validate timestamp freshness (replay protection)
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) {
    return false;
  }
  const age = Math.abs(Date.now() - ts);
  if (age > maxAgeMs) {
    return false;
  }

  // SECURITY (HIGH-003): tenantId bound into HMAC — any tamper of
  // X-Tenant-ID between signing and verification fails this comparison.
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}:${serviceName}:${tenantId}`)
    .digest('hex');

  // Timing-safe comparison to prevent timing attacks
  if (expected.length !== signature.length) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(expected, 'utf8'),
    Buffer.from(signature, 'utf8'),
  );
}
