# ADR-0012 — Single Retention Authority with Entity-Typed Policies

**Status:** accepted
**Date:** 2026-09-05
**Promotes:** `docs/adr/024-compliance-retention-matrix.md` from `Proposed` to `Accepted` (superseded where its matrix contradicts the registry)
**Resolves:** data-expert#DATA-002; db-audit-platform-admin#DB-ADMIN-CRITICAL-003, #DB-ADMIN-MEDIUM-008, #DB-ADMIN-MEDIUM-018; admin-expert#SURF-001; audit-trail-completeness-auditor#TRAIL-007, #TRAIL-010; test-runner#TEST-012; database-reviewer#DB-REVIEW-033 (with conflict correction C1)
**Finding reference:** docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#DATA-CRITICAL-013

## Context

Three retention engines coexist because ADR-024 was never accepted and no owner existed. (1) Canonical: `libs/backend-common/src/database/retention/retention-enforcement.service.ts`, registry-driven, legal-hold aware, 03:00. (2) Runtime CRUD: `apps/admin-api-service/src/security/services/audit-trail.service.ts:807-866`, same hour, no legal-hold predicate, DTO without `@Min`, only ever touches `ActivityLog`. (3) Eight ad-hoc hardcoded crons in error-tracking, database-monitoring, performance-monitoring, job-queue, query-inspector, cache-inspector, api-call-inspector and debug-session services.

The canonical registry names `timestampColumn: 'created_at'` (`apps/admin-api-service/src/retention/retention-bootstrap.module.ts:58,97`) while the physical column is `"createdAt"`; the enforcer quotes the identifier, both statements raise `column does not exist`, and the per-policy catch swallows the error. The SOC 2 7-year and 90-day windows have never executed.

## Context on the runtime-editable option

`admin.retention_policies` lets an operator type any number into a field that deletes the security ledger; `retentionDays` is write-only decoration the engine never reads. Adding `@Min(1)` would leave a screen that lets an operator type `1`.

## Decision

We make `RetentionEnforcementService` the single retention owner and delete the other two engines. `applyRetentionPolicies` / `applyRetentionPolicy` are removed; the eight ad-hoc crons are removed and re-expressed as registry entries. Runtime-editable retention does not exist: `admin.retention_policies`, its controller CRUD, DTOs and `RetentionPoliciesPage` are deleted; retention windows are compliance commitments under code review.

`registerRetentionPolicy` stops accepting `{schema, tableName, timestampColumn}` strings and becomes entity-typed: `registerRetentionPolicy<T>({ entity: EntityTarget<T>, timestampProperty: keyof T & string, … })`, deriving schema, table and physical column from TypeORM `EntityMetadata` at registration. `'created_at'` then fails to compile. `legalHoldClause` is required for any entity that carries a `legalHold` column, enforced by the same type derivation.

Gate: `tests/invariants/retention-authority-ssot.spec.ts` — (i) exactly one cron in the fleet performs retention-basis bulk DELETE / archive; (ii) every registered policy on a `PROTECTED_TABLES` entity carries a legal-hold clause; (iii) every table in `MODULE_SCHEMAS[].tables` with a timestamp column has a registered policy or an entry in `.claude/allowlists/unbounded-tables.yaml` with `{owner, expiry, reason}`.

## Consequences

- Every registrant in the fleet (admin-api and observability-service bootstrap modules) changes signature in the same PR; `data-expert` becomes primary owner of the retention library (prompt-writer to update).
- Operators lose a retention-policy screen that displayed commitments the engine did not implement.
- This decision is a prerequisite for ADR-0006 (admin access logs need a working 90-day policy) and unblocks OBS-001 / PERF-014 (nine unheartbeated crons collapse to one).
