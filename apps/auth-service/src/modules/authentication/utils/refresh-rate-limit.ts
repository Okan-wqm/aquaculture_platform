import type { RateLimitRouteConfig } from '@aquaculture/backend-common/rate-limit';

/**
 * The `refreshToken` mutation's pre-authentication bucket (SEC-MEDIUM-212).
 *
 * WHAT it limits: refresh requests per END-CLIENT IP (SEC-HIGH-202: behind the
 * gateway the IP dimension is the client the gateway minted, never the gateway
 * container), counted BEFORE the token is verified.
 *
 * WHY per IP and nothing finer: before verification the only identity a caller
 * cannot choose is its address. A bucket keyed by anything the request itself
 * names (the userId inside the `${userId}:${secret}` token, a session id) lets
 * an attacker spend a victim's bucket by claiming the victim's id, which is a
 * lock-out of that user; and no bucket at all lets random tokens reach the
 * credential principal lock and a bcrypt compare per request.
 *
 * WHY 120 per 5 minutes: an access token lives in memory, so every full page
 * load and every token expiry refreshes once. A bucket of 10 was a limit of five
 * page loads per OFFICE: one address stands for every user behind a shared
 * connection, and the 6th colleague who opened the app was refused. 120 (24 a
 * minute) carries a team of a hundred opening the app within the window, while a
 * single address still cannot spray more than 24 verification attempts a minute
 * at a token that is 256 bits of secret behind single-use rotation and reuse
 * containment (guessing it is not what this bucket stands between). The cost it
 * caps is the database transaction and the hash compare each attempt starts.
 *
 * What it is NOT: a login limiter. Credential guessing is bounded per ACCOUNT by
 * the login bucket (5 per 15 minutes), which this does not touch. A client that
 * is throttled here is told to wait (TOO_MANY_REQUESTS with `retryAfter`) and
 * keeps its session.
 */
export const REFRESH_RATE_LIMIT = {
  name: 'refresh',
  limit: 120,
  windowMs: 5 * 60_000,
} as const satisfies RateLimitRouteConfig;
