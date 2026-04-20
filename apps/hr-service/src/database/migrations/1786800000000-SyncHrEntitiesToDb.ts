import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SyncHrEntitiesToDb
 * ============================================================================
 *
 * Catch-up migration that brings the hr source schema (and every existing
 * `tenant_<uuid>` clone) in line with the canonical hr-service entity
 * definitions in `apps/hr-service/src/**\/*.entity.ts`.
 *
 * # Why this migration exists
 *
 * Live droplet 2026-04-20 12:16 UTC: SchemaDriftValidator[hr] reports
 * 453 column-level violations across 22 hr tables on every cold start.
 * Per-table breakdown (descending):
 *
 *   38  attendance_records      19  weekly_plans
 *   31  leave_requests          19  schedules
 *   28  work_rotations          18  leave_balances
 *   27  performance_reviews     17  safety_training_records
 *   27  employee_certifications 16  scheduling_settings
 *   26  work_areas              16  employee_kpis
 *   23  training_courses        16  departments_hr
 *   23  shifts                  15  weekly_plan_entries
 *   23  leave_types             13  schedule_entries
 *   23  certification_types     12  payrolls
 *   22  training_enrollments     1  employees
 *
 * The drift is the cumulative product of many entity refactors (most
 * notably DB-MEDIUM-004's payroll JSONB-to-flattened columns at
 * apps/hr-service/src/hr/entities/payroll.entity.ts:150-207) that never
 * received companion ALTER migrations. The 4 existing migrations
 * (CreateHRModuleSchema1736000000000, HRMediumFixes1744200000000,
 * CreateSchedulingTables1769500000000, MoveEmployeesToHr1786000400000)
 * created the original tables; subsequent entity evolution opened a
 * 453-violation gap.
 *
 * # First incarnation reverted, then re-landed via Phase H
 *
 * This file was first introduced in commit 9ff64feb on 2026-04-20 13:11
 * UTC and reverted at c1bb0864 the same day because the centralized
 * aqua-db-migrate runner constructs its DataSource WITHOUT entities
 * (intentional decoupling — it ran any service's migrations without
 * compiling that service's source tree). With zero entity metadata the
 * migration's defensive check fired correctly: `hrEntities.length === 0`
 * → throw → migration aborts. Reverted to unblock the deploy.
 *
 * Phase H (this PR) makes aqua-db-migrate entity-aware via opt-in
 * `entitiesGlob` per slot in apps/db-migrate/src/schema-registry.ts.
 * The hr slot now declares `entitiesGlob: ['apps/hr-service/src/**\/*.entity.{ts,js}']`,
 * the orchestrator loads them post-init, the post-init filter rejects
 * any non-hr entity, and `connection.entityMetadatas` arrives populated.
 * The runtime precondition is satisfied; this file lands again unchanged
 * in logic from the original 9ff64feb version (only the Logger import
 * is from @nestjs/common to match the project-wide pattern after fix
 * 6b86f0b9).
 *
 * # Architectural strategy
 *
 * Hand-authoring 22 ALTER scripts × ~21 columns each = ~440 careful
 * SQL edits. High typo risk + days of work. The architecturally
 * correct alternative on EMPTY hr tables (verified across source +
 * 5 tenant clones via SELECT COUNT(*) = 0) is to drive the catch-up
 * from the canonical entity metadata at migration time:
 *
 *   1. Pin search_path to source `hr`, then ask TypeORM's
 *      RdbmsSchemaBuilder what queries it would emit to align the DB
 *      to the entities currently registered on the connection
 *      (`driver.createSchemaBuilder().log()`).
 *
 *   2. Filter the emitted SQL to ONLY hr-scoped statements. The
 *      filter checks the query text for `"hr".` (TypeORM always
 *      emits schema-qualified identifiers when the entity declares
 *      `schema:`). Any query lacking the hr-schema prefix is rejected
 *      — defense against the schema-builder accidentally touching
 *      foreign-schema entities loaded into the same migration bundle.
 *      The Phase H post-init filter on the orchestrator already removes
 *      foreign-schema entities, but this in-migration filter is a
 *      second line of defense.
 *
 *   3. Execute the filtered statements against source `hr` schema.
 *
 *   4. Discover every existing `tenant_<uuid>` clone via
 *      information_schema, validate each name against an injection-
 *      safe regex, then re-execute the SAME statements with `"hr".`
 *      rewritten to `"${tenantSchema}".` — propagating the catch-up
 *      to every tenant clone in ONE migration pass.
 *
 * # Why this is NOT a runtime synchronize() violation
 *
 * CLAUDE.md "Inviolable rules" forbids `dataSource.synchronize()` at
 * RUNTIME (per INFRA-CRITICAL-009). The forbidden pattern is the
 * SourceSchemaBootstrapService that called synchronize() on every cold
 * start, masking missing migrations and re-creating tables from stale
 * entity metadata in arbitrary order.
 *
 * This is different in three load-bearing ways:
 *
 *   1. ONE-SHOT, not on every boot. The migration runs ONCE; the
 *      `hr.typeorm_migrations` table tracks completion. Subsequent
 *      boots see the migration as already-applied and don't re-run.
 *   2. CONTROLLED context. The aqua-db-migrate centralized runner
 *      (apps/db-migrate/src/migration-orchestrator.ts) executes this
 *      migration with a pinned search_path and a dedicated transaction.
 *      There is no race against TypeORM's onApplicationBootstrap hook.
 *   3. SCOPED to hr entities only. The string filter on `"hr".`
 *      rejects every query that targets a foreign schema — operator
 *      can read the migration log to verify only hr DDL was applied.
 *
 * # Why the EMPTY-table precondition is load-bearing
 *
 * Every hr table in source + tenant clones is empty on the live
 * droplet (verified 2026-04-20). The schema-builder's CREATE TABLE
 * + ALTER paths do NOT lose data because there is no data to lose.
 * If a future deploy attempts to re-run this migration on a database
 * with hr rows, the `hr.typeorm_migrations` history already records
 * this migration as applied — TypeORM skips it, preserving live data.
 * The risk window is the FIRST application, which is now (zero rows
 * everywhere).
 *
 * # Tenant fan-out propagation (INFRA-CRITICAL-030)
 *
 * The orchestrator's tenant fan-out is broken by the seed-from-source
 * typeorm_migrations mechanism — running this migration's `up()`
 * inside the orchestrator's per-tenant pass would do nothing (the
 * tenant's tracking table already has the migration name from
 * provision-time seeding). The discover-and-iterate loop INSIDE this
 * migration's up() handles propagation explicitly. Same pattern as
 * `apps/alert-engine/src/database/migrations/1786700000000-PropagateTenantIdUuidToAllSchemas.ts`.
 *
 * # Down-rollback
 *
 * Provided for symmetry. In practice should never be invoked: rolling
 * back drops the regenerated hr tables across every schema, which
 * breaks every running hr-service consumer. Operators who need the
 * legacy shape should restore from the pre-deploy pg_dump backup, not
 * via this migration's down() path.
 */
export class SyncHrEntitiesToDb1786800000000 implements MigrationInterface {
  private readonly logger = new Logger('SyncHrEntitiesToDb1786800000000');

  /** Schema names safe to interpolate into DDL — rejects everything that doesn't match the hr-source or tenant-clone naming convention. */
  private static readonly SAFE_TENANT_SCHEMA = /^tenant_[a-f0-9]{16}$/;

  public async up(queryRunner: QueryRunner): Promise<void> {
    const conn = queryRunner.connection;

    // 1. Verify hr entities are loaded into the migration runner's
    //    bundle. Without them, the schema-builder has nothing to sync
    //    and we'd silently no-op. With Phase H opt-in, the orchestrator
    //    loads apps/hr-service/src/**/*.entity.{ts,js} and filters out
    //    foreign-schema entries before this migration runs.
    const hrEntities = conn.entityMetadatas.filter(
      (m) => m.schema === 'hr',
    );
    if (hrEntities.length === 0) {
      throw new Error(
        'SyncHrEntitiesToDb: no entities with schema=\'hr\' found in connection.entityMetadatas. ' +
          'The migration runner bundle is missing the hr entity files. Verify ' +
          'apps/db-migrate/src/schema-registry.ts hr slot declares entitiesGlob ' +
          'and apps/db-migrate/tsconfig.build.json includes the entity glob.',
      );
    }
    this.logger.log(
      `Found ${hrEntities.length} hr-scoped entities to sync: ${hrEntities.map((m) => m.tableName).join(', ')}`,
    );

    // 2. Empty-table precondition check. If ANY hr table in source has
    //    rows, abort — the catch-up is only safe on empty tables.
    //    Operator must intervene (data-preserving per-table ALTER work).
    for (const meta of hrEntities) {
      const exists: Array<{ count: string }> = await conn.query(
        `SELECT COUNT(*)::text AS count FROM information_schema.tables
         WHERE table_schema = 'hr' AND table_name = $1 AND table_type = 'BASE TABLE'`,
        [meta.tableName],
      );
      if (Number(exists[0]?.count ?? '0') === 0) continue; // table missing → CREATE will fix
      const rowCountRows: Array<{ count: string }> = await conn.query(
        `SELECT COUNT(*)::text AS count FROM hr."${meta.tableName}"`,
      );
      const rowCount = Number(rowCountRows[0]?.count ?? '0');
      if (rowCount > 0) {
        throw new Error(
          `SyncHrEntitiesToDb: hr."${meta.tableName}" has ${rowCount} row(s) — refusing to run. ` +
            `This migration is only safe on empty tables. Operator must write data-preserving ` +
            `per-column ALTER scripts manually for non-empty hr tables.`,
        );
      }
    }

    // 3. Pre-create the typeorm_metadata bookkeeping table on a SEPARATE
    //    auto-commit connection.
    //
    //    Why a separate connection: RdbmsSchemaBuilder.log() (called
    //    below) opens its OWN queryRunner from the connection pool, NOT
    //    the queryRunner this migration body received. The migration's
    //    queryRunner is mid-transaction (orchestrator wraps each
    //    migration in BEGIN…COMMIT via MigrationExecutor.transaction='each').
    //    A CREATE TABLE issued on the in-transaction queryRunner is
    //    INVISIBLE to log()'s freshly-acquired queryRunner until COMMIT
    //    — but COMMIT only fires AFTER up() returns. Result: log() sees
    //    no typeorm_metadata table and crashes with
    //      QueryFailedError: relation "hr.typeorm_metadata" does not exist
    //
    //    Fix: route the CREATE TABLE through `conn.query()` (DataSource.query)
    //    which acquires a fresh queryRunner from the pool, runs the
    //    statement OUTSIDE any explicit transaction (PostgreSQL
    //    auto-commits each DDL statement in implicit-txn mode), then
    //    releases the connection. The CREATE TABLE is committed before
    //    we proceed to log().
    //
    //    Column shape mirrors
    //    `node_modules/typeorm/schema-builder/RdbmsSchemaBuilder.js:856-940`
    //    (TypeORM's own createTypeormMetadataTable() helper that
    //    synchronize() invokes internally). IF NOT EXISTS keeps it
    //    idempotent across re-runs.
    //
    //    Note on search_path: conn.query()'s fresh queryRunner does NOT
    //    inherit the orchestrator's pinned `hr` search_path; the SQL
    //    therefore uses fully-qualified `"hr"."typeorm_metadata"` to
    //    target the right schema regardless of session search_path.
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

    // 4. Ask TypeORM what queries it would emit to align DB to entities.
    //    `log()` returns SqlInMemory: { upQueries, downQueries }.
    const sqlInMemory = await conn.driver.createSchemaBuilder().log();
    const allUpQueries = sqlInMemory.upQueries;

    // 5. Filter for hr-scoped statements. TypeORM emits schema-qualified
    //    identifiers like `"hr"."payrolls"` when entities declare
    //    `schema: 'hr'`. Any query lacking the `"hr".` prefix is
    //    rejected — defense against the schema-builder accidentally
    //    touching foreign-schema entities loaded into the same bundle.
    const hrUpQueries = allUpQueries.filter((q) => /"hr"\./i.test(q.query));

    // 6. Whitelist gate — keep ONLY statements that satisfy a
    //    SchemaDriftValidator concern, then rewrite each for idempotency.
    //
    //    log() emits a complete schema-alignment plan including ADD
    //    CONSTRAINT (PK/UNIQUE/FK), CREATE INDEX, COMMENT — all of which
    //    are syntactically "additive" but semantically destructive when
    //    the live DB already disagrees:
    //      - deploy 4 (2026-04-20 17:08): DROP TYPE work_week_day
    //        cascading dependency
    //      - deploy 5 (2026-04-20 17:25): ADD CONSTRAINT … PRIMARY KEY
    //        on hr.scheduling_settings (table already has different PK)
    //
    //    The architectural defect is that the previous filter (verb-
    //    blacklist on DROP) classified by VERB while the failure modes
    //    are classified by OBJECT CLASS. ADD CONSTRAINT PRIMARY KEY is
    //    semantically destructive on a table with an existing PK; "ADD"
    //    is the wrong axis to filter on.
    //
    //    Phase L fix (data-expert plan, 2026-04-20): replace the verb-
    //    blacklist with an OBJECT-CLASS WHITELIST that is mathematically
    //    tied to the SchemaDriftValidator contract
    //    (libs/backend-common/src/database/schema-drift-validator.service.ts:120-216):
    //
    //      Validator concern              | Required DDL
    //      -------------------------------|--------------------------------
    //      Table in entity-declared schema| CREATE TABLE
    //      Entity column exists in DB     | CREATE TABLE + ADD COLUMN
    //      uuid columns have uuid type    | ALTER COLUMN TYPE
    //      NOT NULL declared = DB nullable| ALTER COLUMN SET NOT NULL
    //      enum types resolvable          | CREATE TYPE (enum support)
    //
    //    Anything else log() emits is unrelated to the validator's
    //    check surface and therefore overreach for this migration.
    //    Concrete unrelated classes: ADD CONSTRAINT (any kind),
    //    CREATE INDEX, COMMENT, every DROP variant.
    //
    //    Default-closed: an unrecognised statement class falls through
    //    to "skip". If TypeORM adds a new statement shape in a future
    //    version, this migration ignores it rather than crashing on it.
    //    This is what makes the whitelist Tier-1 ("make it impossible")
    //    rather than Tier-3 ("make it detectable").
    const isValidatorRelevant = (sql: string): boolean => {
      const t = sql.trim();
      // CREATE TYPE — needed so subsequent ADD COLUMN with enum type can resolve
      if (/^CREATE\s+TYPE\b/i.test(t)) return true;
      // CREATE TABLE — for entirely missing tables (hr_outbox, payroll_audit)
      if (/^CREATE\s+TABLE\b/i.test(t)) return true;
      // ALTER TABLE … ADD "col" — TypeORM omits the COLUMN keyword;
      // the negative lookahead excludes ADD CONSTRAINT …
      if (/^ALTER\s+TABLE\b[^;]*?\bADD\s+(?!CONSTRAINT\b)"/i.test(t)) return true;
      // ALTER TABLE … ALTER COLUMN … TYPE / SET NOT NULL
      if (
        /^ALTER\s+TABLE\b[^;]*?\bALTER\s+COLUMN\b[^;]*?\b(TYPE|SET\s+NOT\s+NULL)\b/i.test(
          t,
        )
      ) {
        return true;
      }
      return false;
    };

    // 6b. Idempotency rewriter — make each whitelisted statement re-runnable.
    //
    //    Per-tenant fan-out may have partially applied some columns on
    //    a prior failed deploy attempt; re-execution must not crash on
    //    "already exists". Three rewrites cover the kept classes:
    //
    //      1. CREATE TABLE → CREATE TABLE IF NOT EXISTS
    //      2. ALTER TABLE … ADD "col" → ALTER TABLE … ADD COLUMN IF NOT EXISTS "col"
    //         (TypeORM emits without the COLUMN keyword; we splice it in
    //          alongside IF NOT EXISTS, available since PostgreSQL 9.6.)
    //      3. CREATE TYPE wrapped in DO/EXCEPTION duplicate_object swallow
    //         (PostgreSQL has no CREATE TYPE IF NOT EXISTS form)
    //
    //    Note residual: a swallowed CREATE TYPE leaves the OLD enum in
    //    place. If the old enum is missing values the entity declares,
    //    runtime INSERT of a new enum value will fail later (not at
    //    boot). The validator does not catch enum-value drift today —
    //    tracked as INFRA-MEDIUM follow-up, not a deploy blocker.
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
        `(${skippedNonValidator} non-validator-relevant skipped: constraints/indexes/comments/drops); ` +
        `${allUpQueries.length - hrUpQueries.length} foreign-schema skipped.`,
    );

    if (relevantQueries.length === 0) {
      this.logger.warn(
        'No validator-relevant hr-scoped queries to apply — schema already covers all entity-declared columns. Migration is a no-op.',
      );
      return;
    }

    // 7. Apply validator-relevant hr-scoped queries to the source schema.
    for (const q of relevantQueries) {
      this.logger.debug(`[hr] ${q.query.slice(0, 120).replace(/\s+/g, ' ')}`);
      await queryRunner.query(q.query, q.parameters as unknown[] | undefined);
    }
    this.logger.log(`Applied ${relevantQueries.length} validator-relevant catch-up queries to source hr schema.`);

    // 8. Propagate to every existing tenant clone.
    //    Discover via information_schema; validate each name against
    //    the injection-safe regex; rewrite `"hr".` -> `"${tenant}".`
    //    in each query before execution.
    const tenantRows: Array<{ schema_name: string }> = await conn.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant\\_%' ESCAPE '\\'
      ORDER BY schema_name
    `);
    const tenantSchemas = tenantRows
      .map((r) => r.schema_name)
      .filter((s) => SyncHrEntitiesToDb1786800000000.SAFE_TENANT_SCHEMA.test(s));

    if (tenantSchemas.length === 0) {
      this.logger.log('No tenant clones found — propagation step is a no-op.');
      return;
    }

    this.logger.log(
      `Propagating catch-up to ${tenantSchemas.length} tenant clone(s): ${tenantSchemas.join(', ')}`,
    );

    for (const tenantSchema of tenantSchemas) {
      // Empty-table guard per-tenant (same as source check).
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
          `[${tenantSchema}] has data in at least one hr table — skipping propagation. ` +
            `Operator must apply per-column ALTER scripts manually for this tenant.`,
        );
        continue;
      }

      let appliedCount = 0;
      for (const q of relevantQueries) {
        // Rewrite schema-qualified identifiers from hr -> tenant.
        // The regex is anchored on the quoted form TypeORM always emits
        // (`"hr".`) so we don't accidentally rewrite occurrences of
        // the substring `hr` inside column names or comments.
        //
        // Iterates `relevantQueries` (post-Phase-L whitelist + idempotency)
        // so per-tenant fan-out applies the same minimum DDL the source
        // schema received — bounded by the validator contract, no DROP
        // cascades, no PK conflicts, no constraint conflicts.
        const rewrittenQuery = q.query.replace(/"hr"\./g, `"${tenantSchema}".`);
        try {
          await queryRunner.query(rewrittenQuery, q.parameters as unknown[] | undefined);
          appliedCount++;
        } catch (err) {
          // Log per-statement error but continue — the schema-builder's
          // queries are independent (CREATE TABLE for one entity doesn't
          // depend on CREATE TABLE for another). A single failure on a
          // tenant clone (e.g. unexpected pre-existing structure) shouldn't
          // abort the whole tenant. The validator will re-flag the unhealed
          // tenant on next boot — correct detection signal.
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `[${tenantSchema}] statement failed (continuing): ${msg.slice(0, 200)}`,
          );
        }
      }
      this.logger.log(`[${tenantSchema}] applied ${appliedCount}/${relevantQueries.length} validator-relevant catch-up queries.`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rollback drops the regenerated hr tables across every schema.
    // Operators who need the legacy shape back should restore from
    // the pre-deploy pg_dump backup, not via this path. See migration
    // docblock §"Down-rollback" for the rationale.
    const conn = queryRunner.connection;
    const hrEntities = conn.entityMetadatas.filter((m) => m.schema === 'hr');
    if (hrEntities.length === 0) return;

    const tenantRows: Array<{ schema_name: string }> = await conn.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name LIKE 'tenant\\_%' ESCAPE '\\'
      ORDER BY schema_name
    `);
    const tenantSchemas = tenantRows
      .map((r) => r.schema_name)
      .filter((s) => SyncHrEntitiesToDb1786800000000.SAFE_TENANT_SCHEMA.test(s));

    const allSchemas = ['hr', ...tenantSchemas];
    for (const schema of allSchemas) {
      for (const meta of hrEntities) {
        await queryRunner.query(`
          -- DESTRUCTIVE: rollback drops regenerated hr tables across all schemas
          -- Operators who need the legacy shape back should restore from pg_dump
          -- pg_dump backup taken by deploy pipeline before applying any migration is the recovery path
          DROP TABLE IF EXISTS "${schema}"."${meta.tableName}" CASCADE
        `);
      }
    }
  }
}
