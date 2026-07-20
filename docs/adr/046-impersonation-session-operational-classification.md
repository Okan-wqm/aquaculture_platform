# ADR-046: Impersonation Session Table — Operational Classification & Access-Plane Binding

## Status

**Accepted (Part A) / Proposed (Part B).**

- **Part A — operational reclassification of `admin.impersonation_sessions`** is
  implemented (ADMIN-CRITICAL-013 / APA-288): migration
  `1801600000000-DropImpersonationSessionsWriteGuard` + the append-only SSoT
  split in `libs/backend-common/src/constants/protected-tables.ts` + the
  `impersonation-sessions-operational` invariant.
- **Part B — binding the impersonation credential into the gateway act-as
  path** (ADMIN-CRITICAL-014 / APA-289) is a **tracked, not-yet-implemented**
  cross-service security change. This ADR records the decision, the
  architecture-of-record, and the trust-boundary review gate that must precede
  it. Owner: admin-panel remediation lane. Deadline: Phase 3 (control-plane) of
  `docs/plans/2026-07-20-admin-panel-remediation/`.

## Context

The SUPER_ADMIN impersonation feature has **two independent mechanisms** that
were never joined (RC-11 split-brain):

- **(A) admin-api `impersonation_sessions`** — a rich break-glass record:
  hashed/IP-bound/time-boxed token, per-session permissions, reason, ticket
  reference, duration, action log, and an `admin.audit_logs` trail on every
  transition. Built self-contained.
- **(B) gateway `effective-tenant` act-as** — `apps/gateway-api/src/middleware/
  effective-tenant.middleware.ts`: a SUPER_ADMIN sends `x-act-as-tenant`; the
  gateway validates (UUID + tenant-ACTIVE + MFA step-up) and signs
  `effectiveTenantId` into the HMAC user-assertion every subgraph trusts. This
  is the **only** channel that actually grants cross-tenant data access.

Two defects fell out of the split-brain:

### APA-288 (CRITICAL) — the operational table was frozen as append-only

The day-one Baseline classified `admin.impersonation_sessions` as an append-only
audit ledger and installed `trg_impersonation_sessions_prevent_update`
(BEFORE UPDATE OR DELETE, unconditional RAISE). But the table is the operational
**session state machine**: `ImpersonationService` issues an UPDATE on every
lifecycle transition (`endImpersonation`, `terminateSession`, `extendSession`,
`expireSession` incl. the EVERY_MINUTE cron, `logAction`, `logResourceAccess`).
Every one hit RAISE → 500: a session could be started but never ended,
terminated, extended, or expired; the expiry cron threw every minute; and after
`maxConcurrentSessions` (default 3) starts an admin was permanently locked out.
The kill-switch for a live SUPER_ADMIN credential was dead.

The category error was **triple-hardcoded**: `PROTECTED_TABLES` conflated two
contracts (protected-from-DROP vs append-only rows), and two generator scripts
(`scripts/migration/baseline-generator.ts`,
`scripts/migration/apply-audit-immutability.mjs`) carried their own copies of
the append-only list including `impersonation_sessions` — so dropping the
trigger alone would be reinstated at the next baseline regeneration.

### APA-289 (CRITICAL) — the impersonation credential grants nothing

`startImpersonation` mints a raw token, but **nothing in the request path
consumes it** — the only reader is admin-api's own
`GET /impersonation/sessions/validate`. The FE discards the token and opens the
tenant portal with a session id nobody consumes. Meanwhile mechanism (B) grants
cross-tenant scope with **no impersonation-session requirement at all**. Net: the
governance plane (grants, hashing, IP binding, time-box, action log) is
decorative, and real cross-tenant access leaves no `impersonation_sessions`
record — defeating the SOC 2 access-reconstruction purpose behind that table.

## Decision

### Part A — `impersonation_sessions` is OPERATIONAL, not append-only

Separate the two conflated contracts at the SSoT and reclassify the table:

1. `libs/backend-common/src/constants/protected-tables.ts` gains two explicit
   subsets of `PROTECTED_TABLES`:
   - `APPEND_ONLY_TABLES` — the true WORM ledgers that carry a
     `trg_<table>_prevent_update` trigger. `impersonation_sessions` is **not**
     one of them.
   - `LIFECYCLE_GUARDED_TABLES` — operational, destructive-DDL-protected tables.
     `admin.impersonation_sessions` is the canonical member. It **stays** in
     `PROTECTED_TABLES` (no `DROP TABLE` without a compliance waiver).
2. `baseline-generator.ts` and `apply-audit-immutability.mjs` derive their
   append-only set from `APPEND_ONLY_TABLES` (via `appendOnlyTableBaseNames()`)
   instead of hand-copied arrays — killing the triple-hardcode.
3. Migration `1801600000000-DropImpersonationSessionsWriteGuard` **drops** the
   `prevent_update` trigger + function (unblocking the lifecycle) and installs a
   narrow **BEFORE DELETE-only** guard so rows can transition (UPDATE) but can
   never be hard-deleted — the retention posture the table needs as a security
   record. The migration refuses `down()` (forward-only corrective).
4. The append-only guarantee for impersonation is **unchanged**: every
   transition already writes an immutable `admin.audit_logs` row (a true
   append-only ledger keeping its own trigger).
5. `tests/invariants/impersonation-sessions-operational.spec.ts` pins the
   classification, the net-absent `prevent_update` trigger, and the two scripts'
   lockstep with the SSoT.

**Tracked hardening (future, within Part A's spirit):** a DB **state-machine**
guard that additionally freezes identity columns and rejects illegal status
transitions while still allowing legal lifecycle UPDATEs (tier-1
make-impossible). It is deferred because verifying a conditional PL/pgSQL state
machine requires a **real-Postgres integration test**, and the repo's
integration lane (`e2e-tests.yml`) runs **post-deploy on `main`**, not on the
PR — shipping un-PR-gated DB state-machine logic would risk re-breaking the very
lifecycle this ADR restores. It lands when a PR-gated integration test for it
exists (add the spec to `db-migration-check.yml`'s bootstrap lane).

### Part B — bind the credential into the gateway act-as path (TRACKED)

Make ungoverned cross-tenant access structurally impossible (tier-1) and
governed access automatic (tier-2). The gateway becomes the **single consumer**
of the impersonation credential; the raw token never travels past it.

**Architecture-of-record (recommended topology — Redis read model, not
per-request HTTP):**

1. admin-api remains the sole writer of `impersonation_sessions`. On
   `startImpersonation` it write-throughs a record into a **shared Redis-backed
   impersonation store** keyed by `SHA-256(rawToken)`, value =
   `{sessionId, superAdminId, targetTenantId, permissions[], status, expiresAt}`,
   TTL = session duration. Every lifecycle transition (end/terminate/expire,
   incl. the cron and lazy expiry) invalidates the Redis entry in the same
   operation that writes the `admin.audit_logs` row.
2. The gateway `effective-tenant.middleware.ts` SUPER_ADMIN branch is changed so
   cross-tenant scope is granted **only** from a live impersonation session: it
   requires an `x-impersonation-token`, hashes it, reads the Redis store (no
   synchronous gateway→admin-api HTTP on the hot path), and proceeds only if the
   entry is present, ACTIVE, unexpired, `targetTenantId` === the requested
   tenant, and the permissions cover the operation. Only then does it sign
   `effectiveTenantId` (and the `sessionId`) into the HMAC user-assertion. Bare
   `x-act-as-tenant` without a matching session → 403 (closes the ambient-
   impersonation channel). Existing UUID + tenant-ACTIVE + MFA checks remain.
3. Contract: add `impersonationSessionId` to the gateway verified-user
   assertion builder + parser so subgraph audit rows carry the correlation key.

Chosen topology (Redis read model) over synchronous per-request HTTP because the
latter adds latency, couples the gateway hot path to admin-api availability, and
widens the cascade-failure surface. The ADR records both options; Redis read
model is the decision.

### Trust-boundary review gate (precondition for Part B merge)

Because Part B mutates the tenant-isolation boundary — the single most dangerous
operation in a multi-tenant SaaS — it MUST NOT land as a source-only change. It
requires, together in one reviewed PR:

- product/security sign-off on the fail-closed semantics;
- a **real-Postgres + Redis integration test** proving mint → present → validate
  → scoped-read → audit-correlation, and that bare act-as without a session →
  403, expired/terminated token → 403, IP-mismatch → 403;
- no regression to the gateway's existing UUID/ACTIVE/MFA gates.

Until Part B lands, `tests/invariants/impersonation-token-consumer.spec.ts`
pins the current reality — the `x-impersonation-token` header is referenced only
inside admin-api. The moment any other service/lib/web module references it, the
gate turns RED, forcing the change through this review rather than a silent
half-binding.

## Consequences

- **Positive:** the impersonation session lifecycle works end-to-end at the DB
  (Part A). The append-only vs operational contracts are separated at one SSoT;
  the trigger tooling can no longer freeze an operational table (detectable gate).
  Hard-delete stays refused (retention). The APA-289 remediation has a recorded
  architecture and a drift gate that prevents an unsafe partial binding.
- **Negative / residual risk:** until Part B lands, cross-tenant SUPER_ADMIN
  access via the gateway act-as path is auditable (via `admin.audit_logs`) but is
  **not** constrained to an approved impersonation session. This residual is the
  tracked finding ADMIN-CRITICAL-014.
- **Deferred:** the tier-1 DB state-machine guard for identity-column/transition
  immutability (Part A hardening) awaits a PR-gated integration test.

## References

- Findings: `docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/impersonation-debug.md#APA-288`, `#APA-289`
- Migration: `apps/admin-api-service/src/migrations/1801600000000-DropImpersonationSessionsWriteGuard.ts`
- SSoT: `libs/backend-common/src/constants/protected-tables.ts` (`APPEND_ONLY_TABLES`, `LIFECYCLE_GUARDED_TABLES`)
- Invariants: `tests/invariants/impersonation-sessions-operational.spec.ts`, `tests/invariants/impersonation-token-consumer.spec.ts`
- Gateway act-as: `apps/gateway-api/src/middleware/effective-tenant.middleware.ts`
