# Research: Refresh Token Rotation, bcrypt Storage, Blacklist Patterns

**Date:** 2026-04-08
**Agent:** auth-security-expert
**Topic slug:** refresh-token-rotation-bcrypt-storage-blacklist

## Sources
- [OWASP OAuth2 Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [Auth0 — Refresh Token Rotation Docs](https://auth0.com/docs/secure/tokens/refresh-tokens/refresh-token-rotation)
- [Auth0 — Securing SPAs with Refresh Token Rotation](https://auth0.com/blog/securing-single-page-applications-with-refresh-token-rotation/)
- [Okta Developer — Refresh Access Tokens and Rotate Refresh Tokens](https://developer.okta.com/docs/guides/refresh-tokens/main/)
- [RFC 8725 — JWT BCP](https://www.rfc-editor.org/rfc/rfc8725.html)

## Key Findings

### Refresh token rotation (OWASP OAuth2 Cheat Sheet + Auth0)
- Every refresh token exchange MUST return a NEW refresh token and IMMEDIATELY invalidate the old one.
- This enables **reuse detection**: if an already-invalidated refresh token is presented, the server knows the token was either stolen or the legitimate client lost a race. Either way, the entire token family for that user/session is invalidated and the user forced to re-authenticate.
- OWASP: "Refresh tokens should use refresh token rotation (issuing new refresh tokens and invalidating old ones immediately to detect replay attempts)."
- Auth0: "When Auth0 recognizes that a refresh token is being reused, it immediately invalidates the refresh token family, including the most recently issued token."

### Token family / lineage tracking
- Each refresh token chain has a `familyId` (or parent pointer). On reuse detection, invalidate ALL tokens with that `familyId`.
- Alternative: maintain a `previousTokenJti` field; on reuse, walk the chain and invalidate.
- Simpler implementation: store `userId + sessionId` on refresh tokens; on reuse detection, invalidate all tokens for that session.

### bcrypt rounds (OWASP Password Storage Cheat Sheet)
- OWASP ASVS: "if bcrypt is used, the work factor should be as large as verification server performance will allow, with a minimum of 10."
- Argon2id is preferred for passwords; bcrypt is the accepted legacy option.
- For refresh tokens specifically, **12 rounds is the enterprise-accepted baseline** (takes ~300ms on modern CPUs, acceptable for login but too slow for every request — refresh is infrequent).
- bcrypt 72-byte input limit matters: refresh tokens (JWTs or random 32-byte values) should be HMAC-SHA-256 pre-hashed before bcrypt if they exceed 72 bytes.

### Refresh token storage (OWASP)
- Refresh tokens MUST be bcrypt-hashed before database storage. A DB compromise must not yield usable tokens.
- Alternative: AES-GCM encrypt with KMS-managed key. bcrypt is preferred when verification dominates the access pattern.
- Never store refresh tokens in plaintext, not even temporarily.

### Blacklist patterns
- **Per-JTI blacklist:** Redis key `blacklist:jti:{jti}` with TTL = remaining token lifetime. O(1) lookup per request.
- **Per-user bulk invalidation:** Redis key `user:{userId}:tokensInvalidBefore` set to current epoch on logout-everywhere/password-change/role-change. Verifier rejects tokens where `iat < tokensInvalidBefore`.
- **Composite check:** `isValidToken(jti, userId, iat)` = `NOT blacklisted(jti) AND iat >= tokensInvalidBefore(userId)`.
- **Blacklist ordering:** check MUST happen BEFORE `req.user` is assigned. A blacklisted token must never populate request context.

### TokenRevocationService patterns
- `revokeToken(jti)` — single token (logout).
- `revokeAllForUser(userId)` — bulk (password change, force-logout-all, role change).
- `revokeAllForTenant(tenantId)` — emergency (tenant offboarding, compromise).
- Every revocation emits a SecurityEvent via NATS for audit.

### Refresh token TTL and rotation interval
- OWASP session management: "absolute timeout regardless of activity." Refresh tokens SHOULD have an absolute max lifetime.
- Industry default: refresh TTL 30 days, access TTL 15 minutes, idle timeout 7 days.
- Rotation: every access-token refresh issues a new refresh token (automatic rotation).

## Security Concerns
- **CRITICAL:** Refresh tokens stored in plaintext in DB = full account takeover on DB compromise.
- **CRITICAL:** Blacklist check AFTER `req.user` assignment = blacklisted tokens still populate context.
- **CRITICAL:** No refresh token rotation = stolen refresh token valid for full 30 days.
- **HIGH:** Missing reuse detection = impossible to distinguish legitimate from stolen refresh token use.
- **HIGH:** bcrypt rounds < 12 = faster dictionary attacks on DB leak.
- **HIGH:** `revokeAllForUser` missing on password change = old sessions remain valid after compromise.
- **MEDIUM:** Per-JTI blacklist without `iat` bulk check = cannot mass-revoke efficiently.

## Performance Concerns
- bcrypt(12) ≈ 300ms. Acceptable on login (once) and refresh (infrequent). Never per-request.
- Per-JTI blacklist check on every request = ~0.5ms Redis GET. Acceptable.
- `tokensInvalidBefore` check = cached in JWT middleware with short TTL (30s) to avoid per-request Redis GET for same user.

## Architectural Implications
- TokenRevocationService is a critical dependency — must be highly available. Redis clustering + in-memory fallback.
- Blacklist TTL must equal remaining token lifetime. Setting longer TTL wastes memory; shorter TTL creates bypass window.
- Refresh token rotation requires DB write on every refresh — ensure idempotency for concurrent requests (lock on parent token).

## Domain Rule Additions
- **CRITICAL:** Refresh tokens MUST be bcrypt-hashed (rounds >= 12) before DB storage. `HASH_REFRESH_TOKENS=false` MUST be rejected in production.
- **CRITICAL:** Every refresh exchange MUST rotate the refresh token (issue new, invalidate old). No long-lived refresh tokens.
- **CRITICAL:** Refresh token reuse MUST trigger full family/session invalidation and emit a SecurityEvent.
- **CRITICAL:** Blacklist check in JwtMiddleware MUST happen BEFORE `req.user` assignment.
- **CRITICAL:** `isValidToken()` MUST compose per-JTI blacklist check AND per-user `iat >= tokensInvalidBefore` check.
- Password change, email change, role change, and SUPER_ADMIN revocation MUST call `revokeAllForUser`.
- bcrypt rounds MUST be >= 12 for refresh tokens. Lower values are CRITICAL.
- Refresh tokens over 72 bytes MUST be HMAC-SHA-256 pre-hashed before bcrypt (bcrypt input limit).
