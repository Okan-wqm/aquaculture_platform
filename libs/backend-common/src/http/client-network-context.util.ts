import type {
  VerifiedServiceIdentity,
  VerifiedUserAssertion,
} from '../types/tenant-request.interface';

/**
 * Client network identity resolution — ORPHAN-MEDIUM-319.
 *
 * # The problem this solves
 *
 * Subgraphs sit behind Apollo Gateway: `request.ip` is ALWAYS the gateway
 * container's socket address and `user-agent` is the gateway's internal
 * fetcher (minipass-fetch). Every audit row and `users.lastLoginIp` written
 * from those values recorded `::ffff:172.18.0.x` — during the 2026-07-02
 * lockout incident the actual actors were only recoverable by correlating
 * nginx access logs by timestamp.
 *
 * # Trust model (strongest available source wins)
 *
 * 1. `verifiedUserAssertion.clientIp` — SIGNED: the value is inside the
 *    gateway assertion whose sha256 is bound into the service-identity v2
 *    canonical (X-Service-Assertion-Hash). Tamper-proof end to end.
 * 2. `x-client-ip` / `x-client-user-agent` headers — GATEWAY-GATED: minted
 *    by the gateway (which resolves the true client via TRUST_PROXY=1
 *    behind nginx) on EVERY forwarded request, including pre-auth ones
 *    (login/refresh) where no user assertion exists. Trusted ONLY when the
 *    request carries a verified `gateway-api` service identity;
 *    StripInternalHeadersMiddleware removes these headers from any request
 *    that fails (or lacks) service-identity verification, so an external
 *    caller can never plant them.
 * 3. `request.ip` / `user-agent` — DIRECT: dev / test / non-gateway
 *    internal calls where the socket peer IS the client.
 *
 * # Consumers
 *
 * Audit rows and `users.lastLoginIp` (auth resolvers) and the IP dimension of
 * every `@RateLimit` bucket (`RateLimitGuard.identityOf`, SEC-HIGH-202). The
 * guard read `request.ip` until 2026-10-17, so every pre-auth bucket keyed only
 * by IP (refresh, password-reset, …) was ONE bucket for the whole platform:
 * the gateway container's.
 *
 * # Why not bind the IP into the signed canonical for pre-auth too
 *
 * The v2 canonical is a fixed 14-field contract with a byte-for-byte Rust
 * coprocessor reimplementation (R1 golden vectors) — extending it is a
 * breaking v3 rollout. The assertion-hash field already gives signed
 * transport for authenticated requests; for pre-auth requests the
 * gateway-gated header (2) is the strongest mechanism that requires no
 * contract version bump, and the strip middleware closes the spoofing hole.
 */

export interface ClientNetworkContext {
  /** Best-available end-client IP, or undefined when nothing is known. */
  ip?: string;
  /** Best-available end-client User-Agent. */
  userAgent?: string;
  /** Which trust tier produced the values (useful in audit payloads). */
  source: 'gateway-assertion' | 'gateway-header' | 'direct';
}

/**
 * Minimal structural view of the request — keeps the helper usable from
 * GraphQL contexts, Express middleware and the platform RateLimitGuard
 * (SEC-HIGH-202) without importing express types at the call site. An Express
 * request (and TenantRequest) satisfies it as-is.
 */
export interface ClientNetworkRequest {
  ip?: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  verifiedIdentity?: Pick<VerifiedServiceIdentity, 'serviceName'>;
  verifiedUserAssertion?: Pick<VerifiedUserAssertion, 'clientIp' | 'clientUserAgent'>;
}

function headerValue(headers: ClientNetworkRequest['headers'], name: string): string | undefined {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export function resolveClientNetworkContext(req: ClientNetworkRequest): ClientNetworkContext {
  // Tier 1 — signed assertion claim (authenticated gateway requests).
  const assertion = req.verifiedUserAssertion;
  if (assertion?.clientIp) {
    return {
      ip: assertion.clientIp,
      userAgent: assertion.clientUserAgent ?? headerValue(req.headers, 'x-client-user-agent'),
      source: 'gateway-assertion',
    };
  }

  // Tier 2 — gateway-minted headers, valid ONLY behind a verified gateway
  // service identity (pre-auth login/refresh land here).
  if (req.verifiedIdentity?.serviceName === 'gateway-api') {
    const ip = headerValue(req.headers, 'x-client-ip');
    if (ip) {
      return {
        ip,
        userAgent: headerValue(req.headers, 'x-client-user-agent'),
        source: 'gateway-header',
      };
    }
  }

  // Tier 3 — direct connection (dev/test/service-local): the socket peer is
  // the client and the request's own user-agent is genuine.
  return {
    ip: req.ip || undefined,
    userAgent: headerValue(req.headers, 'user-agent'),
    source: 'direct',
  };
}
