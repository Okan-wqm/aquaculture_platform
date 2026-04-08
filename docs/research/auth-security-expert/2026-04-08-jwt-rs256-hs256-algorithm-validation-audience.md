# Research: JWT Algorithm Restriction, Audience & Issuer Validation, Type Discrimination

**Date:** 2026-04-08
**Agent:** auth-security-expert
**Topic slug:** jwt-rs256-hs256-algorithm-validation-audience

## Sources
- [RFC 7519 — JSON Web Token (JWT)](https://datatracker.ietf.org/doc/html/rfc7519)
- [RFC 8725 — JWT Best Current Practices](https://www.rfc-editor.org/rfc/rfc8725.html)
- [RFC 9068 — JWT Profile for OAuth 2.0 Access Tokens](https://datatracker.ietf.org/doc/html/rfc9068)
- [OWASP JWT for Java Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [PortSwigger — JWT Algorithm Confusion Attacks](https://portswigger.net/web-security/jwt/algorithm-confusion)
- [PortSwigger — JWT none Algorithm](https://portswigger.net/kb/issues/00200901_jwt-none-algorithm-supported)
- [PortSwigger — JWT Signature Bypass Lab](https://portswigger.net/web-security/jwt/lab-jwt-authentication-bypass-via-unverified-signature)
- [Auth0 — JWT BCP Draft Analysis](https://auth0.com/blog/a-look-at-the-latest-draft-for-jwt-bcp/)

## Key Findings

### Algorithm restriction (RFC 8725 §3.1)
- Libraries MUST enable callers to specify an explicit allowed algorithm set and MUST NOT accept any other value from the header.
- JWT libraries SHOULD NOT consume JWTs using `alg: "none"` unless the caller explicitly opts in (which must never happen in production auth).
- **Every `verifyAsync()` / `verify()` call must pass `algorithms: ['RS256']` or `['HS256']` — never omit, never wildcard, never include both unless absolutely necessary.**

### Algorithm confusion attacks (PortSwigger / RFC 8725 §2.1)
- Classic attack: swap `alg: RS256` to `alg: HS256`, sign with the (public) RSA key — if the server uses the same key material for HMAC verification, the signature validates.
- Mitigation: bind each key to exactly one algorithm. RSA public keys must never reach an HMAC verifier. Key lookup must consider `alg` alongside `kid`.

### "confusing decode with verify" vulnerability
- `jwt.decode()` parses the payload WITHOUT verifying the signature. Any codebase that calls `decode()` and trusts the result is completely bypassable.
- All production code must call `verifyAsync(token, { algorithms, audience, issuer })`.

### Audience (`aud`) validation (RFC 7519 §4.1.3)
- `aud` identifies the recipients the JWT is intended for. If the receiving party is not in `aud`, the token MUST be rejected.
- In a federation gateway architecture, `aud` must identify the target service (e.g. `gateway-api`, `auth-service`). Cross-service token replay is prevented by strict `aud` check.

### Issuer (`iss`) validation (RFC 7519 §4.1.1 + RFC 9068)
- Resource servers MUST validate `iss` against a pinned expected issuer. RFC 9068 recommends publishing metadata at `.well-known/oauth-authorization-server` and pinning `jwks_uri`.

### Temporal claims (RFC 7519 §4.1.4–6)
- `exp` — current time MUST be before expiration. No leeway > 60s without strong justification.
- `nbf` — current time MUST be >= not-before. Protects against premature token use.
- `iat` — used for bulk-invalidation threshold (e.g., "all tokens issued before T are revoked for user X").

### Token type discrimination (operational pattern)
- Add custom `type` claim (`'access' | 'refresh' | 'mfa'`). Bearer authentication MUST reject tokens where `type !== 'access'`.
- Refresh tokens used as bearer = trivial privilege escalation. MFA challenge tokens used as bearer = MFA bypass.
- This is not in any RFC but is a battle-tested production hardening from Auth0/Okta.

### Signing key rotation (RFC 7517 JWKS + RFC 9068)
- Maintain `kid` header on every issued token. Verifier resolves `kid` → public key from a JWKS endpoint.
- Keep old keys in JWKS for one full access-token lifetime after rotation to avoid outages.
- Private key must be stored in KMS/HSM, never in process memory beyond its lifetime.

### RFC 9068 — JWT Profile for OAuth 2.0 Access Tokens
- Mandates `typ: "at+jwt"` in header to prevent cross-use with ID tokens.
- Mandates asymmetric signing (RS256/ES256/EdDSA) for AS → RS use cases so that RS never needs AS secret.
- Defines standard claims including `scope`, `client_id`, `roles`, `groups`, `entitlements`.

## Security Concerns
- **CRITICAL:** Any `verifyAsync()` without explicit `algorithms` is an algorithm-confusion vulnerability waiting to happen.
- **CRITICAL:** Using `jwt.decode()` (instead of `verify`) on any auth path is a signature-bypass vulnerability.
- **CRITICAL:** Missing `type` discrimination allows refresh/MFA tokens to be used as access tokens.
- **HIGH:** Missing `aud` validation allows token reuse across services.
- **HIGH:** Missing `iss` validation allows injection of attacker-issued tokens if multiple issuers exist.
- **HIGH:** Same key material for HS256 and RS256 verification = classic confusion vector.

## Performance Concerns
- JWKS caching: cache public keys in-memory with periodic refresh (5-15 min) to avoid per-request HTTP hits.
- JWT verification is ~0.1-0.3ms for HS256, ~1-2ms for RS256. RS256 is acceptable for gateway-level verification.

## Architectural Implications
- Every service verifying JWTs must receive the allowed algorithm and audience via config, not hardcoded.
- JWKS service must cache, refresh, and handle rotation gracefully.
- Token blacklist must check `jti` AND `iat < user.tokensInvalidBefore` for bulk revocation.

## Domain Rule Additions
- **CRITICAL:** Every `verifyAsync()` call MUST specify `algorithms: ['HS256']` or `['RS256']` explicitly. Wildcard or omission is a CRITICAL vulnerability.
- **CRITICAL:** `jwt.decode()` is FORBIDDEN on any request-auth path. Only `verify*()` is acceptable.
- **CRITICAL:** Every JWT MUST carry a `type` claim (`'access' | 'refresh' | 'mfa'`). JwtMiddleware/AuthGuard MUST reject anything except `type === 'access'`.
- Every JWT MUST carry and validate `aud` (target service identifier) and `iss` (auth-service).
- RS256 and HS256 signing keys MUST be separate. No shared key material between algorithms.
- JWTs MUST carry `kid` header; verification MUST resolve via JwksService with caching.
- Access token TTL <= 15 minutes, refresh token TTL <= 30 days, MFA challenge token TTL <= 5 minutes.
