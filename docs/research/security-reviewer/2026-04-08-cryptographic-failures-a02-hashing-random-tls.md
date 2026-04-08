# Research: Cryptographic Failures (OWASP A02) — Hashing, Random, TLS, Timing-Safe Comparison

**Topic:** bcrypt rounds, scrypt/argon2 alternatives, TLS cipher suites, HSTS, cert pinning, secure random (crypto.randomBytes not Math.random), timing-safe comparison
**Date:** 2026-04-08
**Agent:** security-reviewer

## Sources

- [OWASP Top 10 — A02:2021 Cryptographic Failures](https://owasp.org/Top10/A02_2021-Cryptographic_Failures/)
- [OWASP Cheat Sheet — Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Cheat Sheet — Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html)
- [OWASP Cheat Sheet — Transport Layer Security](https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html)
- [OWASP Cheat Sheet — HSTS](https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Strict_Transport_Security_Cheat_Sheet.html)
- [NIST SP 800-63B — Digital Identity Guidelines (Authentication)](https://pages.nist.gov/800-63-4/sp800-63b.html)
- [NIST SP 800-131A Rev 2 — Transitioning the Use of Cryptographic Algorithms and Key Lengths](https://csrc.nist.gov/pubs/sp/800/131/a/r2/final)
- [NIST SP 800-90A Rev 1 — Recommendation for Random Number Generation](https://csrc.nist.gov/pubs/sp/800/90/a/r1/final)
- [NIST SP 800-52 Rev 2 — Guidelines for TLS Implementations](https://csrc.nist.gov/pubs/sp/800/52/r2/final)
- [IETF RFC 8446 — TLS 1.3](https://datatracker.ietf.org/doc/html/rfc8446)
- [IETF RFC 6797 — HTTP Strict Transport Security](https://datatracker.ietf.org/doc/html/rfc6797)
- [IETF RFC 7919 — Negotiated Finite Field Diffie-Hellman](https://datatracker.ietf.org/doc/html/rfc7919)
- [Mozilla TLS Configuration Generator](https://ssl-config.mozilla.org/)
- [Argon2 RFC 9106](https://datatracker.ietf.org/doc/html/rfc9106)
- [PortSwigger Research — Cryptographic Vulnerabilities](https://portswigger.net/research)
- [CWE-327 — Use of a Broken or Risky Cryptographic Algorithm](https://cwe.mitre.org/data/definitions/327.html)
- [CWE-330 — Use of Insufficiently Random Values](https://cwe.mitre.org/data/definitions/330.html)
- [CWE-338 — Use of Cryptographically Weak Pseudo-Random Number Generator](https://cwe.mitre.org/data/definitions/338.html)
- [CWE-208 — Observable Timing Discrepancy](https://cwe.mitre.org/data/definitions/208.html)
- [Cloudflare Blog — TLS 1.3 and the Future](https://blog.cloudflare.com/tls-1-3-overview-and-q-and-a/)

## Key Findings

### 1. Password hashing — Argon2id is the new default; bcrypt is the floor
OWASP Password Storage Cheat Sheet (2024 update) and RFC 9106 converge on Argon2id as the recommended password hashing function:
- **Argon2id** (recommended): tunable memory + time + parallelism. RFC 9106 minimum: m=46MiB, t=1, p=1 (interactive) or m=19MiB, t=2, p=1 (constrained). For production SaaS, lean toward m=64-128MiB, t=3.
- **scrypt:** N=2^17 (131072), r=8, p=1 minimum.
- **bcrypt:** cost ≥ 10 (12 preferred for new deployments). 72-byte input limit means truncation — pre-hash with SHA-256 if accepting longer passwords.
- **PBKDF2-HMAC-SHA256:** ≥ 600,000 iterations (NIST SP 800-132 with safety margin). PBKDF2 is FIPS-compliant; the others are not.

**BANNED for password hashing:**
- MD5 (broken)
- SHA-1 (broken)
- SHA-256 / SHA-512 alone (no work factor — GPU brute-force trivial)
- bcrypt cost < 10
- Any custom "salt + hash + pepper" stack roll

For aqua-saas (NestJS): Argon2id via `argon2` npm package is the default; bcrypt-12 is acceptable for legacy compatibility.

### 2. Secure random — `Math.random()` is BANNED for any security-sensitive value
CWE-338 (Use of Cryptographically Weak PRNG):
- `Math.random()` in Node.js uses xorshift128+ — predictable from a few outputs.
- `Math.random()` in browsers is implementation-dependent and equally unsuitable.
- **Use `crypto.randomBytes(n)` (Node)** or `crypto.getRandomValues(arr)` (browser) for ANY of:
  - Session tokens
  - CSRF tokens
  - Password reset tokens
  - MFA codes (TOTP secrets via `speakeasy.generateSecret`, recovery codes via `crypto.randomBytes`)
  - UUIDs (use `crypto.randomUUID()` — RFC 4122 v4 cryptographically random)
  - Salt for password hashing (handled by the password library, but custom salts MUST use crypto.randomBytes)
  - Nonces for AES-GCM
  - JWT `jti` claims
  - Anonymization (GDPR-compliant pseudonymization)

A single `Math.random()` in security-relevant code = HIGH minimum, CRITICAL if used for token generation.

### 3. Timing-safe comparison — `===` BANNED for secrets
CWE-208 (Observable Timing Discrepancy):
- `if (token === expected)` short-circuits at the first non-matching byte. Attacker measures response time to deduce one byte at a time.
- This is exploited in HMAC verification, MFA code verification, password reset token comparison, API key validation.

Mitigation: `crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))` (Node).
- Both buffers MUST be the same length (else the function throws or leaks length).
- Compare on hashed values (SHA-256 of token vs SHA-256 of expected) so the buffers are always equal length AND the secret is never compared directly.

For aqua-saas: every HMAC verification, MFA code check, refresh token comparison, password reset token comparison, internal-service signature verification MUST use `crypto.timingSafeEqual`.

### 4. JWT signing — RS256/ES256 with key rotation, not HS256 with shared secret
RFC 8725 (JWT BCP) requirements:
- **HS256** (HMAC-SHA256) is appropriate ONLY when issuer and verifier are the same process. In federated multi-service architecture, verifiers must hold the secret — every service that holds the secret can FORGE tokens. HS256 in microservices = CRITICAL design flaw.
- **RS256** (RSA-2048+ with PKCS#1 v1.5) or **ES256** (ECDSA P-256) — issuer signs with private key, verifiers hold only the public key. A compromised verifier cannot forge tokens.
- **EdDSA** (Ed25519) — preferred for new deployments. Faster, smaller signatures, no curve choice ambiguity.
- **Algorithm pinning:** verifier MUST pin to expected algorithm. `alg: none` MUST be rejected. HS-when-expecting-RS algorithm confusion MUST be rejected.
- **`kid` header** — key ID for rotation. Verifier looks up the key by `kid`, falls back to a configured default (NEVER trusts the `kid` to point at an arbitrary URL — `jku`/`jwk` headers MUST be ignored or strictly allowlisted).
- **JWKS endpoint** — published over HTTPS, cached with explicit TTL, refreshed on signature verification failure.

For aqua-saas: gateway issues with RS256 (or EdDSA), every subgraph verifies with the public key from JWKS. HS256 anywhere on the auth path = CRITICAL.

### 5. TLS configuration — Mozilla "intermediate" is the floor, "modern" preferred
NIST SP 800-52r2 + Mozilla TLS Generator agreed positions:
- **TLS 1.2 and 1.3 only.** TLS 1.0/1.1 BANNED. SSLv3 and earlier BANNED.
- **TLS 1.3 cipher suites** (no choice — they are fixed in the spec):
  - TLS_AES_256_GCM_SHA384
  - TLS_CHACHA20_POLY1305_SHA256
  - TLS_AES_128_GCM_SHA256
- **TLS 1.2 cipher suites** (Mozilla intermediate):
  - ECDHE-ECDSA-AES256-GCM-SHA384
  - ECDHE-RSA-AES256-GCM-SHA384
  - ECDHE-ECDSA-CHACHA20-POLY1305
  - ECDHE-RSA-CHACHA20-POLY1305
  - ECDHE-ECDSA-AES128-GCM-SHA256
  - ECDHE-RSA-AES128-GCM-SHA256
- **BANNED in TLS 1.2:**
  - All CBC-mode ciphers (Lucky13, Padding Oracle)
  - All RC4 (broken)
  - All 3DES (Sweet32)
  - All NULL ciphers
  - All EXPORT ciphers
  - All anonymous DH ciphers
- **DH parameter** ≥ 2048 bits (RFC 7919 named groups: `ffdhe2048`, `ffdhe3072`, `ffdhe4096`).
- **Curve preference:** X25519 > P-256 > P-384.
- **OCSP stapling** enabled.
- **Session ticket rotation** every 24h max.
- **0-RTT (TLS 1.3)** disabled for state-changing endpoints (replay attack).

### 6. HSTS — `max-age` ≥ 1 year, `includeSubDomains`, `preload`
RFC 6797 + Mozilla HSTS guidance:
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (2 years)
- `max-age` < 1 year is too short for browser cache to provide meaningful protection.
- `includeSubDomains` is mandatory unless a subdomain MUST run plain HTTP (rare).
- `preload` opts the domain into the Chrome HSTS preload list — bakes HSTS into the browser before first visit.
- Once preloaded, removal takes months — only set `preload` when you are confident in your TLS deployment.

### 7. Other security headers — Mozilla Observatory baseline
- `Content-Security-Policy: default-src 'self'; script-src 'self' 'nonce-{random}'; ...` — no `unsafe-inline`, no `unsafe-eval`.
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY` (or CSP `frame-ancestors 'none'`)
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp` (enables SharedArrayBuffer)
- `Cross-Origin-Resource-Policy: same-site`
- **Trusted Types** (W3C): `Content-Security-Policy: require-trusted-types-for 'script'` — eliminates DOM-based XSS at the sink level.

### 8. Encryption at rest — AES-256-GCM with envelope encryption
NIST SP 800-38D (GCM mode) + AWS KMS / GCP KMS guidance:
- **AES-256-GCM** is the symmetric primitive (NIST-approved, AEAD, fast in hardware).
- **Envelope encryption:** data encrypted with a per-record DEK, DEK encrypted with a per-tenant KEK, KEK stored in KMS.
- **Nonce discipline:** GCM nonce MUST be unique per (key, plaintext). 96-bit random nonce is acceptable up to ~2^32 messages per key.
- **No CBC mode** — padding oracle vulnerabilities, no authentication.
- **No ECB mode** — patterns leak.
- **MFA secrets, refresh tokens, password reset tokens, recovery codes:** ALL must be column-level encrypted with AES-256-GCM, NOT just relying on full-disk encryption.
- **Refresh tokens stored hashed (bcrypt cost 10 or SHA-256 of token + per-record salt) so a DB dump does not yield usable tokens.**

### 9. Key management — KMS or sealed file, never plain env vars
NIST SP 800-57 + cloud KMS best practices:
- Long-lived secrets (signing keys, encryption keys) MUST be in a KMS (AWS KMS, GCP KMS, HashiCorp Vault, Azure Key Vault) — never in environment variables, never in config files committed to git.
- Application reads the secret at startup via the `_FILE` convention or KMS API; secret is held in memory only.
- Secrets MUST be rotatable without redeploy (versioned secrets, dual-version reader).
- Key rotation cadence: signing keys ≤ 90 days, encryption keys ≤ 1 year, with envelope encryption allowing background re-encryption.

## Security Concerns

- **Password hashing weaker than bcrypt cost 10 / Argon2id default = CRITICAL.**
- **MD5 / SHA-1 used anywhere for security purpose (passwords, MAC, file integrity for security) = CRITICAL.**
- **`Math.random()` for any security-sensitive value (token, salt, nonce, ID) = HIGH** (CRITICAL if used for tokens).
- **`===` comparison on secrets / HMAC / MFA codes / tokens = HIGH** (timing oracle).
- **HS256 JWT in microservices (any verifier holds the signing secret) = CRITICAL.**
- **JWT verifier accepts `alg: none` OR doesn't pin the algorithm = CRITICAL** (algorithm confusion).
- **JWT verifier honors `jku`/`jwk`/`x5u` headers = CRITICAL** (key injection).
- **Missing JWT claim validation (iss, aud, exp, nbf, iat, jti) = HIGH.**
- **TLS 1.0 / 1.1 / SSLv3 enabled = CRITICAL.**
- **TLS 1.2 with CBC-mode ciphers, RC4, 3DES, EXPORT, NULL = HIGH.**
- **DH parameter < 2048 bits = HIGH.**
- **HSTS missing OR `max-age` < 1 year = HIGH.**
- **HSTS without `includeSubDomains` (when applicable) = MEDIUM.**
- **CSP with `unsafe-inline` / `unsafe-eval` = HIGH.**
- **AES-CBC for column encryption (no AEAD) = HIGH.**
- **AES-GCM with reused nonce = CRITICAL** (confidentiality break).
- **Encryption key in environment variable instead of KMS = HIGH.**
- **Refresh tokens stored plaintext in DB = CRITICAL.**
- **MFA secrets stored plaintext in DB = CRITICAL.**
- **Recovery codes stored plaintext in DB = CRITICAL.**
- **0-RTT TLS 1.3 enabled on state-changing endpoints = HIGH** (replay).
- **OCSP stapling not enabled = MEDIUM.**

## Performance Concerns

- Argon2id with high memory parameter (256+ MiB) on a constrained instance can DoS the auth service; tune to fit memory budget × peak login concurrency.
- bcrypt cost increase from 10 to 12 quadruples auth latency — capacity-plan accordingly.
- TLS 1.3 handshake is ~1 RTT vs TLS 1.2's 2 RTT — net-positive performance.
- ChaCha20-Poly1305 is faster than AES-GCM on CPUs without AES-NI (mobile, edge devices); preferred for IoT/edge clients.
- KMS calls per request blow up latency — wrap KMS-derived data keys, cache decrypted DEK for the request lifetime.

## Architectural Implications for security-reviewer

When reviewing any change touching cryptography, the agent MUST verify:
1. Password hashing uses Argon2id (preferred) or bcrypt cost ≥ 10. No raw SHA-256 or MD5.
2. ALL random values for security purposes use `crypto.randomBytes` / `crypto.getRandomValues` / `crypto.randomUUID`. No `Math.random()`.
3. ALL secret comparisons use `crypto.timingSafeEqual` on equal-length hashed values. No `===`.
4. JWT signing is RS256/ES256/EdDSA in any multi-service setup. HS256 is CRITICAL except in single-process contexts.
5. JWT verification pins the algorithm, validates iss/aud/exp/nbf/iat/jti, rejects `jku`/`jwk` headers.
6. TLS 1.2 and 1.3 only. AES-GCM and ChaCha20-Poly1305 only. DH ≥ 2048.
7. HSTS `max-age` ≥ 1 year with `includeSubDomains`.
8. CSP with no `unsafe-inline` or `unsafe-eval`. Other security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP/COEP/CORP, Trusted Types where applicable).
9. Column-level encryption uses AES-256-GCM with unique nonces. Envelope encryption with per-tenant KEK.
10. Refresh tokens, MFA secrets, recovery codes, password reset tokens are stored hashed/encrypted, never plaintext.
11. Encryption keys live in KMS or sealed files, not environment variables.
12. 0-RTT TLS 1.3 disabled on state-changing endpoints.

## Domain Rule Additions for security-reviewer

- Password hashing weaker than bcrypt cost 10 / Argon2id default = CRITICAL.
- MD5 / SHA-1 in any security-relevant role (passwords, file integrity for trust, HMAC) = CRITICAL.
- `Math.random()` for tokens/salts/nonces = CRITICAL; for any other security-sensitive value = HIGH.
- `===` comparison on secrets / HMACs / tokens / MFA codes = HIGH (timing oracle).
- HS256 JWT in any multi-service architecture = CRITICAL (verifier-as-forger).
- JWT verifier accepting `alg: none`, honoring `jku`/`jwk`/`x5u`, or missing algorithm pin = CRITICAL.
- JWT missing iss/aud/exp/nbf/iat/jti validation = HIGH.
- TLS 1.0/1.1/SSLv3 enabled = CRITICAL.
- TLS 1.2 with CBC / RC4 / 3DES / EXPORT / NULL ciphers = HIGH.
- HSTS missing OR `max-age` < 1 year = HIGH.
- CSP with `unsafe-inline` or `unsafe-eval` = HIGH.
- AES-CBC for column encryption (no AEAD) = HIGH.
- AES-GCM with reused or sequential nonce = CRITICAL.
- Long-lived secret (signing key, KEK) in environment variable instead of KMS = HIGH.
- Refresh tokens / MFA secrets / recovery codes / password reset tokens stored plaintext = CRITICAL.
- 0-RTT TLS 1.3 enabled on state-changing endpoints = HIGH (replay).
- OCSP stapling not enabled on production TLS = MEDIUM.
- Trusted Types directive missing on web frontends with dynamic DOM sinks = MEDIUM (DOM XSS exposure).
