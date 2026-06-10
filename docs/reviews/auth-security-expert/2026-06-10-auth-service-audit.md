# auth-service Full-Depth Audit — 2026-06-10

**Program:** Risk-ranked service-by-service enterprise audit (service #1 of 17).
**Method:** 5 parallel specialist reviews (auth-security-expert, multi-tenant-saas-expert, performance-expert, data-expert, test-runner) + independent primary-source verification of every CRITICAL/HIGH claim by the session lead (all marked ✅ VERIFIED were re-read directly from source).
**Verdict:** **BLOCK** — 4 CRITICAL, 14 HIGH. The cryptographic core (RS256 gating, peppered bcrypt, refresh rotation, MFA crypto, JWT-first tenant trust anchor) is strong; the blockers are authorization-boundary gaps, defense-in-depth absence, durability debt, and a dark test gate.

---

## Finding Registry (state machine: OPEN unless noted)

| ID | Sev | Title | Verified | Source |
|---|---|---|---|---|
| SEC-CRITICAL-001 | CRITICAL | Public `register` accepts unvalidated client-supplied `tenantId` — anonymous cross-tenant account injection | ✅ | SEC+MT |
| SEC-CRITICAL-002 | CRITICAL | `rate-limit/` module is empty 0-byte stubs — no local brute-force/velocity defense on login, MFA-verify, reset, register; no per-tenant limits | ✅ | SEC+MT |
| AUDIT-CRITICAL-004 | CRITICAL | Unit-test gate is RED on `main`: 11/16 suites fail (99/244 tests) from DI drift — zero regression protection on the trust anchor | run output | TEST |
| AUDIT-CRITICAL-005 | CRITICAL | Refresh-token reuse detection (production `HASH_REFRESH_TOKENS=true` path) has ZERO test coverage in any layer | ✅ (grep) | TEST |
| SEC-HIGH-001 | HIGH | TOTP codes are not one-time-use — no `lastUsedTimeStep` tracking, intra-window replay across login/step-up | ✅ | SEC |
| SEC-HIGH-002 | HIGH | Login not-found branch compares against a malformed bcrypt dummy hash and skips peppering — asymmetric timing path | ✅ | SEC |
| SEC-HIGH-003 | HIGH | Issued JWTs carry no `kid` header while JWKS advertises `kid` — key rotation not deterministically consumable | ✅ | SEC |
| SEC-HIGH-004 | HIGH | JWKS response cached permanently (no TTL/invalidation) — stale key set served for process lifetime after rotation | ✅ | SEC |
| MT-HIGH-001 | HIGH | `updateTenant` does `Object.assign(tenant, input)` over full input incl. `plan`/`status`/`maxUsers`; resolver comment claims field filtering that does not exist; plan change bypasses billing saga | ✅ | MT |
| MT-HIGH-002 | HIGH | Synchronous tenant provisioning with silent partial-failure exits; `TenantCreated` published regardless of provisioning outcome → orphaned PENDING tenants + downstream artifacts | | MT |
| MT-HIGH-003 | HIGH | Tenant lifecycle has no ARCHIVED/PURGED terminals and no transition-legality check — GDPR Art-17 purge precondition unrepresentable | | MT |
| DATA-HIGH-001 | HIGH | No transactional outbox — every event publish is a dual-write; `TenantCreated`/`UserInvited` loss on crash between commit and publish | ✅ (grep) | DATA |
| DATA-HIGH-002 | HIGH | `@CreateDateColumn`/`@UpdateDateColumn` emit `timestamp` (no tz) on 8 entities incl. 7-year-retention `auth.audit_logs` | | DATA |
| DATA-HIGH-003 | HIGH | `AuthSchemaBootstrapService` runs ALTER/UPDATE/CREATE DDL at every cold start on the request pool, errors swallowed — second un-versioned schema writer violating single-writer deploy contract; its "webpack may strip migrations" premise is stale (backend builds use tsc) | ✅ | DATA |
| PERF-HIGH-001 | HIGH | Un-indexed cross-schema permission JOIN on every token mint (`getUserResourcePermissions`), failures silently return `[]` | | PERF |
| PERF-HIGH-002 | HIGH | Token validation does 2 serial Redis RTTs + per-request `JSON.parse` on the per-request platform-wide hot path | | PERF |
| PERF-HIGH-003 | HIGH | `generateTokens()` stacks 4–6 serial awaits (modules, permissions, bcrypt, save, session) that are partially parallelizable | | PERF |
| AUDIT-HIGH-009 | HIGH | Test coverage holes on security primitives: no `token.service.spec`, no `jwt-auth.guard` unit spec, no tenant-provisioning specs, no rate-limiter spec, no WebAuthn specs, no service-local ADR-011 entity-schema architecture spec, RBAC escalation e2e-only | | TEST |
| SEC-MEDIUM-001 | MEDIUM | Tenant-role assign/update lacks role-ceiling and self-target checks (tenant-scoped privilege manipulation) | | SEC |
| SEC-MEDIUM-002 | MEDIUM | Role-change/user-delete audit writes swallowed on failure (fail-open) vs MFA's fail-closed pattern | | SEC |
| SEC-MEDIUM-003 | MEDIUM | Refresh reuse revocation is per-user not per-family (no `familyId` column) — over-revokes, SecurityEvent lacks family-id | ✅ (grep) | SEC |
| SEC-MEDIUM-004 | MEDIUM | `validateToken` query omits `enforceAccessTokenType` — refresh/MFA tokens introspect as `valid:true` | | SEC |
| MT-MEDIUM-001 | MEDIUM | `PlanTier` non-ordinal string enum; no `planLevel` JWT claim; `TRIAL` vs `isTrialActive` dual representation | | MT |
| MT-MEDIUM-002 | MEDIUM | `farmCount`/`sensorCount` denormalized on `auth.tenants` with no maintainer/reconcile (only `userCount` has one) | | MT |
| DATA-MEDIUM-001 | MEDIUM | No JSON Schema validators for any of the 13 auth/tenant event types crossing the NATS trust boundary | | DATA |
| DATA-MEDIUM-002 | MEDIUM | `RefreshToken.tenantId`/`Invitation.tenantId` nullable on tenant-bound rows; mixed camelCase/snake_case naming in `auth` schema | | DATA |
| PERF-MEDIUM-001 | MEDIUM | `getJwtVerifyOptions()` rebuilds (and in PATH mode `readFileSync`s) the public key per request — fix lands in backend-common, benefits all consumer services | | PERF |
| PERF-MEDIUM-002 | MEDIUM | Session manager O(N) serial Redis round-trips on mint/revoke-all (no pipelining/MGET) | | PERF |
| PERF-MEDIUM-003 | MEDIUM | No tier-0 p99 SLO rule for token validation/login (must sit above the deliberate 200ms login floor) | | PERF |
| AUDIT-MEDIUM-015 | MEDIUM | Jest config: no `restoreMocks`/`clearMocks`; 60% global coverage floor below §4 minimum; no mutation testing; 29 bare `toHaveBeenCalled()` assertions | | TEST |
| MT-LOW-001 | LOW | `tenantBySlug` public query returns internal tenant `id` + `status` — UUID-harvest leg feeding SEC-CRITICAL-001 | | MT |
| DATA-LOW-001 | LOW | `auth.tenants` carries subscription-state columns (`plan`, `trialEndsAt`, `subscriptionEndsAt`, …) overlapping billing SSoT with no reconciliation path | | DATA |
| SEC-LOW-001 | LOW | MFA challenge token lacks `type` claim; recovery-code `timingSafeEqual` can throw on corrupted hash; `users` RLS exclusion lacks architecture-test backstop; `$3::timestamp` cast drops tz on `lockedUntil`; migration spec discovery/compile-exclude mismatch | | SEC+PERF+TEST |

---

## CRITICAL Details

### SEC-CRITICAL-001 — Cross-tenant account injection via public register
- `apps/auth-service/src/modules/authentication/dto/register.dto.ts:40-42` — `tenantId!: string` required, only `@IsUUID('4')`.
- `apps/auth-service/src/modules/authentication/services/authentication.service.ts:156-191` — `register()` persists `tenantId: input.tenantId` with **no tenant existence/ACTIVE/maxUsers check, no userCount increment**, then immediately issues a full token pair (line 190) despite `isEmailVerified: false`.
- `auth.resolver.ts` — mutation is `@Public()`, gated only by `REGISTRATION_ENABLED`.
- Amplifier: `tenantBySlug` (`tenant.resolver.ts:73-85`, MT-LOW-001) publicly maps slug → tenant UUID, removing the "guess a UUID" barrier.
- **Fix (Tier-1, make-impossible):** remove client `tenantId` from the public path entirely. Registration resolves tenant from a server-validated invitation token (flow already exists: `acceptInvitation`), or routes to a "new tenant + first admin" onboarding saga. If a gated variant survives, it must validate tenant ACTIVE + enforce `maxUsers` atomically in one transaction (same shape as `user-lifecycle.service.ts:631-639`).

### SEC-CRITICAL-002 — No local rate limiting (empty stubs)
- `apps/auth-service/src/rate-limit/rate-limiter.service.ts` and `throttle.decorator.ts` are **0 bytes** (verified `wc -c`). Comments at `auth.resolver.ts:91-95` / `authentication.service.ts:154` delegate everything to the gateway.
- ADR-008 defense-in-depth violated: a caller reaching the subgraph on the internal network faces no velocity control on `verifyMfaLogin` (6-digit space), `forgotPassword`, `resetPassword`, `register`. Per-tenant noisy-neighbor limits absent (absorbs MT-HIGH-004).
- **Fix (Tier-2):** Redis-backed atomic limiter (Lua INCR+PEXPIRE), fail-closed for auth endpoints, per-endpoint + per-tenant + per-IP buckets; per-username lockout extended to MFA-verify. Delete the empty stubs in the same commit — 0-byte files masquerading as a control is itself a defect.

### AUDIT-CRITICAL-004 — Test gate dark on main
- `nx test auth-service`: **11/16 suites fail, 99/244 tests fail.** Deterministic DI drift: specs don't provide `TokenService` (now injected at `authentication.service.ts:70`) or `MobileUserSettingsRepository`. Login/reset/lifecycle/resolver-guard assertions are all dark.
- Process question (route to infra-expert): how did this reach `main` past `nx affected -t test`? Likely a `libs/backend-common`→service affected-graph edge gap — **potentially systemic across all services**; verify on every subsequent service in this program.
- **Fix:** restore missing providers in the four broken test modules; fix `toHaveLength` fixture drift in announcement/messaging/support specs; then prove the affected-graph edge.

### AUDIT-CRITICAL-005 — Production refresh path untested
- Unit spec forces `HASH_REFRESH_TOKENS: false`; production default is `true` → `refreshTokenWithHash()` + `detectRefreshTokenReuse()` + `revokeAllUserTokensOnReuseDetection()` never execute under test. Zero references in unit/integration/e2e (verified grep).
- **Fix:** hashed-path unit block (rotation, replay→chain-revoke+blacklist+session-kill+SecurityEvent, unknown-token 401) + a testcontainers integration spec for the `FOR UPDATE` lock semantics.

---

## What is solid (do not churn)
- RS256 issuance gating (prod hard-fails without keypair; dev fallback double-gated) — `app.module.ts:174-218`.
- Verifier hardening: `algorithms:['RS256']` pinned, issuer/audience enforced, `enforceAccessTokenType`, jti required in prod.
- Password storage: HMAC-pepper + bcrypt(12, clamped 10–14), lazy migration, async hashing (no event-loop block).
- Refresh rotation core: pessimistic lock, userId-scoped bounded bcrypt scan (`take(10)`), reuse detection → revoke+blacklist+session kill.
- Tenant trust anchor: JWT `tenantId` sourced only from the persisted user row (`token.service.ts:187`); middleware prefers JWT, query-param fallback removed; `StripInternalHeadersMiddleware` ordered first.
- MFA crypto: AES-256-GCM, 160-bit secret, hashed single-use recovery codes, fail-closed audit + missing-key hard-fail.
- ADR-011 discipline: all 8 entities declare `schema: 'auth'`; UUID typing correct everywhere; migration runner + drift validator wired; Baseline migration idempotency clean.
- Event hygiene: `createBaseEvent()` everywhere, flat pattern (ADR-006), `UserInvited` carries opaque refs not PII, no floating promises.
- MFA test suite (`mfa.spec.ts`) is the quality template: real TOTP/HOTP, strong negative paths, payload assertions.

## Remediation sequencing (proposed wave)
1. **Wave 1 (merge-blocking):** SEC-CRITICAL-001 (+MT-LOW-001 id-leak), SEC-CRITICAL-002, AUDIT-CRITICAL-004.
2. **Wave 2 (security hardening):** AUDIT-CRITICAL-005, SEC-HIGH-001..004, SEC-MEDIUM-001..004.
3. **Wave 3 (tenancy/data durability):** MT-HIGH-001..010, MT-MEDIUM-001..008 — outbox adoption + lifecycle state machine + provisioning saga handoff to admin-api.
4. **Wave 4 (perf + test infra):** PERF-HIGH-001..014, PERF-MEDIUM-001..012.

## Cross-service follow-ups discovered here
- Affected-graph test-gate gap (AUDIT-CRITICAL-004) — check on every remaining service.
- `SourceSchemaBootstrapService` pattern (DATA-HIGH-003 comment says "same approach as other services") — runtime-DDL shims likely exist elsewhere; audit per service.
- `kid` adoption (SEC-HIGH-003) ripples to every token-consuming subgraph + `backend-common` verify path.
- PlanTier ordinal SSoT (MT-MEDIUM-001) belongs in `@platform/event-contracts`.

## Post-audit remediation findings (registry anchors)

Findings raised DURING the remediation waves (full narratives live in
[the resolutions log](./2026-06-10-auth-service-audit-resolutions.md);
the registry references this audit document as their review_file, so
the IDs are anchored here for three-store cross-referencing):

- CLAUDE-HIGH-013 — Baseline consolidation LOST UNIQUE(LOWER(email)) on auth.users; restored by the RestoreCaseInsensitiveEmailUniqueness migration (renumbered to 1800300000000 after the enterprise-train merge introduced a 1800100000000 sibling).
- CLAUDE-HIGH-014 — createTenantUser was a line-for-line duplicate of UserLifecycleService.createUser (SSoT violation).
- CLAUDE-HIGH-015 — TenantService.update had no role-based field filtering despite the resolver comment claiming it; superseded by the command-receipt convergence which rejects resolver-level tenant updates outright.
- CLAUDE-MEDIUM-012 — myModules and getMyMobileSettings role gates contradicted the documented minimum-role contract.
- AUDIT-CRITICAL-006 — gateway-api unit test gate RED on main (17 suites / 254 failures); see also the consolidation ledger's GATEWAY-TEST-CRASH-001 record of the rate-limit spec worker crash.
