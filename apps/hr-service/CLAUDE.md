# hr-service — CLAUDE.md (domain context)

> Root rules in `/CLAUDE.md` already apply (always loaded). This file adds ONLY the hr-domain facts that CONTRADICT a correct reading of those rules.

Personnel, leave, payroll, shifts, scheduling, HR finance. Schema: `hr` (tenant-scoped).

## `payroll_audit` is CROSS-tenant — the inverse of messaging

`apps/hr-service/src/hr/entities/payroll-audit.entity.ts` → `@Entity('payroll_audit', { schema: 'hr' })`.

One service away, `messaging`'s `compliance_audit_log` is PER-tenant and omits `schema:`. Same word in the table name, opposite answer. Neither is a mistake — read the registry, never the noun.

<!-- infra-tables:hr -->`migrations`, `hr_outbox`, `payroll_audit`, `tenant_erasure_target_proofs`<!-- /infra-tables -->

Proven against `MODULE_SCHEMAS` by `tests/invariants/nested-steering-parity.spec.ts` — edit the registry, never this copy.

## The `hr_` table-name prefix is MANDATORY

farm and hr tables are cloned into the SAME `tenant_<uuid>` namespace, so any hr table whose bare name farm also owns MUST be prefixed. Live collisions already avoided this way: `departments_hr` (vs farm `departments`), `hr_finance_categories` / `hr_finance_entries` (vs farm `finance_categories` / `finance_expense_entries`).

Adding `hr.finance_categories` unprefixed would not fail a review — it would silently collide at fan-out time.

## hr is NOT the currency SSoT

`hr_payroll_cost_settings.defaultCurrency` is a PROJECTION of farm's `finance_settings.defaultCurrency`, delivered by the `FinanceSettingsUpdated` event. It is intentionally not writable from the hr side (`apps/hr-service/src/finance/handlers/update-payroll-cost-settings.handler.ts`). Frozen by `tests/invariants/finance-currency-ssot.spec.ts` after three hardcoded ISO literals had drifted apart.

## Rules that look like bugs and are not

- Overtime thresholds are jurisdiction-configurable with a Turkish 45h fallback (`apps/hr-service/src/scheduling/services/jurisdiction-policy.ts`) — not a hardcoded constant to replace.
- `code` is deliberately immutable on leave types, certification types and shifts; the update inputs omit it on purpose.

## Enforcement

Boot: `SchemaDriftValidator`. CI: `tests/invariants/finance-currency-ssot.spec.ts`, `hr-graphql-fe-be-parity.spec.ts`, `tenant-fanout-entity-parity.spec.ts`, `tenant-execution-context-registered.spec.ts`, `no-direct-getrepository-call.spec.ts`; `e2e/tests/integration/schema-invariants.spec.ts`.
