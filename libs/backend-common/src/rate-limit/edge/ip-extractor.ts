import { EdgeRequestFacts, INVALID_IP_BUCKET } from '../rate-limit.types';

/*
 * Client-IP resolution for edge (config-driven) rate limiting.
 *
 * Ported VERBATIM from the gateway guard's extractClientIp/isValidIp
 * (apps/gateway-api/src/guards/rate-limit.guard.ts:447-503) so the SSoT
 * migration changes WHERE this runs, never WHICH IP it picks. Kept as pure
 * functions so the (security-sensitive) validation is unit-testable without a
 * NestJS context, and so the guard stays declarative.
 */

// IPv4 + IPv6 syntactic validation. Byte-identical to the gateway regexes —
// changing either changes which addresses are accepted as keys.
const IPV4_REGEX =
  /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPV6_REGEX =
  /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$|^::(?:[0-9a-fA-F]{1,4}:){0,6}[0-9a-fA-F]{1,4}$|^(?:[0-9a-fA-F]{1,4}:){1,7}:$|^(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}$/;

const LOOPBACK = new Set(['::1', '127.0.0.1']);

/** True when `ip` is a syntactically valid IPv4 or IPv6 address. */
export function isValidIp(ip: string | undefined): boolean {
  if (!ip || ip === 'unknown') {
    return false;
  }
  // Strip the IPv4-mapped-IPv6 prefix before IPv4 validation (e.g. ::ffff:1.2.3.4).
  const cleanIp = ip.replace(/^::ffff:/, '');
  return IPV4_REGEX.test(cleanIp) || IPV6_REGEX.test(ip);
}

export interface ExtractedIp {
  /** The chosen client IP, or INVALID_IP_BUCKET when none validates. */
  ip: string;
  /**
   * True when an UNVERIFIED X-Forwarded-For value was used. The caller logs a
   * production warning (the gateway's prior behavior) — the function itself
   * stays side-effect-free so it is unit-testable.
   */
  unverifiedForwardedFor: boolean;
}

function headerString(value: string | string[] | undefined): string | undefined {
  // Mirror the gateway: only a single string header is trusted; an array
  // (duplicate header) is ignored rather than guessed.
  return typeof value === 'string' ? value : undefined;
}

/**
 * Resolve the client IP, mirroring the gateway precedence VERBATIM:
 *   request.ip (trust-proxy-resolved, non-loopback, valid)
 *     > first valid X-Forwarded-For entry (unverified — caller warns in prod)
 *     > X-Real-IP
 *     > socket/connection remoteAddress
 *     > INVALID_IP_BUCKET (one shared bucket so a bad IP cannot bypass limits).
 */
export function extractClientIp(facts: EdgeRequestFacts): ExtractedIp {
  if (facts.ip && !LOOPBACK.has(facts.ip) && isValidIp(facts.ip)) {
    return { ip: facts.ip, unverifiedForwardedFor: false };
  }

  const forwardedFor = headerString(facts.headers['x-forwarded-for']);
  if (forwardedFor) {
    const firstIp = forwardedFor.split(',')[0]?.trim();
    if (firstIp && isValidIp(firstIp)) {
      return { ip: firstIp, unverifiedForwardedFor: true };
    }
  }

  const realIp = headerString(facts.headers['x-real-ip']);
  if (realIp && isValidIp(realIp)) {
    return { ip: realIp, unverifiedForwardedFor: false };
  }

  if (facts.remoteAddress && isValidIp(facts.remoteAddress)) {
    return { ip: facts.remoteAddress, unverifiedForwardedFor: false };
  }

  return { ip: INVALID_IP_BUCKET, unverifiedForwardedFor: false };
}
