# Research: Rate Limiting Fail-Closed with Redis Atomic Increment

**Date:** 2026-04-08
**Agent:** auth-security-expert
**Topic slug:** rate-limiting-fail-closed-redis-atomic-increment

## Sources
- [OWASP Blocking Brute Force Attacks](https://owasp.org/www-community/controls/Blocking_Brute_Force_Attacks)
- [OWASP API Security Top 10 — API4:2023 Unrestricted Resource Consumption](https://owasp.org/API-Security/editions/2023/en/0xa4-unrestricted-resource-consumption/)
- [OWASP API Security Top 10 — API2:2023 Broken Authentication](https://owasp.org/API-Security/editions/2023/en/0xa2-broken-authentication/)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Denial of Service Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Denial_of_Service_Cheat_Sheet.html)
- [OWASP GraphQL Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html)
- [PortSwigger — GraphQL Brute Force Protection Bypass](https://portswigger.net/web-security/graphql/lab-graphql-brute-force-protection-bypass)
- [Cloudflare — Advanced Rate Limiting & Brute Force Protection](https://www.cloudflare.com/application-services/products/rate-limiting/)
- [OWASP Credential Stuffing Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Credential_Stuffing_Prevention_Cheat_Sheet.html)

## Key Findings

### Per-endpoint buckets (OWASP API2:2023)
- OWASP: "anti-brute force mechanisms stricter than regular rate limiting on auth endpoints."
- Standard buckets:
  - **Login:** 5 attempts / 15 minutes / (IP + username) composite key
  - **Register:** 3 attempts / 15 minutes / IP
  - **Password reset request:** 3 / 15 minutes / IP
  - **MFA verification:** 5 / 15 minutes / (userId)
  - **API general:** 100 / 1 minute / tenantId
  - **Upload:** 10 / 1 minute / userId
  - **Export (GDPR):** 3 / 1 hour / userId

### Atomic increment-or-create (Redis MULTI/EXEC or Lua)
- Race condition to avoid: `GET → increment in code → SET`. Two concurrent requests can both see the same value and both increment to N+1 instead of N+2.
- Correct pattern: `INCR key; EXPIRE key ttl` in a single MULTI/EXEC, or a Lua script that handles first-request TTL init.
- Lua script (atomic):
  ```
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return count
  ```
- `INCR` on non-existent key creates key with value 1 — no race on creation.
- First-request: count becomes 1, set TTL. Subsequent: count increments, TTL preserved.
- Always check `count > limit` AFTER increment, not before (prevents TOCTOU).

### Fail-closed vs fail-open (critical decision)
- **Fail-open (bad for auth):** if Redis unreachable, allow the request. Simple but defeats rate limiting during Redis outage — attackers can exploit outage window.
- **Fail-closed (required for auth endpoints in production):** if Redis unreachable, reject with 503.
- Middleware pattern: `if (env.NODE_ENV === 'production') failClosed() else failOpen()`.
- Non-auth endpoints MAY fail-open with degraded protection; auth/sensitive endpoints MUST fail-closed.
- Circuit breaker wraps Redis calls; after N failures, short-circuit to the configured fail policy.

### Username + IP composite keying
- Rate limit per-IP alone = attackers share botnet IPs to bypass.
- Rate limit per-username alone = attackers target one user = lock out legitimate users (DoS).
- **Composite:** `login:{ip}:{username}` limits per pair. Attackers targeting one user from one IP are blocked; legitimate users not DoSed by others.
- Additionally: per-username counter for account lockout (5 fails → 30 min lockout).
- Additionally: per-IP aggregate counter (100 fails from one IP → IP banned temporarily).

### GraphQL alias brute-force (PortSwigger / OWASP GraphQL)
- GraphQL allows multiple aliases in one HTTP request: `mutation { a: login(pwd: "1") b: login(pwd: "2") c: login(pwd: "3") }`.
- HTTP-level rate limiter sees 1 request; effectively bypasses login 5/15 limit.
- **Mitigation 1:** `AliasLimitPlugin` — inspect incoming GraphQL document, count aliases on sensitive mutations (login, register, refresh, forgotPassword, resetPassword, verifyMfaLogin, changePassword), reject if > 1 per request.
- **Mitigation 2:** Rate limit per-operation inside the resolver, not just at HTTP ingress.
- **Mitigation 3:** Apollo Server operation complexity limit + `graphql-depth-limit`.

### Sliding window vs fixed window
- Fixed window: reset counter at wall-clock intervals. Simple but allows burst at window boundary (2x limit in 2 seconds).
- Sliding window: track per-timestamp events in a sorted set. Accurate but more expensive.
- Acceptable compromise: fixed window + short duration (15-min buckets). Boundary burst is tolerable for 5/15min.

### Redis SLOWLOG and monitoring
- Rate limit operations must complete in < 1ms at p99. Monitor Redis SLOWLOG for rate-limit keys.
- Namespace keys: `rl:login:{ip}:{user}`, `rl:register:{ip}`, etc. — easy pattern-matching for observability.

## Security Concerns
- **CRITICAL:** Fail-open in production on auth endpoints = Redis outage = brute-force window.
- **CRITICAL:** GraphQL without alias limit plugin on sensitive mutations = HTTP-level rate limit fully bypassed.
- **CRITICAL:** Non-atomic increment = race window where parallel requests all see count=0 and all increment to count=1.
- **HIGH:** Per-IP only keying = botnet bypass. Per-username only = DoS of legitimate user.
- **HIGH:** Rate limit implemented in controller middleware but bypassed on GraphQL operations (which go through a single endpoint).
- **HIGH:** Missing rate limit on password reset request = email bombing + enumeration.
- **MEDIUM:** Fixed window boundary burst not mitigated for high-sensitivity endpoints.

## Performance Concerns
- Single `INCR + EXPIRE` via MULTI/EXEC or Lua = 1 RTT to Redis, ~0.3-0.5ms.
- At scale, use Redis pipelining for batch checks (e.g., multiple buckets checked per request).
- Redis cluster: ensure rate limit keys hash to same slot for atomicity (use hashtags: `rl:{ip}:login`).

## Architectural Implications
- ThrottlerGuard wraps a RateLimitService that uses atomic Redis operations.
- Fail policy injected via config; production overrides fail-closed for auth endpoints.
- GraphQL layer has its own AliasLimitPlugin + per-resolver rate limiting for sensitive ops.
- Circuit breaker around Redis client with metrics export.

## Domain Rule Additions
- **CRITICAL:** Rate limit increment MUST be atomic (INCR+EXPIRE in MULTI/EXEC, or Lua script). Non-atomic implementations are CRITICAL.
- **CRITICAL:** Auth endpoints (login, register, refresh, resetPassword, forgotPassword, verifyMfaLogin, changePassword) MUST fail-closed in production when Redis is unavailable.
- **CRITICAL:** GraphQL sensitive mutations MUST be protected by AliasLimitPlugin (max 1 alias per request). Missing plugin = HTTP rate limit bypass.
- **CRITICAL:** Login rate limit key MUST be composite `(ip + username)` — never per-IP-only (botnet bypass) or per-username-only (user DoS).
- Standard buckets: login 5/15min, register 3/15min, password reset 3/15min, MFA verify 5/15min, upload 10/1min, GDPR export 3/1hour.
- Per-username account lockout (5 fails / 30 min) is SEPARATE from per-IP rate limit and runs in parallel.
- Rate limit keys MUST be namespaced `rl:{endpoint}:{key}` for observability.
- Redis client MUST be wrapped in a circuit breaker; breaker-open state = fail-closed in production.
