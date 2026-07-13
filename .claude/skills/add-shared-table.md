---
name: add-shared-table
description: Add a 5th table to the `shared` schema — gated by ADR + architectural-arbiter approval. BLOCKER-15 class.
type: skill
version: 1
status: reference-only
blocker: BLOCKER-15
owners: architectural-arbiter, data-expert, database-reviewer
handoff:
  on_complete_invoke: [architectural-arbiter, data-expert, database-reviewer]
  on_security_touch: security-reviewer
  on_event_impact: null
  on_multi_tenant_touch: multi-tenant-saas-expert
---

# Skill — Add Shared Table (BLOCKER-15)

## ADR Gate

Adding a NEW cross-tenant table to the `shared` schema is **architecturally gated**. The canonical shared-schema tables are exactly four per ADR-011 (as amended by ADR-042, which retired `user_permissions`):

1. `audit_logs`
2. `gdpr_data_requests`
3. `user_consents`
4. `access_logs`

A 5th table REQUIRES:

- A new ADR under `docs/adr/NNN-shared-table-<slug>.md` justifying why the table is cross-tenant by construction (not "it's easier this way" — the test is whether a per-tenant version would be semantically wrong).
- `architectural-arbiter` approval recorded in `docs/reviews/architectural-arbiter/{date}-shared-table-{slug}.md`.
- Update of `SHARED_SCHEMA_TABLES` constant in `tests/invariants/_constants.ts` (schema-invariants test allowlist).
- Update of `CLAUDE.md` D14 section listing the 5th table.

Without all four, CI invariant `tests/invariants/schema-invariants.spec.ts` rejects the migration as a CRITICAL violation.

## When to invoke

A review or feature proposal argues for adding a new cross-tenant table. Before ANY implementation work, walk through the ADR gate.

## Prerequisites

- Clear argument for WHY the table cannot be per-tenant. Test: imagine the table split per-tenant-schema; what invariant would break? If no invariant breaks, the table belongs in a per-tenant schema, not `shared`.
- Table's access pattern is read-heavy + append-light OR append-only-audit. Read-heavy per-tenant data belongs in per-tenant schemas.

## Cascade

### Step 1 — Draft the ADR

**Affected files:** `docs/adr/NNN-shared-table-<slug>.md` (where NNN is the next canonical ADR number).

**Mechanism:** ADR follows the existing ADR structure (context / decision / consequences / status). The Decision section MUST explicitly answer:

- Why cross-tenant by construction (not convenience)?
- What SELECT/INSERT/UPDATE/DELETE grants does the application role receive, and what's the separation-of-duties model?
- What RLS policy (if any) — `shared` tables CAN still carry RLS for multi-level access control (e.g. audit reader role vs audit writer role).
- What retention policy, backup, purge path?
- How does this interact with GDPR Art 17 erasure cascade? Shared tables that carry tenant-identifying rows MUST have an erasure-cascade handler.
- What is the PII classification of every column?

**Why:** per ADR-011, shared-schema is the exception, not the norm. The explicit justification prevents "just in case" shared-table proliferation that breaks tenant isolation over time.

**Verification:** ADR landed in `docs/adr/` with `status: proposed`.

**Cross-domain notifications:** `architectural-arbiter` to review; `compliance-expert` for GDPR/SOC 2 implications; `auth-security-expert` for grant structure.

### Step 2 — Arbitration review + approval

**Affected files:** `docs/reviews/architectural-arbiter/{date}-shared-table-{slug}.md`.

**Mechanism:** `architectural-arbiter` produces a decision report citing the ADR. Decision is `APPROVED` / `REJECTED` / `APPROVED_WITH_CONDITIONS`. Any condition (e.g. "mandatory RLS even though shared") becomes a hard requirement for Step 3.

**Why:** `architectural-arbiter` is the cross-agent conflict resolver per orchestrator Phase 3.5 + 4. Shared-table additions cross multiple agents' concerns (data-expert, database-reviewer, security-reviewer, compliance-expert, multi-tenant-saas-expert) — a single agent cannot unilaterally approve.

**Verification:** decision report exists; `status: approved` applied to the ADR.

**Cross-domain notifications:** `context-manager` to transition the finding (if any) to IN-PROGRESS.

### Step 3 — Update `SHARED_SCHEMA_TABLES` + CLAUDE.md

**Affected files:** `tests/invariants/_constants.ts`, `CLAUDE.md` (D14 "Tenant row placement" section).

**Mechanism:** append the new table name to `SHARED_SCHEMA_TABLES`. Update CLAUDE.md's D14 list to mention the 5th table + its purpose in one line. Both edits land in the SAME commit as the migration (Step 4) — CI invariant enforces pair-change.

**Why:** the invariant constants file is the allowlist `schema-invariants.spec.ts` checks against. CLAUDE.md D14 is the authoritative reference for reviewers; drift = undocumented architecture.

**Verification:** `npx jest tests/invariants/schema-invariants.spec.ts` (pre-existing) pass after the migration lands.

**Cross-domain notifications:** `prompt-writer` (CLAUDE.md is a prompt-writer-owned file); `architectural-arbiter` (review the CLAUDE.md diff).

### Step 4 — Migration authoring

**Affected files:** `database/migrations/core/<timestamp>-CreateShared<Table>.ts` OR the equivalent path in the service that owns the shared table's application role.

**Mechanism:** migration creates the table explicitly in the `shared` schema (`CREATE TABLE shared.<name> (...)`), applies GRANTs per ADR Decision section, optionally enables RLS + `FORCE ROW LEVEL SECURITY`, creates audit triggers if append-only. Lock-timeout envelope (`SET LOCAL lock_timeout = '2s'; SET LOCAL statement_timeout = '30s'; SET LOCAL search_path = 'shared', public`) wraps the DDL.

**Why:** data-expert migration-delta safety invariants; `migration-sql-lint.ts` R4 enforces `SET LOCAL search_path` (not session-scoped).

**Verification:** `tools/gates/migration-sql-lint.ts --mode=staged` clean; integration test inserts + selects + verifies RLS denies unauthorised access.

**Cross-domain notifications:** `data-expert` (migration-delta primary); `database-reviewer` (state-health); `security-reviewer` (RLS + grants audit).

### Step 5 — Erasure-cascade handler (if tenant-identifying rows present)

**Affected files:** `apps/<svc>/src/gdpr/handlers/erase-<shared-table>.handler.ts` + test.

**Mechanism:** handler receives a `TenantErased` event and deletes rows matching the tenant ID from the shared table. Registered via `gdpr-erasure-executor` sibling protocol (Phase 9.2 landing).

**Why:** GDPR Art 17 cascade is COMPLIANCE-CRITICAL-001 — shared tables are NOT exempt just because they're shared. If the shared table carries a tenant-identifying column, it's in scope for erasure.

**Verification:** `gdpr-erasure-executor` integration test asserts the handler runs + the row is deleted; `audit_logs` retains the tombstone per retention policy.

**Cross-domain notifications:** `compliance-expert` review; `legal-hold-auditor` precedence check.

## Validation checklist

- [ ] ADR `status: approved`.
- [ ] Architectural-arbiter decision report exists.
- [ ] `SHARED_SCHEMA_TABLES` constant + CLAUDE.md D14 updated in the same commit as the migration.
- [ ] Migration passes `migration-sql-lint --mode=staged` + `schema-invariants.spec.ts`.
- [ ] Erasure-cascade handler exists (or ADR explicitly documents exemption).
- [ ] `security-reviewer` has reviewed grants + RLS.
- [ ] `Closes:` footer references the ADR + any triggering finding-ID.

## Examples

- Current canonical 4 tables (reference, not to copy):
  - `shared.audit_logs` — append-only cross-tenant audit.
  - `shared.gdpr_data_requests` — Art 15/17/20 request tracking.
  - `shared.user_consents` — consent capture + withdrawal history.
  - `shared.access_logs` — low-level HTTP access stream (90-day horizon).
- Retired: `shared.user_permissions` (ADR-042, 2026-07-12) — dead parallel
  permission catalog; the RBAC SSoT is `auth.tenant_role_permissions`.
  Retirement is the reverse ceremony: ADR + archive-before-drop migration +
  SSoT list shrink in the same PR.

No 5th table exists in the repo yet — this skill is the gate.

## Cross-references

- ADR-011 — schema ownership model (the 4-table canonical list).
- `.claude/agents/data-expert.md` — shared-table gate invariant.
- `.claude/agents/multi-tenant-saas-expert.md` — tenant-isolation defense-in-depth.
- `.claude/agents/compliance-expert.md` — GDPR Art 17 cascade.
- `tests/invariants/_constants.ts` — `SHARED_SCHEMA_TABLES` allowlist.
- `tests/invariants/schema-invariants.spec.ts` — invariant enforcement.
- CLAUDE.md D14 — Tenant row placement authoritative reference.

## Changelog

- v1 (2026-04-17) — initial landing, Phase 3 deliverable, BLOCKER-15 class.
- v2 (2026-07-12) — canonical list corrected to the live 4 (access_logs in,
  user_permissions retired per ADR-042 / ORPHAN-HIGH-378).
