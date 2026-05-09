import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';
import type { ColumnMetadata } from 'typeorm/metadata/ColumnMetadata';
import { dropDependentPartialIndexes, parseAlterColumnTypeTargets } from '@aquaculture/backend-common/database';

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
      // Fresh-DB-after-Wave-1-baseline detection.
      //
      // Two W4-A2 changes converge here:
      //   (a) D1: hr-service tenant-scoped entities had `schema: 'hr'`
      //       removed (Farm-pattern; tenant_<uuid> search_path routing).
      //       Only `hr_outbox` and `payroll_audit` retain the explicit
      //       schema. So `m.schema === 'hr'` matches at most 2 entities,
      //       and zero when the metadata loader has not run at all.
      //   (b) D2: the new pre-baseline migration
      //       1735900000000-CreateHrEmployeesBaseline creates the canonical
      //       `hr.employees` shape directly. Followed by 1736000000000-
      //       CreateHRModuleSchema which creates the rest of the hr
      //       tables. The baseline path ends with the schema in the same
      //       shape this migration's RdbmsSchemaBuilder reconciliation
      //       was historically required to produce on legacy droplets
      //       — there is no drift to reconcile on a fresh DB.
      //
      // If hr.employees exists, the baseline path produced the schema and
      // this migration is logically redundant. The bootstrap-from-scratch
      // test invokes `ds.runMigrations()` without entity registration
      // (matches this branch); the production aqua-db-migrate orchestrator
      // declares entitiesGlob for the hr slot and so does NOT enter this
      // branch — it loads entities and the historical reconciliation runs
      // as designed.
      const baselineMarkerRows: Array<{ exists: boolean }> = await queryRunner.query(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
           WHERE table_schema = 'hr' AND table_name = 'employees'
        ) AS exists`,
      );
      if (baselineMarkerRows[0]?.exists === true) {
        this.logger.log(
          'SyncHrEntitiesToDb: hr.employees exists (Wave 1 baseline applied) ' +
            'and zero hr-scoped entities loaded into connection.entityMetadatas — ' +
            'fresh-DB bootstrap path, no drift to reconcile, no-op.',
        );
        return;
      }

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

    // 1b. Build a registry of entity-declared column defaults, keyed by
    //     `<tableName>.<databaseColumnName>`. The DDL transform in step
    //     6c consults this map when rewriting `ALTER COLUMN ... TYPE`
    //     statements emitted by RdbmsSchemaBuilder.log().
    //
    //     Schema is NOT part of the key: every emitted ALTER targets the
    //     same table-column pair regardless of whether we are running on
    //     `"hr".` (source) or `"<tenant>".` (clone fan-out). Keying by
    //     table+column lets the same map serve both passes.
    const entityDefaultsByTableColumn: Map<string, string> = new Map();
    for (const meta of hrEntities) {
      for (const col of meta.columns) {
        const rendered = renderEntityDefaultLiteral(col);
        if (rendered !== undefined) {
          entityDefaultsByTableColumn.set(
            `${meta.tableName}.${col.databaseName}`,
            rendered,
          );
        }
      }
    }

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
      // ALTER TABLE … ALTER COLUMN … <any sub-action>
      //
      // Includes TYPE / SET NOT NULL (validator's direct concerns) AND
      // DROP DEFAULT / SET DEFAULT / DROP NOT NULL (supporting statements
      // log() emits as a sequence around TYPE changes).
      //
      // Why all sub-actions: log() emits the trio
      //   ALTER COLUMN x DROP DEFAULT
      //   ALTER COLUMN x TYPE … USING …
      //   ALTER COLUMN x SET DEFAULT …
      // when changing a column's type if the column has a default.
      // Filtering DROP DEFAULT out leaves PG trying to auto-cast the
      // OLD default to the NEW type, which fails for enum types
      // (deploy 6 failure mode 2026-04-20 17:50 UTC:
      //  "default for column status cannot be cast automatically to
      //   type training_enrollments_status_enum"). Keeping the whole
      // trio together lets PG drop, change, restore in proper order.
      //
      // ALTER COLUMN sub-actions are all narrow column-level operations
      // that touch only the named column; they cannot conflict with
      // PRIMARY KEY, UNIQUE, FOREIGN KEY, or CHECK constraints (those
      // are table-level objects, not column attributes). DROP NOT NULL
      // is also safe — the validator only flags NOT-NULL-declared-but-
      // DB-nullable mismatches; relaxing nullability does not violate
      // its check surface.
      if (/^ALTER\s+TABLE\b[^;]*?\bALTER\s+COLUMN\b/i.test(t)) return true;
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

    // 6c. ALTER COLUMN TYPE default-recovery transform.
    //
    //    WHY: TypeORM's RdbmsSchemaBuilder.log() does NOT emit
    //    `ALTER COLUMN ... DROP DEFAULT` before `ALTER COLUMN ... TYPE`
    //    when the LIVE DB column carries a default literal whose text
    //    cannot be auto-cast to the new declared type. Concrete failure
    //    mode (deploy 8, 2026-04-21 09:14 UTC):
    //
    //      ALTER TABLE "hr"."certification_types"
    //        ALTER COLUMN "category" TYPE "hr"."certification_types_category_enum"
    //          USING "category"::"hr"."certification_types_category_enum"
    //      → "default for column 'category' cannot be cast automatically
    //         to type certification_types_category_enum"
    //
    //    WHAT: 3-step DDL transform. For every emitted single-statement
    //    `ALTER TABLE "hr"."<table>" ALTER COLUMN "<col>" TYPE <newtype>`,
    //    rewrite into the canonical PG-safe sequence:
    //
    //      (a) ALTER TABLE "hr"."<table>" ALTER COLUMN "<col>" DROP DEFAULT
    //      (b) The original ALTER TABLE ... ALTER COLUMN ... TYPE statement
    //      (c) ALTER TABLE "hr"."<table>" ALTER COLUMN "<col>" SET DEFAULT
    //          <entity-declared-default> — only when entity declares one.
    //
    //    Idempotency under retry: pass 1 succeeds a/b/c; pass 2 finds
    //    no ALTER TYPE for already-aligned columns → transform produces
    //    nothing.
    const expandAlterColumnTypeWithDefaultRecovery = (q: {
      query: string;
      parameters?: unknown[];
    }): Array<{ query: string; parameters?: unknown[] }> => {
      const m = q.query.match(
        /^ALTER\s+TABLE\s+"([^"]+)"\."([^"]+)"\s+ALTER\s+COLUMN\s+"([^"]+)"\s+TYPE\b/i,
      );
      if (!m) return [{ query: q.query, parameters: q.parameters }];

      const schemaName = m[1];
      const tableName = m[2];
      const columnName = m[3];

      const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
      if (
        !SAFE_IDENT.test(schemaName) ||
        !SAFE_IDENT.test(tableName) ||
        !SAFE_IDENT.test(columnName)
      ) {
        return [{ query: q.query, parameters: q.parameters }];
      }

      const dropDefaultStmt =
        `ALTER TABLE "${schemaName}"."${tableName}" ALTER COLUMN "${columnName}" DROP DEFAULT`;
      const out: Array<{ query: string; parameters?: unknown[] }> = [
        { query: dropDefaultStmt, parameters: undefined },
        { query: q.query, parameters: q.parameters },
      ];
      const declared = entityDefaultsByTableColumn.get(`${tableName}.${columnName}`);
      if (declared !== undefined) {
        out.push({
          query:
            `ALTER TABLE "${schemaName}"."${tableName}" ALTER COLUMN "${columnName}" ` +
            `SET DEFAULT ${declared}`,
          parameters: undefined,
        });
      }
      return out;
    };

    const filteredQueries = hrUpQueries
      .filter((q) => isValidatorRelevant(q.query))
      .map((q) => ({ ...q, query: makeIdempotent(q.query) }));
    const relevantQueries = filteredQueries.flatMap((q) =>
      expandAlterColumnTypeWithDefaultRecovery(q),
    );
    const skippedNonValidator = hrUpQueries.length - filteredQueries.length;
    const expansionDelta = relevantQueries.length - filteredQueries.length;

    this.logger.log(
      `RdbmsSchemaBuilder emitted ${allUpQueries.length} queries; ` +
        `${hrUpQueries.length} target hr schema; ` +
        `${filteredQueries.length} are validator-relevant ` +
        `(${skippedNonValidator} non-validator-relevant skipped: constraints/indexes/comments/drops); ` +
        `${allUpQueries.length - hrUpQueries.length} foreign-schema skipped; ` +
        `${expansionDelta} additional DROP/SET DEFAULT statement(s) injected by ALTER-COLUMN-TYPE ` +
        `default-recovery transform.`,
    );

    if (relevantQueries.length === 0) {
      this.logger.warn(
        'No validator-relevant hr-scoped queries to apply — schema already covers all entity-declared columns. Migration is a no-op.',
      );
      return;
    }

    // 7. Pre-flight: DROP partial indexes whose WHERE predicate would
    //    block any `ALTER COLUMN TYPE` statement in `relevantQueries`.
    //
    //    Concrete failure mode this fix solves (deploy 7, 2026-04-20 18:11):
    //
    //      ALTER TABLE hr.employee_certifications ALTER COLUMN status
    //      TYPE hr.employee_certifications_status_enum USING …
    //      → "operator does not exist:
    //         employee_certifications_status_enum = certification_status"
    //
    //    Root cause: partial index `IDX_emp_cert_expiry` declared
    //    `WHERE (status = 'active'::hr.certification_status)`. PG re-
    //    validates the WHERE expression against the NEW enum during
    //    ALTER COLUMN TYPE; the new-enum = old-enum equality operator
    //    does not exist, so the ALTER aborts. `RdbmsSchemaBuilder.log()`
    //    cannot emit a preceding DROP INDEX because the index is a
    //    legacy artefact not declared by the current entity model.
    //
    //    `dropDependentPartialIndexes` closes the gap deterministically:
    //    parse every `ALTER COLUMN TYPE` target the migration will run,
    //    query pg_indexes for partial indexes whose predicate references
    //    the target column, DROP each one explicitly. After the migration
    //    body runs, any index the entity model currently declares is
    //    re-created by TypeORM's own CREATE INDEX emissions. Legacy
    //    indexes the entity does not declare stay dropped — correct
    //    end-state under the entity-first schema contract (ADR-012).
    //
    //    This replaces the SAVEPOINT-per-statement band-aid introduced
    //    in 5df00179. That band-aid shifted the failure from db-migrate
    //    to the SchemaDriftValidator boot signal (new enum never applied,
    //    drift persisted, `Schema drift scan clean` never emitted, deploy
    //    rolled back after 7.5 min). With pre-flight DROP the ALTER runs
    //    deterministically and the apply loop no longer needs to tolerate
    //    skipped statements.
    const alterTypeTargets = parseAlterColumnTypeTargets(
      relevantQueries.map((q) => q.query),
    );
    if (alterTypeTargets.length > 0) {
      const droppedDeps = await dropDependentPartialIndexes(
        queryRunner,
        alterTypeTargets,
      );
      this.logger.log(
        `Source hr schema: pre-flight DROP of ${droppedDeps.length} ` +
          `dependent object(s) on ${alterTypeTargets.length} ALTER-COLUMN-TYPE target(s). ` +
          (droppedDeps.length > 0
            ? `Dropped: ${droppedDeps
                .map(
                  (d) =>
                    `${d.kind}:${d.schema}.${d.name} (blocking ${d.table}.${d.column})`,
                )
                .join(', ')}.`
            : 'No blocking partial indexes, constraint-backed indexes, or CHECK constraints present.'),
      );
    }

    // 8. Apply validator-relevant hr-scoped queries to source hr schema.
    //
    //    Deterministic now — with blocking partial indexes DROPped in
    //    step 7 there is no expected failure surface. Any exception that
    //    escapes this loop propagates to the orchestrator and rolls back
    //    the enclosing migration transaction (which is what we want: a
    //    real failure should be visible in the deploy log, not silently
    //    swallowed by a SAVEPOINT rollback).
    for (const q of relevantQueries) {
      this.logger.debug(`[hr] ${q.query.slice(0, 120).replace(/\s+/g, ' ')}`);
      await queryRunner.query(q.query, q.parameters as unknown[] | undefined);
    }
    this.logger.log(
      `Source hr schema: applied ${relevantQueries.length} validator-relevant catch-up queries.`,
    );

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

      // Rewrite `"hr".` → `"${tenantSchema}".` once per query so the
      // pre-flight DROP and the apply loop see the same schema-rebased
      // text. The regex is anchored on the quoted form TypeORM always
      // emits so we don't accidentally rewrite occurrences of the
      // substring `hr` inside column names or comments.
      const tenantQueries = relevantQueries.map((q) => ({
        query: q.query.replace(/"hr"\./g, `"${tenantSchema}".`),
        parameters: q.parameters,
      }));

      // Pre-flight DROP against the tenant schema — tenant clones
      // inherited the legacy partial indexes when the hr source schema
      // was propagated at tenant onboarding, so each clone needs the
      // same dependency resolution.
      const tenantAlterTargets = parseAlterColumnTypeTargets(
        tenantQueries.map((q) => q.query),
      );
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

      // Deterministic apply — pre-flight resolved every known blocker.
      // Any exception here surfaces to the orchestrator and rolls back
      // the migration transaction. No silent SAVEPOINT swallowing.
      for (const q of tenantQueries) {
        await queryRunner.query(q.query, q.parameters as unknown[] | undefined);
      }
      this.logger.log(
        `[${tenantSchema}] applied ${tenantQueries.length} validator-relevant catch-up queries.`,
      );
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

/**
 * Render a TypeORM entity column's `default` declaration as a literal
 * suitable for `SET DEFAULT <literal>` interpolation in DDL.
 *
 * Used by SyncHrEntitiesToDb's step 6c default-recovery transform to
 * restore a column's default after `ALTER COLUMN ... TYPE` (PG's
 * cast-validates the OLD default against the NEW type before applying
 * the ALTER body, so the trio DROP DEFAULT / ALTER TYPE / SET DEFAULT
 * is required when the entity declares a default).
 *
 * Returns `undefined` when the entity does NOT declare a default —
 * caller skips the SET DEFAULT step. SQL-injection surface is bounded
 * to whatever the entity author wrote inside `@Column({ default: ... })`,
 * which is source-controlled.
 */
function renderEntityDefaultLiteral(col: ColumnMetadata): string | undefined {
  const d = col.default;
  if (d === undefined) return undefined;
  if (d === null) return 'NULL';
  if (typeof d === 'function') {
    // TypeORM stores function defaults as `() => 'CURRENT_TIMESTAMP'`
    // — invoke once and pass the returned text through verbatim.
    const result = d();
    return typeof result === 'string' && result.length > 0 ? result : undefined;
  }
  if (typeof d === 'string') {
    return `'${d.replace(/'/g, "''")}'`;
  }
  if (typeof d === 'number' || typeof d === 'boolean') {
    return String(d);
  }
  if (Array.isArray(d)) {
    const items = d.map((v) =>
      typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v),
    );
    return `ARRAY[${items.join(', ')}]`;
  }
  if (typeof d === 'object') {
    return `'${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  return undefined;
}
