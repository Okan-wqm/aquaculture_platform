import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  dropDependentPartialIndexes,
  parseAlterColumnTypeTargets,
} from '@aquaculture/backend-common/database';
import { listHrOwnedEntities } from './hr-owned-entities';

/**
 * HealHrEnumTypeDrift
 * ============================================================================
 *
 * Heals the residual `hr` schema drift left behind by
 * SyncHrEntitiesToDb1786800000000 when the SAVEPOINT-per-statement band-aid
 * (commit 5df00179) swallowed the
 *
 *   ALTER TABLE hr.employee_certifications ALTER COLUMN status
 *   TYPE hr.employee_certifications_status_enum USING …
 *
 * failure on deploy 8 (2026-04-20 18:32 UTC). That ALTER was blocked by a
 * legacy partial index whose WHERE predicate casts 'active' to the OLD enum
 * type `hr.certification_status`; PG's partial-index predicate re-validation
 * during ALTER COLUMN TYPE aborted because no equality operator exists
 * between the new enum and the old enum literal. SAVEPOINT rolled back the
 * single statement, db-migrate exited 0, TypeORM marked 1786800000000 as
 * applied — but hr-service's SchemaDriftValidator on the next boot saw the
 * drift, never emitted the `Schema drift scan clean` required-signals
 * invariant, and the deploy rolled back after 7.5 min of boot-signal
 * timeout.
 *
 * # Why a new migration, not a re-run of 1786800000000
 *
 * TypeORM's migrations table records 1786800000000 as applied. Its `up()`
 * will never re-run, so updating that file in place (which commit 3686e3c5
 * did: replaced SAVEPOINT with pre-flight DROP) produced reference
 * documentation but not executable healing. The drift in production
 * remained. This migration is the executable companion — a distinct entry
 * in the migrations table that TypeORM treats as pending and runs on the
 * next deploy.
 *
 * # Approach
 *
 * Architecturally identical to the Tier-1 shape landed in 3686e3c5 for
 * 1786800000000 (which is now the reference implementation for future
 * catch-up migrations):
 *
 *   1. Empty-table guard — refuses to run if any hr table has rows.
 *      Re-entering the catch-up on non-empty tables requires hand-
 *      authored data-preserving ALTERs; this migration is not a
 *      substitute for that class of migration.
 *
 *   2. Pre-create `hr.typeorm_metadata` via `conn.query()` (separate
 *      auto-commit connection) so that `RdbmsSchemaBuilder.log()`'s
 *      freshly-acquired queryRunner can SELECT against it — the same
 *      bug worked around by a14ea7ca's typeorm_metadata pre-create
 *      pattern, repeated here because each migration's
 *      `MigrationExecutor.transaction='each'` transaction is independent.
 *
 *   3. Invoke `log()` to get the catch-up DDL plan. Filter to statements
 *      that touch the `"hr".` schema qualifier (TypeORM always emits
 *      fully-qualified identifiers when an entity declares `schema:`).
 *
 *   4. Validator-relevant whitelist — same object-class filter the
 *      reference implementation uses (CREATE TYPE/TABLE, ADD COLUMN,
 *      ALTER COLUMN any sub-action). Rewrites each statement to an
 *      idempotent form (IF NOT EXISTS where supported; DO-block swallow
 *      for CREATE TYPE duplicate_object).
 *
 *   5. **Pre-flight DROP of blocking partial indexes.** This is the
 *      change that makes the ALTER succeed deterministically.
 *      `parseAlterColumnTypeTargets` extracts every
 *      (schema, table, column) the migration is about to ALTER TYPE;
 *      `dropDependentPartialIndexes` queries pg_indexes for partial
 *      indexes whose WHERE predicate references any target column and
 *      DROPs each one. Index definitions the entity model re-declares
 *      are re-created by TypeORM's own CREATE INDEX emissions later in
 *      the apply loop; legacy indexes the entity model does not declare
 *      stay dropped (correct end-state under ADR-012's entity-first
 *      schema contract).
 *
 *   6. **Deterministic apply — no SAVEPOINT.** Any failure propagates to
 *      the orchestrator and rolls back the migration transaction. A real
 *      failure surfaces in the deploy log rather than being swallowed.
 *
 *   7. Propagate to every existing `tenant_<uuid>` clone. Legacy partial
 *      indexes were cloned into each tenant schema at tenant onboarding,
 *      so the pre-flight DROP must also run per-tenant.
 *
 * # Why a no-op down()
 *
 * This migration does not introduce new structural objects; it reconciles
 * entity-declared columns into a schema that diverged from the entity
 * model. "Rolling back" means re-introducing the drift, which has no
 * defensible operator use case. Operators who need the pre-heal shape
 * should restore from the pre-deploy pg_dump backup (the canonical
 * recovery path for DDL changes per docs/runbooks/schema-drift-response.md).
 */
export class HealHrEnumTypeDrift1786900000000 implements MigrationInterface {
  private readonly logger = new Logger('HealHrEnumTypeDrift1786900000000');

  /** Tenant-schema identifier regex — rejects anything outside the canonical pattern. */
  private static readonly SAFE_TENANT_SCHEMA = /^tenant_[a-f0-9]{16}$/;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const conn = queryRunner.connection;

    const hrEntities = listHrOwnedEntities(conn.entityMetadatas);
    if (hrEntities.length === 0) {
      // Non-entity-aware runner path (e.g. legacy `typeorm migration:run` CLI
      // without apps/hr-service entities bundled). Silent skip rather than
      // throw — under aqua-db-migrate's entity-aware orchestrator this
      // branch is unreachable (the orchestrator loads hr entities before
      // invoking this migration), and a throw would break non-aqua-db-migrate
      // invocations that have no use for this healing step.
      this.logger.warn(
        'HealHrEnumTypeDrift: no HR-owned entities on connection — skipping (likely non-entity-aware runner).',
      );
      return;
    }

    this.logger.log(
      `Found ${hrEntities.length} hr-scoped entities for drift healing: ${hrEntities
        .map((m) => m.tableName)
        .join(', ')}`,
    );

    // Empty-table precondition — healing is only safe on empty tables.
    // Non-empty tables require data-preserving per-column ALTERs authored
    // against each tenant's actual data shape.
    for (const meta of hrEntities) {
      const exists: Array<{ count: string }> = await conn.query(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables
         WHERE table_schema = 'hr' AND table_name = $1 AND table_type = 'BASE TABLE'`,
        [meta.tableName],
      );
      if (Number(exists[0]?.count ?? '0') === 0) continue;
      const rowCountRows: Array<{ count: string }> = await conn.query(
        `SELECT COUNT(*)::text AS count FROM hr."${meta.tableName}"`,
      );
      const rowCount = Number(rowCountRows[0]?.count ?? '0');
      if (rowCount > 0) {
        throw new Error(
          `HealHrEnumTypeDrift: hr."${meta.tableName}" has ${rowCount} row(s) — refusing to run. ` +
            `Healing is only safe on empty tables. Operator must write data-preserving ` +
            `per-column ALTER scripts manually for non-empty hr tables.`,
        );
      }
    }

    // Pre-create typeorm_metadata on a separate auto-commit connection.
    // log() opens its OWN queryRunner from the pool; a CREATE TABLE issued
    // on the transactional migration queryRunner would not be visible to
    // log() until after up() returns. Route through conn.query() so the
    // statement commits before log() inspects the schema.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS "hr"."typeorm_metadata" (
        "type" varchar NOT NULL,
        "database" varchar,
        "schema" varchar,
        "table" varchar,
        "name" varchar,
        "value" text
      )
    `);

    const sqlInMemory = await conn.driver.createSchemaBuilder().log();
    const allUpQueries = sqlInMemory.upQueries;
    const hrUpQueries = allUpQueries.filter((q) => /"hr"\./i.test(q.query));

    const isValidatorRelevant = (sql: string): boolean => {
      const t = sql.trim();
      if (/^CREATE\s+TYPE\b/i.test(t)) return true;
      if (/^CREATE\s+TABLE\b/i.test(t)) return true;
      if (/^ALTER\s+TABLE\b[^;]*?\bADD\s+(?!CONSTRAINT\b)"/i.test(t)) return true;
      if (/^ALTER\s+TABLE\b[^;]*?\bALTER\s+COLUMN\b/i.test(t)) return true;
      return false;
    };

    const makeIdempotent = (sql: string): string => {
      let s = sql;
      s = s.replace(/^CREATE\s+TABLE\s+"/i, 'CREATE TABLE IF NOT EXISTS "');
      s = s.replace(
        /(\bALTER\s+TABLE\s+"[^"]+"\."[^"]+"\s+)ADD\s+"/i,
        '$1ADD COLUMN IF NOT EXISTS "',
      );
      if (/^CREATE\s+TYPE\b/i.test(s)) {
        s = `DO $$ BEGIN ${s}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`;
      }
      return s;
    };

    const relevantQueries = hrUpQueries
      .filter((q) => isValidatorRelevant(q.query))
      .map((q) => ({ ...q, query: makeIdempotent(q.query) }));
    const skippedNonValidator = hrUpQueries.length - relevantQueries.length;

    this.logger.log(
      `RdbmsSchemaBuilder emitted ${allUpQueries.length} queries; ` +
        `${hrUpQueries.length} target hr schema; ` +
        `${relevantQueries.length} are validator-relevant ` +
        `(${skippedNonValidator} non-validator-relevant skipped); ` +
        `${allUpQueries.length - hrUpQueries.length} foreign-schema skipped.`,
    );

    if (relevantQueries.length === 0) {
      this.logger.log(
        'hr schema already aligned with entity model — healing migration is a no-op. ' +
          'This is the expected end-state after the heal + every subsequent deploy.',
      );
      return;
    }

    // Pre-flight: DROP partial indexes whose WHERE predicate would block
    // any ALTER COLUMN TYPE in `relevantQueries`.
    const alterTypeTargets = parseAlterColumnTypeTargets(relevantQueries.map((q) => q.query));
    if (alterTypeTargets.length > 0) {
      const droppedDeps = await dropDependentPartialIndexes(queryRunner, alterTypeTargets);
      this.logger.log(
        `Source hr schema: pre-flight DROP of ${droppedDeps.length} ` +
          `dependent object(s) on ${alterTypeTargets.length} ALTER-COLUMN-TYPE target(s). ` +
          (droppedDeps.length > 0
            ? `Dropped: ${droppedDeps
                .map((d) => `${d.kind}:${d.schema}.${d.name} (blocking ${d.table}.${d.column})`)
                .join(', ')}.`
            : 'No blocking partial indexes, constraint-backed indexes, or CHECK constraints present.'),
      );
    }

    // Deterministic apply — no SAVEPOINT swallowing.
    for (const q of relevantQueries) {
      this.logger.debug(`[hr] ${q.query.slice(0, 120).replace(/\s+/g, ' ')}`);
      await queryRunner.query(q.query, q.parameters as unknown[] | undefined);
    }
    this.logger.log(
      `Source hr schema: applied ${relevantQueries.length} validator-relevant heal queries.`,
    );

    // Propagate to every tenant clone.
    const tenantRows: Array<{ schema_name: string }> = await conn.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant\\_%' ESCAPE '\\'
      ORDER BY schema_name
    `);
    const tenantSchemas = tenantRows
      .map((r) => r.schema_name)
      .filter((s) => HealHrEnumTypeDrift1786900000000.SAFE_TENANT_SCHEMA.test(s));

    if (tenantSchemas.length === 0) {
      this.logger.log('No tenant clones found — propagation step is a no-op.');
      return;
    }

    this.logger.log(
      `Propagating heal to ${tenantSchemas.length} tenant clone(s): ${tenantSchemas.join(', ')}`,
    );

    for (const tenantSchema of tenantSchemas) {
      // Empty-table guard per-tenant.
      let tenantHasData = false;
      for (const meta of hrEntities) {
        const tableExists: Array<{ count: string }> = await conn.query(
          `SELECT COUNT(*)::text AS count FROM information_schema.tables
           WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
          [tenantSchema, meta.tableName],
        );
        if (Number(tableExists[0]?.count ?? '0') === 0) continue;
        const rowCount: Array<{ count: string }> = await conn.query(
          `SELECT COUNT(*)::text AS count FROM "${tenantSchema}"."${meta.tableName}"`,
        );
        if (Number(rowCount[0]?.count ?? '0') > 0) {
          tenantHasData = true;
          break;
        }
      }
      if (tenantHasData) {
        this.logger.warn(
          `[${tenantSchema}] has data in at least one hr table — skipping heal. ` +
            `Operator must apply per-column ALTER scripts manually for this tenant.`,
        );
        continue;
      }

      // Rewrite `"hr".` → `"${tenantSchema}".` on each relevant query so the
      // pre-flight DROP and the apply loop see the same schema-rebased text.
      const tenantQueries = relevantQueries.map((q) => ({
        query: q.query.replace(/"hr"\./g, `"${tenantSchema}".`),
        parameters: q.parameters,
      }));

      const tenantAlterTargets = parseAlterColumnTypeTargets(tenantQueries.map((q) => q.query));
      if (tenantAlterTargets.length > 0) {
        const droppedTenantDeps = await dropDependentPartialIndexes(
          queryRunner,
          tenantAlterTargets,
        );
        this.logger.log(
          `[${tenantSchema}] pre-flight DROP of ${droppedTenantDeps.length} ` +
            `dependent object(s) on ${tenantAlterTargets.length} ALTER-COLUMN-TYPE target(s). ` +
            (droppedTenantDeps.length > 0
              ? `Dropped: ${droppedTenantDeps
                  .map((d) => `${d.kind}:${d.name} (blocking ${d.table}.${d.column})`)
                  .join(', ')}.`
              : 'No blocking partial indexes, constraint-backed indexes, or CHECK constraints present.'),
        );
      }

      for (const q of tenantQueries) {
        await queryRunner.query(q.query, q.parameters as unknown[] | undefined);
      }
      this.logger.log(
        `[${tenantSchema}] applied ${tenantQueries.length} validator-relevant heal queries.`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Intentional no-op — this migration reconciles drift introduced by the
    // 5df00179 SAVEPOINT band-aid. "Rolling back" would re-introduce the drift
    // and break hr-service boot on the next cold start. Operators who need
    // the pre-heal schema shape should restore from the pre-deploy pg_dump
    // backup (the canonical recovery path for DDL per
    // docs/runbooks/schema-drift-response.md).
  }
}
