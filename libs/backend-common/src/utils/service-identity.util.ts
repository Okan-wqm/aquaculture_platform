import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Service Identity Headers — HMAC-signed headers for inter-service authentication.
 *
 * The gateway signs every outgoing request to subgraphs with these headers so that
 * subgraphs can verify the request actually originated from the trusted gateway
 * (or another trusted service), rather than an arbitrary process on the Docker network.
 *
 * Signature = HMAC-SHA256(timestamp:serviceName, INTERNAL_SERVICE_SECRET)
 */

export interface ServiceIdentityHeaders {
  'X-Service-Identity': string;
  'X-Service-Timestamp': string;
  'X-Service-Signature': string;
}

/**
 * Generate HMAC-signed service identity headers.
 *
 * @param serviceName - The name of the calling service (e.g. 'gateway-api')
 * @param secret - The shared HMAC secret (INTERNAL_SERVICE_SECRET env var)
 * @returns Headers object to merge into the outgoing request
 */
export function generateServiceIdentityHeaders(
  serviceName: string,
  secret: string,
): ServiceIdentityHeaders {
  const timestamp = Date.now().toString();
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}:${serviceName}`)
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
 * @param maxAgeMs - Maximum age of the timestamp in ms (default 5 min)
 * @returns true if the signature is valid and the timestamp is within the allowed window
 */
export function verifyServiceIdentity(
  serviceName: string,
  timestamp: string,
  signature: string,
  secret: string,
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

  // Compute expected signature
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}:${serviceName}`)
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
