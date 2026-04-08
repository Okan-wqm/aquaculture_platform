# Research: Impersonation Security, MFA Step-Up, and Dual-Identity Audit

**Topic:** SUPER_ADMIN impersonation patterns, MFA step-up enforcement, session time limit, dual-identity audit log, incident response
**Date:** 2026-04-08
**Agent:** admin-expert

## Sources

- [Authentication Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Session Management Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [Multifactor Authentication Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html)
- [Logging Cheat Sheet — OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [NIST SP 800-63B Session Management](https://pages.nist.gov/800-63-4/sp800-63b/session/)
- [NIST SP 800-53 Rev 5 (AC-2, AU-14, IA-2)](https://csrc.nist.gov/CSRC/media/Projects/risk-management/800-53%20Downloads/800-53r5/SP_800-53_v5_1-derived-OSCAL.pdf)
- [Architectural Considerations for Identity in a Multitenant Solution — Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/guide/multitenant/considerations/identity)
- [Impersonation Flow Approaches with OAuth/OIDC — Curity](https://curity.io/resources/learn/impersonation-flow-approaches/)
- [The Risks of User Impersonation — Authress](https://authress.io/knowledge-base/academy/topics/user-impersonation-risks)
- [Measures Against Application Impersonation — Auth0 Docs](https://auth0.com/docs/secure/security-guidance/measures-against-app-impersonation)
- [A Comprehensive Guide to Auth0 Security for Identity Attacks — Auth0 Blog](https://auth0.com/blog/comprehensive-guide-auth0-security-identity-attacks/)
- [Conditional Access: Session Controls — Microsoft Learn](https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-conditional-access-session)

## Key Findings

### 1. MFA step-up is mandatory for impersonation initiation
OWASP MFA Cheat Sheet and NIST SP 800-63B converge on the same rule: MFA is non-negotiable for administrative or high-privileged users, and must be re-asserted as step-up authentication whenever the user crosses into a higher-risk operation. Impersonation is textbook high-risk because the resulting session carries the authority of both the real admin and the impersonated principal. Step-up MUST happen at the impersonation-initiation endpoint, not just at login — login-time MFA alone is insufficient because the admin's session may be hours old.

### 2. Session lifetime for impersonation must be bounded by the strictest AAL
NIST SP 800-63B session rules (most aggressive tier, AAL3):
- **Overall timeout:** no more than 12 hours.
- **Inactivity timeout:** no more than 15 minutes.
- For AAL2: overall ≤ 24h, inactivity ≤ 1h.

Impersonation sessions should follow AAL3 limits even if normal admin sessions run at AAL2, because impersonation concentrates blast radius. A 1-hour absolute cap (as the platform currently uses) is acceptable and arguably more conservative than NIST's AAL3 ceiling, but inactivity timeout must also be enforced server-side — not only via client UI.

### 3. Dual-identity audit is not optional — it is the only audit format that works
Authress and Curity both stress that during impersonation the token/session represents *subject = impersonated user* but the *actor = real admin*. Every downstream audit entry must persist both identities. A single-identity log entry is actively misleading: it either blames the impersonated user for admin actions (incident response blind spot) or hides the impersonated user context (compliance blind spot). OAuth token exchange (RFC 8693) formalizes this with `act` (actor) and `sub` (subject) claims.

Minimum dual-identity audit fields:
- `real_user_id` (the SUPER_ADMIN performing the impersonation)
- `real_user_email_hash` (hashed PII)
- `impersonated_user_id`
- `impersonated_tenant_id`
- `impersonation_session_id` (correlation key joining every action in one session)
- `reason` / `support_ticket_id` (business justification, required field)
- `initiated_at`, `expires_at`, `terminated_at`, `termination_reason`
- `ip_address`, `user_agent`, `mfa_method_used`
- On every subsequent action: `action`, `resource`, `status`, both identities repeated

### 4. Business justification must be captured before the session starts
Auth0, Authress, and PAM best practices require a documented reason (linked support ticket ID or free-text justification) recorded BEFORE impersonation begins. This converts impersonation from a silent backdoor into a reviewable workflow. Reviews in audit log queries should be filterable by `support_ticket_id`.

### 5. Read-only impersonation vs. full impersonation
Curity and Auth0 recommend a two-tier model:
- **Shadow / read-only impersonation:** admin sees what the user sees but cannot mutate state. No writes, no actions that cause side effects (no order placement, no email sends, no config changes).
- **Full impersonation:** admin may mutate state. Requires stronger justification, shorter TTL, and explicit "write mode" toggle that itself is audited.

Most support operations should use read-only. Write impersonation should be the exception and should trigger additional alerting (Slack/PagerDuty notification, not just audit row).

### 6. Incident response: session revocation and continuous evaluation
Microsoft Entra Conditional Access exposes Continuous Access Evaluation (CAE) as the way to revoke impersonation sessions in near-real-time if risk signals fire. Equivalent platform requirements:
- Impersonation sessions MUST be listed in an admin "active sessions" dashboard.
- Any admin (or automated rule) MUST be able to terminate an impersonation session immediately, and termination MUST propagate to all requests in flight (not just the next login).
- Terminated sessions MUST emit a security event that is alertable.

### 7. Token theft defense
Auth0 and Microsoft both note that "the only effective defense against session/token theft is aggressive control of lifetime and inactivity timers." Impersonation tokens should therefore be:
- Short-lived (≤ 1h absolute).
- Single-audience (bound to a specific tenant via the impersonation claim).
- Non-refreshable (no silent refresh — require fresh MFA step-up).
- Bound to the original client (IP/device fingerprint change SHOULD terminate the session).

## Security Concerns

- **Ambient impersonation:** if the `X-Act-As-Tenant` header is allowed without a matching active ImpersonationSession, a stolen SUPER_ADMIN JWT is equivalent to a breach of every tenant. The two mechanisms (tenant-switching header vs. user-impersonation token) must not be conflated.
- **MFA bypass by replay:** if step-up MFA is verified once and the verification is cached longer than the impersonation session, an attacker who gets a session cookie can reinitiate impersonation without a second factor. Cache must be keyed to the specific impersonation request, not the admin session.
- **Log tampering via impersonated user:** if the impersonated user can write audit rows (e.g., through a reachable endpoint), they may contaminate the audit trail. Audit writes must happen from a privileged, non-user-controlled code path.
- **Silent expiration:** if the frontend does not detect session expiration, the admin believes they're still impersonating while the backend has already dropped context — next mutating request may execute against the admin's own tenant, which is a cross-tenant leak in reverse. Expiration must be observable in both directions.
- **Debug tool escalation:** cache inspector, query inspector, API call inspector MUST NOT be usable to view tokens, session secrets, JWT signing keys, or raw password hashes. Debug tool scope must be allowlisted.

## Performance Concerns

- Inserting a dual-identity audit row on every request inside an impersonation session doubles audit write volume on hot paths; use append-only partitioned tables keyed on `impersonation_session_id` to avoid index hot-spotting.
- MFA step-up must be verified server-side on every impersonation-initiation request. The verifier should short-circuit after the JWT audience check so the common rejected case (missing step-up claim) does not hit the database.
- Active impersonation session lookup must be O(1) (indexed on `real_user_id`) because it runs on every request that carries an impersonation context header.

## Architectural Implications for admin-expert reviews

When reviewing admin-api-service impersonation or debug-tools code, enforce:
1. `POST /impersonation/start` handler must call MFA step-up verification BEFORE creating the session row.
2. Business justification (support ticket ID or free-text reason) is a required, validated input — no empty strings, no default values.
3. The ImpersonationSession entity must persist: real_user_id, impersonated_user_id, impersonated_tenant_id, mfa_challenge_id, reason, ip_address, user_agent, initiated_at, expires_at, terminated_at, termination_reason. All non-nullable except termination fields.
4. Every downstream controller that honors an impersonation context must emit an audit event with BOTH identities. No single-identity audit rows are ever acceptable inside an active impersonation session.
5. Absolute session cap ≤ 1 hour. Inactivity cap ≤ 15 minutes. Both enforced server-side.
6. Refresh token flow must NOT silently renew impersonation; a new impersonation requires a new MFA step-up.
7. Read-only vs. write mode must be an explicit enum in the session, defaulted to read-only. Write mode flips require re-justification.
8. Debug tools endpoints (`debug-tools.controller.ts`) must be SUPER_ADMIN-only, rejecting even impersonated contexts (an admin impersonating a TENANT_ADMIN must NOT have access to debug tools).
9. Session termination endpoint must be reachable by every SUPER_ADMIN (not only the session owner) for incident response.
10. Active-sessions listing must be available to SUPER_ADMIN with filters by real_user, tenant, and time window.

## Domain Rule Additions for admin-expert

- MFA step-up MUST be verified at the impersonation-initiation endpoint; login-time MFA is insufficient because the admin session may be stale.
- Impersonation sessions MUST honor an absolute TTL ≤ 1h AND an inactivity TTL ≤ 15 min, both enforced server-side.
- Every audit row emitted during an active impersonation session MUST carry BOTH `real_user_id` and `impersonated_user_id`; single-identity audit rows during impersonation are CRITICAL findings.
- Business justification (support ticket ID or structured reason) MUST be a required, non-empty field at impersonation start.
- Impersonation sessions default to read-only mode; write mode requires an explicit toggle that itself is audited and alerted.
- Impersonation tokens MUST NOT be silently refreshable; every new window requires a new step-up.
- Debug-tools controllers MUST reject requests whose caller is currently impersonating any user.
- Any SUPER_ADMIN MUST be able to list and terminate active impersonation sessions from an admin dashboard for incident response.
- IP/device fingerprint change during an impersonation session SHOULD terminate the session and emit a security event.
- Impersonation events (start, terminate, write-mode toggle) MUST emit a NATS security event for downstream alerting pipelines.
