# Research: Service-to-Service HMAC + Timing-Safe Comparison + Internal Header Protection

**Date:** 2026-04-08
**Agent:** auth-security-expert
**Topic slug:** service-to-service-hmac-timing-safe-internal-headers

## Sources
- [OWASP Microservices Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Microservices_Security_Cheat_Sheet.html)
- [OWASP REST Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/REST_Security_Cheat_Sheet.html)
- [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [RFC 2104 — HMAC: Keyed-Hashing for Message Authentication](https://datatracker.ietf.org/doc/html/rfc2104)
- [RFC 4868 — HMAC-SHA256 for IKE and IPsec](https://datatracker.ietf.org/doc/html/rfc4868)
- [Cloudflare — timingSafeEqual Example](https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/)
- [Cloudflare — Token Authentication Configuration](https://developers.cloudflare.com/waf/custom-rules/use-cases/configure-token-authentication/)
- [OWASP CSRF Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

## Key Findings

### HMAC-SHA256 for service-to-service auth
- HMAC = keyed hash; verifies both integrity and authenticity with a shared secret.
- SHA-256 output = 32 bytes; hex encoding = 64 chars.
- Per RFC 2104, key length SHOULD equal hash output length (32 bytes for SHA-256). Longer keys are hashed first; shorter keys are zero-padded but reduce security.
- **Shared secret** (`INTERNAL_SERVICE_SECRET`) must be high-entropy (`crypto.randomBytes(32)`), rotated periodically, and distributed via secret manager (Vault/KMS), NEVER in source or env files.

### Canonical signing format (strongly recommended)
- Signature input MUST be a deterministic canonical string:
  ```
  canonical = `${serviceIdentity}|${timestamp}|${method}|${path}|${bodyHash}`
  signature = hex(HMAC-SHA256(secret, canonical))
  ```
- Including `method + path` prevents request replay across endpoints.
- Including `bodyHash` (SHA-256 of body) prevents body tampering.
- Including `timestamp` enables replay protection.
- Including `serviceIdentity` enables multi-tenant service secrets.

### Headers
- `X-Service-Identity: auth-service` — identifies the sender.
- `X-Service-Timestamp: 1712534400` — Unix seconds.
- `X-Service-Signature: <hex>` — HMAC-SHA256 output.
- Sometimes: `X-Service-Body-Hash: <hex>` — separate body hash for debug.

### Timestamp replay window
- Industry standard: **5-minute window** (300 seconds).
- Verifier: `abs(now - timestamp) <= 300`. Reject outside window.
- Tight window protects against captured-request replay; too tight breaks on clock drift.
- NTP sync on all services is mandatory for this to work reliably (< 1s drift typical).
- Additionally: track recently-seen signatures (Redis set, 5-min TTL) for in-window replay prevention.

### Timing-safe comparison (CRITICAL)
- `===` or `==` compares strings character-by-character, terminating early on mismatch. Attackers can infer correct prefixes by measuring response times.
- Node.js: `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` — constant-time regardless of input.
- Both buffers MUST be the same length; if not, reject without calling `timingSafeEqual` (which throws on length mismatch).
- Cloudflare: "By using timingSafeEqual, an attacker would not be able to use timing to find where in the two strings there is a difference."

### Length check before timingSafeEqual (subtle pitfall)
- `timingSafeEqual` throws on length mismatch — this itself is a timing signal (throw is fast, successful compare is slower).
- Mitigation: if lengths differ, still perform a dummy constant-time compare against a fixed-length placeholder, then return false.
- Or: first hash both inputs (HMAC with a dummy key) to equal length, then compare.

### StripInternalHeadersMiddleware (privilege boundary)
- Internal-only headers: `x-user-payload`, `x-service-identity`, `x-service-signature`, `x-act-as-tenant` (for SUPER_ADMIN).
- **External requests** (from public gateway) MUST have these headers STRIPPED by a middleware that runs FIRST in the pipeline.
- If attacker sends `x-user-payload: {"role":"SUPER_ADMIN"}` to the public gateway and the middleware doesn't strip it, downstream code trusts the header = full compromise.
- Middleware must strip on inbound, before any other middleware/guard runs.
- Header allowlist, not blocklist — any header starting with `x-service-` or `x-user-` is stripped unless the request is verified internal.

### Internal-only route distinction
- Some services have routes intended ONLY for internal callers (e.g., `/internal/users/:id` for profile lookup).
- These routes MUST require ServiceIdentityGuard (HMAC signature check).
- They MUST NOT be exposed on the public gateway.
- Ideally, expose internal routes on a separate port/bind address that only internal networks can reach.

### Service secret rotation
- Rotate `INTERNAL_SERVICE_SECRET` periodically (90 days). During rotation, services accept EITHER old or new secret for the replay window duration (dual-accept).
- Orchestrated via config push from KMS; services reload secret without restart via SIGHUP or config-watch.

### mTLS as an alternative
- mTLS (mutual TLS with client certificates) is a stronger alternative to HMAC headers.
- Requires PKI infrastructure; more operational overhead.
- HMAC headers are simpler and sufficient for this threat model when combined with network segmentation.

## Security Concerns
- **CRITICAL:** Missing `StripInternalHeadersMiddleware` at pipeline entry = external attacker spoofs `x-user-payload` = impersonation as any user/role.
- **CRITICAL:** String `===` comparison on HMAC signatures = timing-based signature recovery.
- **CRITICAL:** Missing timestamp in HMAC canonical = infinite replay window.
- **CRITICAL:** Missing bodyHash in HMAC canonical = body tampering with valid signature.
- **CRITICAL:** Internal routes exposed via public gateway without HMAC requirement.
- **CRITICAL:** Hardcoded `INTERNAL_SERVICE_SECRET` in source/env/repo.
- **HIGH:** Timestamp window > 5 minutes = expanded replay surface.
- **HIGH:** `timingSafeEqual` length-mismatch throw without dummy compare = timing signal.
- **HIGH:** No in-window replay protection (signature seen cache) = replay allowed within 5-min window.
- **MEDIUM:** Secret rotation not automated = operational risk.

## Performance Concerns
- HMAC-SHA256 compute: < 0.1ms for typical payloads. Negligible.
- Body hash for large payloads (100KB): ~1ms. Acceptable.
- Redis seen-signatures cache: ~0.3ms per check. Acceptable for sensitive routes.
- Timestamp sync (NTP) must be reliable; major clock drift = legitimate requests rejected.

## Architectural Implications
- Every service MUST load `INTERNAL_SERVICE_SECRET` from secret manager at boot. No fallback.
- `ServiceIdentityUtil` library provides `sign(canonical)`, `verify(canonical, signature)` used by all services.
- Canonical string construction centralized to avoid drift between services.
- Pipeline ordering: `StripInternalHeaders → CorrelationId → (remaining middleware)`. First position is non-negotiable.

## Domain Rule Additions
- **CRITICAL:** `StripInternalHeadersMiddleware` MUST run FIRST in the pipeline on every public-facing entry point. Strips `x-user-payload`, `x-service-*`, `x-act-as-tenant`.
- **CRITICAL:** HMAC signature comparison MUST use `crypto.timingSafeEqual`. String `===` is CRITICAL.
- **CRITICAL:** HMAC canonical MUST include `serviceIdentity + timestamp + method + path + bodyHash`. Missing any field is CRITICAL.
- **CRITICAL:** HMAC timestamp replay window MUST be <= 5 minutes. Larger window is CRITICAL.
- **CRITICAL:** `INTERNAL_SERVICE_SECRET` MUST be loaded from secret manager at boot. Hardcoding in source/env/repo is CRITICAL.
- **CRITICAL:** Internal routes MUST require ServiceIdentityGuard AND should be exposed only on internal network interfaces.
- HMAC key length MUST be 32 bytes (SHA-256 output size) per RFC 2104.
- Length mismatch before `timingSafeEqual` MUST still perform a dummy constant-time compare (avoid throw-timing signal).
- In-window replay protection via Redis signature cache (5-min TTL) for high-sensitivity routes.
- Secret rotation flow MUST support dual-accept (old + new secret) during rollout window.
