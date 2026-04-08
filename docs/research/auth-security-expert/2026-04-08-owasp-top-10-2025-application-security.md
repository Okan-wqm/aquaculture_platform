# Research: OWASP Top 10 2025 — Application Security for NestJS Backend

**Date:** 2026-04-08
**Agent:** auth-security-expert
**Topic slug:** owasp-top-10-2025-application-security

## Sources
- [OWASP Top 10:2025 Introduction](https://owasp.org/Top10/2025/0x00_2025-Introduction/)
- [OWASP Top 10:2025 Landing Page](https://owasp.org/Top10/2025/)
- [OWASP Top 10:2021 Reference](https://owasp.org/Top10/2021/)
- [OWASP Top 10:2021 A01 Broken Access Control](https://owasp.org/Top10/2021/A01_2021-Broken_Access_Control/)
- [OWASP Top 10:2021 A05 Security Misconfiguration](https://owasp.org/Top10/2021/A05_2021-Security_Misconfiguration/)
- [OWASP Top 10:2021 A08 Software and Data Integrity Failures](https://owasp.org/Top10/2021/A08_2021-Software_and_Data_Integrity_Failures/)
- [OWASP ASVS 5.0](https://github.com/OWASP/ASVS)
- [OWASP Cheat Sheet Series Index](https://cheatsheetseries.owasp.org/)
- [OWASP Developer Guide — Top 10](https://devguide.owasp.org/en/07-training-education/05-top-ten/)

## Key Findings

### The 2025 list (RC1, stable ordering)
1. **A01:2025 — Broken Access Control** (remains #1). Now explicitly absorbs SSRF (previously A10:2021). Spans 40 CWEs, 3.73% of tested apps carry at least one.
2. **A02:2025 — Security Misconfiguration** (moved up from #5). 16 CWEs, 3.00% prevalence. Default creds, verbose errors, unhardened cloud configs, missing security headers.
3. **A03:2025 — Software Supply Chain Failures** (expansion of A06:2021 Vulnerable and Outdated Components). Covers build-system compromise, dependency confusion, typosquatting, malicious package maintainers, unsigned artifacts, lockfile bypass.
4. **A04:2025 — Cryptographic Failures** (demoted from A02:2021). Weak TLS, hardcoded keys, weak hashing (MD5/SHA-1), ECB mode, unauthenticated encryption (CBC without MAC).
5. **A05:2025 — Injection** (demoted from A03:2021). Still includes classic SQLi/NoSQLi/LDAPi/OSi/XSS (XSS merged here since 2021).
6. **A06:2025 — Insecure Design** (unchanged position). Threat modeling, secure design patterns, reference architectures.
7. **A07:2025 — Authentication Failures** (renamed from "Identification and Authentication Failures"). Credential stuffing, weak password recovery, session fixation, missing MFA.
8. **A08:2025 — Software or Data Integrity Failures** (near-unchanged). Insecure deserialization, unsigned auto-updates, CI/CD pipeline integrity.
9. **A09:2025 — Security Logging & Alerting Failures** (renamed from "...Monitoring Failures" to emphasize *alerting*). Missing auth log events, no alert routing, log tampering.
10. **A10:2025 — Mishandling of Exceptional Conditions** (NEW category). Poor error handling that leaks state, stack traces, or bypasses guards during exceptions.

### Major structural changes vs 2021
- **SSRF absorbed into A01** (no longer standalone) — access-control scope expanded to outbound requests.
- **Supply chain elevated to #3** — the SolarWinds/xz-utils/event-stream era demanded its own tier.
- **New A10 (Exceptional Conditions)** — NestJS exception filters, try/catch that silently swallows auth failures, fallthrough states.
- **Misconfiguration promoted to #2** — infra-as-code drift, unhardened container images, default NestJS CORS wide-open.

### Concrete checks per category for NestJS backends
- **A01:** Every resolver/controller has `@UseGuards(TenantGuard, RolesGuard, TenantPermissionGuard)`. No `@Public()` on mutations that mutate tenant data. IDOR guard on all `:id` params. Explicit `tenantId` filter in every repository query (scoped repository pattern).
- **A02:** CORS origin allowlisted (no `*`), Helmet CSP enforced, `x-powered-by` removed, NODE_ENV=production pinned, environment variable validation via `class-validator` on boot, no `synchronize: true` on TypeORM in production.
- **A03:** `npm audit --production` in CI, Renovate/Dependabot pinned to lockfile-only updates, `npm ci` (never `npm install`) in Docker, signed container images, SBOM generation (CycloneDX), package integrity checksums.
- **A04:** bcrypt rounds >= 12, AES-256-GCM for encryption at rest, TLS 1.3 only, HSTS with preload, no secrets in source/env files at rest (use Vault/KMS), refresh tokens bcrypt-hashed before DB storage.
- **A05:** TypeORM parameterized queries only (no `.query()` with string interpolation), input validation via `class-validator` ValidationPipe with `whitelist: true, forbidNonWhitelisted: true`, HTML escape on all output, SQL identifier regex validation for schema names.
- **A06:** Threat model each domain before coding, rate limit sensitive endpoints, defense in depth (guard + service-layer check), secure defaults (deny-by-default on new RBAC permissions).
- **A07:** MFA enforced for admins, 5/15-min account lockout, bcrypt password hashing, TOTP RFC 6238 with AES-GCM secret encryption, refresh token rotation with reuse detection.
- **A08:** Signed NATS/event payloads where integrity matters, no `eval()`/`Function()` constructors, no `JSON.parse` on unverified data, CI pipeline secrets scoped per job.
- **A09:** All auth events (login, logout, MFA fail, lockout) emitted to SecurityEventService and persisted via AuditLogService. Alerts routed on failed-login spikes, SUPER_ADMIN actions, cross-tenant attempts.
- **A10:** NestJS ExceptionFilter never exposes stack traces in production, error responses never reveal "user not found" vs "wrong password", guards must fail-closed (no catch-swallow-allow patterns).

## Security Concerns
- **CRITICAL:** A10 (Exceptional Conditions) is brand-new — existing codebases likely have catch blocks that silently continue on auth failures. Audit every `try/catch` in guards, middleware, and interceptors.
- **CRITICAL:** A02 jumped to #2. Any CORS wildcard, missing Helmet, or `synchronize: true` on TypeORM is a top-2 OWASP risk.
- **HIGH:** A03 promotion means unpinned dependencies (semver ranges), unverified NPM installs, and unsigned Docker images are now top-3 risks.
- **HIGH:** SSRF now under A01 means outbound HTTP calls (especially webhooks, image fetching, URL previews) need allowlisting.

## Performance Concerns
- Helmet + CSP adds ~1-3ms per request but is non-negotiable.
- SBOM generation in CI adds ~30-60s per build.
- `forbidNonWhitelisted: true` on ValidationPipe adds minor overhead but prevents mass-assignment.

## Architectural Implications
- Exception handling needs audit: every NestJS ExceptionFilter, guard catch block, and interceptor must fail-closed.
- Supply chain hardening requires CI pipeline changes: signed images, lockfile enforcement, vulnerability scanning gates.
- Outbound HTTP (webhooks, external APIs) needs a central allowlisted HTTP client.

## Domain Rule Additions
- **A10 compliance:** ExceptionFilter MUST NOT swallow or downgrade authorization errors. Any `catch` in a guard/middleware that returns `true`/`allow` is CRITICAL.
- **A02 compliance:** CORS origin list explicit, Helmet enabled, `x-powered-by` disabled, TypeORM `synchronize: false` in non-dev environments, env schema validated on boot.
- **A03 compliance:** `package-lock.json` committed and used via `npm ci`, dependencies pinned or Renovate-managed, SBOM published per release.
- **A01 SSRF absorption:** outbound HTTP requests (webhooks, image preview, URL scraping) MUST go through an allowlist-enforcing HTTP client service.
