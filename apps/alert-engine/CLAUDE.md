# alert-engine — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the alert-domain facts that CONTRADICT a correct reading of those rules.

Alert rules, risk scoring, escalation, incident lifecycle. Schema: `alert` (tenant-scoped).

## Two "audit" tables, opposite classifications

- `apps/alert-engine/src/audit/entities/audit-entry.entity.ts` → `@Entity('alert_audit_log', { schema: 'alert' })` — **cross-tenant**, and its `tenant_id` column is **nullable**. That nullability is the reason it cannot be per-tenant: platform-level alert events have no tenant to route by.
- `apps/alert-engine/src/alert/entities/alert-history.entity.ts` → `@Entity('alert_history')` — **per-tenant**, even though its own docblock describes it as recording triggered alerts "for audit and tracking".

Do not reclassify either by reading the word "audit".

<!-- infra-tables:alert -->`migrations`, `alert_audit_log`, `alert_outbox`, `tenant_erasure_target_proofs`<!-- /infra-tables -->

Proven against `MODULE_SCHEMAS` by `tests/invariants/nested-steering-parity.spec.ts` — edit the registry, never this copy.

## Cooldown lives in Redis, not the database

Duplicate-alert suppression is a Redis `SET NX EX` claim in `apps/alert-engine/src/alert/services/alert-evaluation.service.ts`. There is no cooldown column and no DB-side check to "restore" — a missing one is not the bug it looks like. Adding a database cooldown would create a second, racing source of truth.

## Enforcement

Boot: `SchemaDriftValidator`. CI: `tests/invariants/tenant-fanout-entity-parity.spec.ts`, `entity-schema-declaration.spec.ts`, `metrics-endpoint-adoption.spec.ts`, `critical-infra-ssot.spec.ts`; `e2e/tests/integration/schema-invariants.spec.ts`, `e2e/tests/mobile/alerts-ack.spec.ts`.
