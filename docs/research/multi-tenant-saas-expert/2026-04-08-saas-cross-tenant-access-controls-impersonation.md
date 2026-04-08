# Research: Cross-Tenant Access Controls and SUPER_ADMIN Impersonation

**Topic:** SUPER_ADMIN impersonation via X-Act-As-Tenant, UUID validation, MFA step-up, dual-identity audit with recordAwait, break-glass
**Date:** 2026-04-08
**Agent:** multi-tenant-saas-expert

## Sources

- NIST SP 800-63B, "Digital Identity Guidelines — Authentication and Lifecycle Management": https://pages.nist.gov/800-63-3/sp800-63b.html — AAL2 / AAL3 authenticator requirements.
- NIST SP 800-53 rev 5, IA-2(2) and AU-2 — multi-factor for privileged accounts and audit event coverage.
- NIST SP 800-53 rev 5, AU-8 — time sync for audit authoritative timestamps.
- OMB M-22-09 / CISA Zero Trust — phishing-resistant MFA for privileged actions.
- OWASP Authorization Cheat Sheet — break-the-glass patterns.
- Microsoft Learn, "Plan for mandatory Microsoft Entra multifactor authentication": https://learn.microsoft.com/en-us/entra/identity/authentication/concept-mandatory-multifactor-authentication — break-glass + MFA guidance.
- Auth0 documentation on impersonation & logging.
- Aqua-saas codebase: `libs/backend-common/src/guards/tenant.guard.ts` (lines 120-152 handle X-Act-As-Tenant + MFA step-up + recordAwait audit), `apps/admin-api-service/src/impersonation/` entities.

## Key Findings

1. **X-Act-As-Tenant is the ONLY sanctioned cross-tenant entry point.** Any other path that takes a tenantId from the request body, query string, or generic header is a CRITICAL finding. This rule exists because multiple input sources multiply the audit and review surface.
2. **Only SUPER_ADMIN JWTs may present `X-Act-As-Tenant`.** Any other role presenting the header receives 403 and emits a security audit event. The role must be read from the signed JWT claims post-verification, never from a mutable/ambient source.
3. **Header value must be strictly UUID-validated** (`UUID_REGEX`) and looked up in the tenant registry. Non-existent or PURGED tenants return 403 (NOT 404 — 404 enables tenant enumeration).
4. **MFA step-up required** on every cross-tenant access (when source tenant ≠ target tenant). Login-time MFA is stale and insufficient. The MFA step-up token is short-lived (5 min) and operation-scoped. Per NIST SP 800-63B AAL2+, step-up MFA is required for sensitive operations.
5. **Dual-identity audit is non-negotiable.** Every action performed during an active impersonation session must log BOTH the real SUPER_ADMIN user AND the impersonated tenant/user. Single-identity rows during an active session are CRITICAL findings.
6. **`recordAwait()` pattern** — the audit write for cross-tenant access is AWAITED before the request proceeds. Fire-and-forget audit on a cross-tenant access is a CRITICAL compliance gap — a silent DB failure leaves no forensic trail.
7. **Tenant scope lives in a distinct request field.** Conflating `X-Act-As-Tenant` with `req.user.tenantId` is the #1 multi-tenant SaaS security bug. The target tenant lives in `req.tenantScope` (or equivalent), and `req.user` remains the real identity.
8. **Background jobs enqueued during cross-tenant requests must serialize tenant scope into the job payload.** Reading tenant scope from AsyncLocalStorage in a worker is a CRITICAL finding — the worker runs in a different async context and would leak or misroute.
9. **Break-glass emergency access** uses dedicated named accounts with offline-stored credentials, hardware-backed authenticators (FIDO2/WebAuthn), continuous monitoring, and automatic high-priority alerting. Per NIST 800-63B AAL3 and OMB M-22-09. Break-glass use is always an incident (paging rotation notified) even when used correctly.
10. **Impersonation session TTLs.** Absolute TTL ≤ 1 hour AND inactivity TTL ≤ 15 min, both server-enforced (client UI timers insufficient). Write-mode requires an explicit toggle that is itself audited and alerted.
11. **Session-wide rate limit** on cross-tenant access per SUPER_ADMIN (e.g., ≤ 10 distinct tenants / minute) to detect anomalous scraping.
12. **IP / device fingerprint change during active session** terminates the session and emits a security event.
13. **Audit event coverage** must include: actor_user_id, actor_home_tenant_id, acted_on_tenant_id, endpoint, http_method, resource_type, resource_id, justification (required for writes), ip, user_agent, request_id, mfa_verified, result.

## Security Concerns

- **`getRepository()` inside an impersonation session** bypasses tenant scoping for the target tenant and causes CRITICAL cross-tenant data leaks.
- **Fire-and-forget audit** on SUPER_ADMIN cross-tenant actions = CRITICAL compliance gap (SOC2 / ISO 27001 failure).
- **Tenant enumeration via 404 vs 403 differential** = HIGH — non-existent and forbidden targets must return the same response.
- **`req.user` rewriting on X-Act-As-Tenant** = CRITICAL (conflates actor with target).
- **Background worker reading tenant scope from CLS / AsyncLocalStorage** = CRITICAL (wrong-tenant execution).
- **Login-time MFA only (no step-up)** = HIGH — a stolen session token can be used to enter any tenant without re-authentication.
- **Missing session termination on IP change** = HIGH (session hijacking window).

## Performance Concerns

- **recordAwait blocks the request** on audit write — acceptable because cross-tenant access is a low-volume operation. Audit DB must be sized for synchronous writes.
- **Audit event fan-out** to SIEM via NATS JetStream — asynchronous, not blocking.
- **Tenant registry lookup cache** — keep tenant existence + status in a 30-60s cache to avoid DB hit per request.

## Architectural Implications for multi-tenant-saas-expert reviews

- Flag any code path reading `tenantId` from request body / query / generic header for regular users as CRITICAL.
- Flag any `X-Act-As-Tenant` handling outside the central guard/middleware as CRITICAL.
- Flag missing UUID validation on `X-Act-As-Tenant` as CRITICAL.
- Flag `req.user` mutation based on `X-Act-As-Tenant` as CRITICAL.
- Flag missing MFA step-up on cross-tenant write as CRITICAL; on cross-tenant read as HIGH.
- Flag single-identity audit rows during active impersonation as CRITICAL.
- Flag fire-and-forget audit on cross-tenant access as CRITICAL.
- Flag background jobs reading tenant scope from AsyncLocalStorage (as opposed to job payload) as CRITICAL.
- Flag missing rate limit on cross-tenant access per SUPER_ADMIN as HIGH.
- Flag any `RequiresManualReconciliation` in audit alerting as HIGH until investigated.

## Domain Rule Additions for multi-tenant-saas-expert

- **X-Act-As-Tenant is the only cross-tenant entry point.** Any other source of `tenantId` for regular users = CRITICAL.
- **Only SUPER_ADMIN may present X-Act-As-Tenant.** Other roles → 403 + audit. Role read from signed JWT claims only.
- **Header UUID-validated + registry lookup.** Non-existent / PURGED tenants return 403 (never 404 — enumeration gap).
- **MFA step-up required on cross-tenant access.** Short-lived (≤ 5 min) operation-scoped token. Missing = CRITICAL (writes), HIGH (reads).
- **`req.tenantScope` distinct from `req.user.tenantId`.** Rewriting `req.user` = CRITICAL.
- **Dual-identity audit on every action during impersonation.** Single-identity row = CRITICAL.
- **`recordAwait()` pattern mandatory** for cross-tenant audit writes. Fire-and-forget = CRITICAL.
- **Session TTLs:** absolute ≤ 1h, inactivity ≤ 15 min, server-enforced.
- **Session-wide cross-tenant rate limit** ≤ 10 distinct tenants / minute per SUPER_ADMIN. Missing = HIGH.
- **Background jobs serialize tenant scope into job payload.** Reading from AsyncLocalStorage in worker = CRITICAL.
- **IP / device fingerprint change terminates session** and emits security event. Missing = HIGH.
- **Break-glass accounts use FIDO2/WebAuthn**, offline credentials, alert-on-use. Per NIST SP 800-63B AAL3 and OMB M-22-09.
- **Audit event fields mandatory:** actor_user_id, actor_home_tenant_id, acted_on_tenant_id, endpoint, http_method, resource_type, resource_id, justification (required for writes), ip, user_agent, request_id, mfa_verified, result.
