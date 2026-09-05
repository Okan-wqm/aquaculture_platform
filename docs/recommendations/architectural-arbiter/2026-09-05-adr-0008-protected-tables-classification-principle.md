# ADR-0008 — PROTECTED_TABLES Classification Principle and the Missing 018 Record

**Status:** accepted
**Date:** 2026-09-05
**Creates:** the `018-protected-tables-ssot` record cited by `libs/backend-common/src/constants/protected-tables.ts:64` (that file does not exist; `docs/adr/018-` is `018-edge-rbac-abac-model.md`)
**Supersedes:** admin-expert#SURF-003 (column-scoped trigger proposal — Overridden by ADR-0008)
**Resolves:** db-audit-platform-admin#DB-ADMIN-CRITICAL-001, #DB-ADMIN-CRITICAL-003, #DB-ADMIN-HIGH-011; database-reviewer#DB-REVIEW-001; audit-trail-completeness-auditor#TRAIL-013, #TRAIL-018, #TRAIL-032
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#DATA-CRITICAL-012

## Context

`admin.impersonation_sessions`, a mutable lifecycle row with no `legalHold` column, is listed in `PROTECTED_TABLES` (`protected-tables.ts:130`) and therefore carries the canonical WORM trigger; six code paths UPDATE it and fail. `admin.activity_logs` and `admin.tenant_activities`, the real ledgers, are absent from the list, carry no trigger, and `activity_logs` is hard-DELETE-able by a cron (`audit-trail.service.ts:856-866`). admin-expert proposed a column-scoped trigger (identity columns immutable, DELETE refused) to keep the sessions row protected while mutable.

The canonical contract has one shape: `libs/backend-common/src/database/audit-immutability.sql.ts:87-128` — UPDATE refused unconditionally, DELETE refused when `legalHold`, requiring `id` and `legalHold`. In-repo precedent for the split already exists: `1800600000000-TenantCleanupLedger.ts` keeps `cleanup_runs` mutable and unprotected while `cleanup_run_events` / `cleanup_run_evidence` carry the WORM trigger.

## Decision

We define membership in `PROTECTED_TABLES` by two conditions that must both hold: (1) the table is write-once at row granularity — no application code path issues UPDATE against an existing row; (2) it physically carries `id` and `legalHold boolean NOT NULL DEFAULT false`, so `auditImmutabilityStatements()` applies verbatim.

We reject column-scoped triggers. A mutable aggregate that needs immutable evidence is split: the lifecycle row stays unprotected; every state transition writes an append-only child event row that is protected.

Applied: `admin.impersonation_sessions` is removed as part of its deletion (ADR-0007). `admin.activity_logs` and `admin.tenant_activities` are added, gaining `legalHold` and the two canonical triggers; `tenant_activities.performedBy` goes NOT NULL blue-green (nullable → backfill `'system:legacy'` → SET NOT NULL). `admin.audit_logs` gains the 10 missing mandatory columns so one shape governs both audit ledgers. The docblock at `protected-tables.ts:64` is repointed at this ADR.

Gate: `tests/invariants/audit-immutability-triggers.spec.ts` iterates `PROTECTED_TABLES` instead of a hardcoded `audit_logs` regex and asserts, per entry, a `legalHold` column in the creating migration, both canonical triggers, and no repository `.save(` / `.update(` call in the fleet targeting that entity.

## Consequences

- The CODEOWNERS rule on `protected-tables.ts` requires arbiter approval to remove an entry; this ADR is that approval, granted only because the row is physically deleted.
- `activity_logs` disposal by the runtime retention CRUD becomes physically impossible before ADR-0012 removes that engine; the migrations must be ordered so the 03:00 cron does not start raising. The losing side: admin-expert's narrower fix is overridden because its scope would drift silently with every added column.
- Every future ledger pays the split-aggregate cost up front instead of a partial trigger later.
