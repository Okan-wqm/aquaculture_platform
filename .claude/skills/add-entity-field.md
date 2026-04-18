---
name: add-entity-field
description: Add a new @Column to an existing TypeORM entity with full cascade across DTO, migration, event-contract (additive), test fixture, and tenant-schema sync
type: skill
version: 1
owners: data-expert, respective-domain-expert, database-reviewer
handoff:
  on_complete_invoke: [data-expert, database-reviewer]
  on_security_touch: null
  on_event_impact: dynamic
  on_multi_tenant_touch: multi-tenant-saas-expert
---

# Skill — Add Entity Field

## When to invoke

A review finding or user request says "add field X of type T to entity Y" (e.g. "add `priority: 'high'|'normal'|'low'` to `farm.Batch`"). Invoke whenever the change touches (a) a TypeORM `@Entity()`, (b) one or more DTOs/resolvers/event contracts exposing the entity, and (c) a tenant-provisioned schema via `MODULE_SCHEMAS`.

Do NOT invoke for fields internal to a service that never cross a bounded context (those are inline edits; no cascade needed).

## Prerequisites

- The entity already exists — this skill does NOT create new entities. Creating a new entity is domain-specific work owned by the respective domain expert, not a catalogued skill.
- The field's type is concrete (enum, scalar, nullable-uuid-reference, JSONB with Zod/Check). Ambiguous "JSONB dumping ground" columns fail the data-expert invariant — clarify the shape before invoking.
- The owning service's schema is in `MODULE_SCHEMAS` at `libs/backend-common/src/database/constants.ts` (or equivalent SSoT).
- For PII fields, the `SENSITIVE_FIELDS` classification level (`PUBLIC | INTERNAL | PII | SENSITIVE_PII | SPECIAL_CATEGORY`) is known.

## Cascade

### Step 1 — Decide field shape + classification

**Affected files:** (analysis only; no edits yet)

**Mechanism:** determine nullability (can this field legitimately be absent?), default (db-layer default or app-layer?), monetary/time-zone sensitivity (NUMERIC(p,s) + TIMESTAMPTZ discipline), PII classification if applicable. Consult `database-reviewer` column-type-discipline section.

**Why:** per ADR-011 + database-reviewer invariants, every column choice has downstream schema, audit, and replication consequences. Skipping this step = MEDIUM schema debt even if subsequent steps land cleanly.

**Verification:** write a one-line design note in the implementation-planner package body citing the classification + nullability decision.

**Cross-domain notifications:** `database-reviewer` (schema-state health); `auth-security-expert` if PII.

### Step 2 — Add `@Column` to entity

**Affected files:** `apps/<svc>/src/<domain>/entities/<name>.entity.ts`

**Mechanism:** add `@Column({ type: '<pg-type>', nullable: <bool>, default: <?> }) <fieldName>: <TsType>;` with the discipline from Step 1. For monetary columns include the DecimalTransformer; for PII include the SENSITIVE_FIELDS entry.

**Why:** `@Entity('table', { schema: '<svc>' })` is enforced by ADR-011; the new column inherits the schema placement. `aquaculture/require-entity-schema` ESLint rule validates the `schema:` option is present on the entity.

**Verification:** `npx tsc --noEmit -p apps/<svc>/tsconfig.json` clean.

**Cross-domain notifications:** `database-reviewer` for column-type discipline; `respective-domain-expert` for domain-semantic correctness.

### Step 3 — Add field to DTOs + GraphQL types

**Affected files:** `apps/<svc>/src/<domain>/dto/<Create|Update|Return|List>.<name>.dto.ts`, `apps/<svc>/src/<domain>/<name>.resolver.ts` (or `.controller.ts` for REST services), `apps/<svc>/src/<domain>/types/<name>.type.ts` if separate GraphQL type.

**Mechanism:** `class-validator` decorators matching column constraints (`@IsUUID()`, `@IsEnum(...)`, `@Min()`, `@Max()`, `@IsOptional()` mirroring nullability). For GraphQL: `@Field()` with correct nullability + description.

**Why:** `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` is enabled globally — a missing DTO field silently drops the value. GraphQL field without the DTO counterpart creates over-fetch surface.

**Verification:** Jest integration test adding + reading the field round-trips correctly.

**Cross-domain notifications:** `frontend-expert` if GraphQL schema changes (consumer codegen update needed).

### Step 4 — Generate migration (blue-green 3-step if NOT NULL on populated table)

**Affected files:** `apps/<svc>/src/database/migrations/<timestamp>-Add<FieldName>To<Entity>.ts`

**Mechanism:** if the column is NOT NULL on a table with existing rows, the single migration MUST be split into THREE migrations per data-expert's invariant: (1) nullable ADD COLUMN, (2) backfill via `UPDATE … WHERE … IS NULL`, (3) `ALTER COLUMN … SET NOT NULL`. Each migration has its own timestamp + file. The `migration-sql-lint` gate R2 rejects single-step non-null add.

If the column is nullable OR the table is empty, one migration with `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` + `SET LOCAL lock_timeout = '2s'` + `SET LOCAL statement_timeout = '30s'` + `SET LOCAL search_path = '<schema>', public` envelope is sufficient.

**Why:** single-step NOT NULL takes `ACCESS EXCLUSIVE` on a populated table and fails if any row is NULL — blue-green avoids both. Lock-timeout envelope prevents pile-up during deploy.

**Verification:** `tools/gates/migration-sql-lint.ts` staged mode clean (`--mode=staged`). `apps/<svc>/src/database/data-source.ts` migration run test in CI.

**Cross-domain notifications:** `data-expert` (migration-delta primary); `database-reviewer` (schema-state secondary).

### Step 5 — Update `TenantSchemaSyncService` / source schema bootstrap

**Affected files:** `libs/backend-common/src/database/source-schema-bootstrap.service.ts` (if the service uses the bootstrap pattern), `libs/backend-common/src/database/constants.ts` (if `MODULE_SCHEMAS.<svc>.tables` enumerates fields).

**Mechanism:** new tenant schemas created AFTER this migration must include the new column. `SchemaManagerService.createTenantSchema` uses `CREATE TABLE ... LIKE <source>.<table> INCLUDING ALL` — as long as the source schema migration ran, new tenants inherit the column. Existing tenants get the column via the per-tenant migration runner loop.

**Why:** per data-expert's tenant-schema-provisioning invariant, a migration that mutates per-tenant tables but is NOT wired into the tenant runner = CRITICAL (silent drift source; existing tenants never receive it).

**Verification:** `tests/invariants/adoption-invariants.spec.ts` pass for the service (SchemaDriftModule adoption).

**Cross-domain notifications:** `multi-tenant-saas-expert` for tenant-lifecycle correctness.

### Step 6 — Emit event (optional, additive only)

**Affected files:** `libs/event-contracts/src/<svc>-events.ts`, `libs/event-contracts/src/schemas/<event>.schema.json`

**Mechanism:** if the new field belongs in an event payload (e.g. `BatchUpdated` now carries `priority`), add the field as OPTIONAL (`priority?: string`) to the event interface. Add the field to the JSON Schema validator with `"required": []` omitting the new field. Do NOT bump the event version — additive changes are non-breaking per ADR-006. If the field is REQUIRED in the event, invoke `change-event-contract` skill instead (breaking change).

**Why:** ADR-006 flat-pattern invariant + data-expert's additive-vs-breaking contract: breaking changes require dual-publish + upcaster + consumer migration (the `change-event-contract` cascade). Silent breaking = stream replay breaks = CRITICAL.

**Verification:** `npx jest tests/invariants/upcaster-chain.spec.ts` pass; `createBaseEvent<NewEvent>(...)` compiles clean with the new optional field.

**Cross-domain notifications:** ripple-tracer enumeration of consumers from `infrastructure/nats/services.yaml` — every subscriber whose filter matches the event subject is a potential dispatch target for consumer-side review (even though the change is additive and they should continue to work).

### Step 7 — Migration runner registration + verify on one tenant

**Affected files:** `apps/<svc>/src/database/data-source.ts` (entry in `migrations: [...classes]`), `apps/<svc>/src/app.module.ts` (migration-runner provider via `createMigrationRunnerService('<schema>')`).

**Mechanism:** import the new migration class + include in the `migrations: []` array. `TypeOrmModule` config already sets `migrationsRun: false` — the migration-runner service executes them in controlled order on service boot.

**Why:** per CLAUDE.md + ADR-011/012, each service owns its migrations; the runner owns execution; `DATABASE_MIGRATIONS_RUN=false` in prod is a hard invariant.

**Verification:** deploy to staging, verify `SchemaManagerService.validateModuleSchemas()` for the module returns green.

**Cross-domain notifications:** `infra-expert` for deployment sequencing (CI gate picks this up via the migration-check workflow).

## Validation checklist

- [ ] Step 1 design note exists in the implementation-planner package body.
- [ ] Step 2 entity column passes `aquaculture/require-entity-schema` + `tsc --noEmit`.
- [ ] Step 3 DTO + GraphQL field present; integration test round-trip PASS.
- [ ] Step 4 migration passes `migration-sql-lint --mode=staged`; blue-green 3-step enforced if NOT NULL + populated table.
- [ ] Step 5 source schema + MODULE_SCHEMAS.<svc>.tables updated; adoption invariant green.
- [ ] Step 6 (if event emission) event interface carries OPTIONAL field; upcaster-chain invariant green.
- [ ] Step 7 migration registered + staging `validateModuleSchemas()` PASS.
- [ ] Atomic commit plan carries `Closes:` footer referencing the review finding that triggered the cascade.

## Examples

- `71474fbf` (adjacent pattern) — INFRA-1 `backup-databases.sh` manifest-pin migration demonstrates the hash-chain + pair-change discipline equivalent to this skill's Step 7.
- hr-service migration `1786000400000-MoveEmployeesToHr.ts` demonstrates a SET SCHEMA move that preserves ALL column definitions including new ones — pattern reference for Step 4's lock-timeout envelope.

## Cross-references

- ADR-006 — event contract flat-pattern (Step 6).
- ADR-011 — schema ownership model (Steps 2, 5, 7).
- ADR-012 — schema drift prevention (Step 5).
- `.claude/agents/data-expert.md` — migration-delta safety invariants (Step 4).
- `.claude/agents/database-reviewer.md` — column type discipline (Step 1).
- `tools/gates/migration-sql-lint.ts` — R2 single-step NOT NULL rejection (Step 4).

## Changelog

- v1 (2026-04-17) — initial landing, Phase 3 deliverable.
