# Migration Authoring Runbook

**Status:** Faz 7 of day-one baseline reset.
**Audience:** Service authors adding/modifying entities + migrations.
**Plan reference:** `/root/.claude/plans/peppy-crafting-waterfall.md`.

## TL;DR

```
Edit entity → typeorm migration:generate → human review (this runbook)
→ postCondition() probe for high-risk surfaces → PR → CI gates → merge.
```

No `// FIXME`, no `// HACK`, no `Align*EntitySurface`, no `Heal*Drift`,
no `Replay*Alignment`. The reset window closed this archetype permanently;
re-introducing it fails CI on the `drift-repair-naming` invariant (post-Faz-6).

## Step-by-step

### 1. Edit the entity (the only manual step)

```ts
// apps/farm-service/src/farm/entities/batch.entity.ts
@Entity('batches')
export class Batch {
  @Column({ name: 'expected_harvest_at', type: 'timestamptz', nullable: true })
  expectedHarvestAt?: Date;  // ← new column
}
```

ADR-011 reminder:
- per-tenant entity in a tenant-scoped service (farm/sensor/hr/messaging/
  hydroponics/ai/alert) → **OMIT `schema:`**, set tenantId column;
- cross-tenant entity (outbox/audit/retention) → **DECLARE `schema:`**.

The `entity-schema-declaration` invariant catches violations at PR time.

### 2. Generate the migration

```bash
npm run infra:up   # local dev Postgres
npx typeorm migration:generate \
  -d apps/<svc>/src/database/data-source.ts \
  apps/<svc>/src/database/migrations/<timestamp>-AddExpectedHarvestAt
```

TypeORM emits the diff against the live dev schema. The output ALWAYS
goes under `apps/<svc>/src/database/migrations/` (the path the runner
discovers; the bare `src/migrations/` legacy path exists only for
auth-service, admin-api-service, event-store-service, messaging-service).

### 3. Review the generated file

Mandatory checks (the gates enforce them, but reviewer pre-empts the
PR-fail churn):

- [ ] **Blue-green safety** — ALTER TABLE ADD COLUMN NOT NULL ONLY
      when paired with a backfill + SET NOT NULL three-step. Generated
      ADDs default to nullable; the post-condition rewrite is the
      reviewer's job.
- [ ] **FK actions** — every CREATE TABLE / ALTER TABLE adding a
      foreign key declares `ON DELETE RESTRICT ON UPDATE RESTRICT`.
      CASCADE is forbidden outside the protected-tables waiver path
      (per ADR-025 + Faz 1.4).
- [ ] **Search path pinned** — `await pinSearchPath(queryRunner, '<svc>')`
      at the top of up(). `migration-helpers.ts` provides the helper.
- [ ] **DDL safety wrapper** — wrap the heavy section in
      `withDdlSafety(queryRunner, { schema, advisoryLockKeySuffix })`.
- [ ] **No SAVEPOINT** — silent-rollback class banned. If genuinely
      needed (idempotency-only PL/pgSQL block with `EXCEPTION WHEN
      duplicate_object`), add `-- ALLOWS-SAVEPOINT: <reason>` marker
      AND declare `postCondition(qr)` that asserts the DDL landed.
- [ ] **Protected tables** — DROP TABLE / CASCADE / DROP COLUMN on a
      table listed in `libs/backend-common/src/constants/protected-tables.ts`
      requires `-- COMPLIANCE-WAIVER: <finding-id> <reason>` marker
      AND CODEOWNERS approval from compliance-expert + security-reviewer
      AND an ADR documenting the invariant relaxation.

### 4. (Optional but recommended) Declare a postCondition

For high-blast-radius migrations — anything touching audit immutability,
RLS policies, enum type drift, FK additions on populated tables, or
NOT NULL transitions — declare a post-condition probe:

```ts
import type { PostConditionAwareMigration } from '@aquaculture/backend-common/database';
import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExpectedHarvestAt1800000123456
  implements MigrationInterface, PostConditionAwareMigration
{
  async up(qr: QueryRunner): Promise<void> {
    // ... DDL ...
  }

  async down(qr: QueryRunner): Promise<void> {
    // ... rollback DDL ...
  }

  /**
   * After up() returns, BEFORE the wrapper tx commits, verify the
   * declared invariant actually landed. False / throw → wrapper tx
   * rollback → ledger row never commits.
   */
  async postCondition(qr: QueryRunner): Promise<boolean> {
    const rows = await qr.query(
      `SELECT 1 FROM information_schema.columns
         WHERE table_schema='farm' AND table_name='batches'
           AND column_name='expected_harvest_at'`,
    );
    return rows.length === 1;
  }
}
```

The post-condition probe is the architectural barrier against the
HR `HealHrEnumTypeDrift` class (ledger applied, DDL never ran).

### 5. Update MODULE_SCHEMAS (tenant-scoped services only)

If you added a new ENTITY (not a column) in a tenant-scoped service,
append the table name to the relevant module's `tables` array in
`libs/backend-common/src/database/schema-manager.service.ts`. The
`tenant-fanout-entity-parity` invariant catches omissions at PR time.

Cross-tenant tables (outbox, audit, retention) go in
`infrastructureTables` instead.

### 6. PR + CI

Local sanity:

```bash
nx test invariants    # all 8 source-level invariants
nx affected --target=type-check
nx affected --target=lint
```

CI gates (db-migration-check.yml workflow):
- migration-sql-lint (R1-R12 + R13 protected-tables R6)
- migration-deletion-witness
- entity-diff-witness
- schema-drift-registration
- bootstrap-from-scratch
- criticality-manifest + signals-manifest
- tenant-clone-parity

CI fail-fast classes:
- entity-diff without matching migration → fail
- DROP on protected table without waiver → fail
- SAVEPOINT without marker → fail
- RLS policy with non-canonical predicate → fail
- per-tenant entity with `schema:` declaration → fail
- new "Align*" / "Heal*" / "Repair*" / "Replay*" / "Reconcile*" / "Sync*"
  prefix migration → fail (post-Faz-6 only).

### 7. Commit + push

CLAUDE.md commit format:

```
{type}({scope}): {subject}

{body explaining WHY}

Closes: docs/reviews/{agent}/{YYYY-MM-DD}-{topic}.md#{FINDING-ID}
```

The `Closes:` trailer is mandatory for `fix`/`security`/`feat` commit
types per the `commit-msg-validator.ts` gate.

## Anti-patterns (banned)

| Pattern | Why banned | Alternative |
|---|---|---|
| `SAVEPOINT` inside up() | silent-rollback class | three-step blue-green ADD; post-condition probe |
| `EXCEPTION WHEN OTHERS THEN NULL` | swallows security failures | `EXCEPTION WHEN duplicate_object THEN NULL` (specific) |
| `ALTER TABLE ADD COLUMN NOT NULL DEFAULT ...` on populated table | rewrites every row in one tx | nullable add → backfill → SET NOT NULL |
| `CREATE INDEX` (not CONCURRENTLY) on populated table | ACCESS EXCLUSIVE on writes | `CREATE INDEX CONCURRENTLY IF NOT EXISTS` + `transaction = false` on the migration |
| Bare `DROP TABLE` on protected name | data loss + audit invariant break | COMPLIANCE-WAIVER marker + CODEOWNERS approval + ADR |
| `Align*EntitySurface` / `Heal*Drift` / `Replay*` filename | drift archaeology pattern | post-Faz-6: invariant `drift-repair-naming` blocks; root-cause the missing migration instead |
| Hand-rolled CREATE POLICY for tenant_isolation | typo = cross-tenant leak | `applyTenantRlsToSchema(qr, { ... })` |
| Hand-rolled CREATE TYPE ... AS ENUM bare | crashes on re-run with `42710` | `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object` wrapper |

## Forward-only history

Migrations on `main` are immutable. The force-push ban + amending ban
combine to make pre-merge review the only place to correct mistakes.
If a migration ships a bug:

1. New forward migration corrects the bug (e.g. ADD COLUMN if missing,
   ALTER TYPE if drift, INSERT if seed missed a row).
2. The correcting migration MAY declare `postCondition` to verify the
   correction landed.
3. Never amend a merged migration; never delete a merged migration
   except through the `migration-deletion-witness` gate's witness path.

## Reference

- Source: `libs/backend-common/src/database/migration-runner/migration-runner.service.ts`
- Helpers: `libs/backend-common/src/database/migration-helpers.ts`
- RLS helper: `libs/backend-common/src/database/rls/apply-tenant-rls.helper.ts`
- Protected tables: `libs/backend-common/src/constants/protected-tables.ts`
- Drift classes: `libs/backend-common/src/database/schema-drift/drift-classes.ts`
- Invariants: `tests/invariants/{entity-schema-declaration,entity-diff-implies-migration,no-savepoint-in-migrations,protected-tables-guard,rls-predicate-canonical,tenant-fanout-entity-parity,shared-schema-canonical}.spec.ts`
- ADRs: 011 Schema Ownership · 012 Drift Prevention · 025 Edge Per-Tenant · 030 Day-One Reset
