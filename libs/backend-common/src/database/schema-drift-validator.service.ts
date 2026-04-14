import { Injectable, Logger, OnApplicationBootstrap, Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityMetadata } from 'typeorm';

/**
 * createSchemaDriftValidator
 * ============================================================================
 *
 * Factory that produces an OnApplicationBootstrap NestJS provider which
 * compares each entity's declared metadata against the live
 * information_schema and fails boot (configurable) on any of:
 *
 *   1. Entity declares `schema: X` but the table physically lives in a
 *      different schema.
 *   2. Entity declares `@Column({ type: 'uuid' })` but the DB column
 *      has a non-uuid type (text / character varying are the common
 *      failure modes — both of these broke RLS on 2026-04-14 with
 *      `operator does not exist: text = uuid`).
 *   3. Entity declares `nullable: false` on a column that is actually
 *      nullable in the DB (a silent-null risk — foreign keys + ORM
 *      enforcement diverge).
 *
 * # Why a factory
 *
 * Same rationale as createMigrationRunnerService (see docblock there).
 * Each service wires the validator with its own service name label for
 * log readability.
 *
 * # Configuration
 *
 *   SCHEMA_DRIFT_FATAL=true   → fail service boot on any drift
 *                               (recommended for staging and production
 *                               once the validator is rolled out;
 *                               catches regressions fast)
 *   SCHEMA_DRIFT_FATAL=false  → log CRITICAL but continue
 *                               (recommended for initial rollout + dev
 *                               environments where occasional drift is
 *                               expected during development)
 *   SCHEMA_DRIFT_ENABLED=false → skip the validator entirely
 *                               (emergency kill switch)
 *
 * Defaults: enabled=true, fatal=false. Flip fatal to true via env var
 * after one deploy cycle of observation.
 *
 * # What it does NOT check
 *
 * - Index presence / shape (too noisy; TypeORM generates index names
 *   inconsistently across versions).
 * - Constraint definitions (CHECK, UNIQUE — same noise concern).
 * - Default values (sometimes declared on the app side, sometimes DB).
 *
 * These are fair game for future extension but intentionally out of
 * scope for the initial rollout: we want HIGH-signal checks that never
 * produce a false positive. The three checks above were the ones that
 * caused actual production incidents in 2026-04.
 *
 * @param serviceName Lowercase label for log prefix (e.g. 'billing').
 * @returns An OnApplicationBootstrap provider class.
 */
export function createSchemaDriftValidator(
  serviceName: string,
): Type<OnApplicationBootstrap> {
  @Injectable()
  class SchemaDriftValidator implements OnApplicationBootstrap {
    private readonly logger = new Logger(
      `SchemaDriftValidator[${serviceName}]`,
    );

    constructor(
      private readonly dataSource: DataSource,
      private readonly configService: ConfigService,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
      const enabled =
        this.configService.get('SCHEMA_DRIFT_ENABLED', 'true') === 'true';
      if (!enabled) {
        this.logger.warn(
          'Schema drift validator disabled via SCHEMA_DRIFT_ENABLED=false',
        );
        return;
      }

      const fatal =
        this.configService.get('SCHEMA_DRIFT_FATAL', 'false') === 'true';

      this.logger.log('Scanning entity metadata for schema drift...');
      const violations: string[] = [];

      for (const entity of this.dataSource.entityMetadatas) {
        await this.validateEntity(entity, violations);
      }

      if (violations.length === 0) {
        this.logger.log(
          `Schema drift scan clean: checked ${this.dataSource.entityMetadatas.length} entities`,
        );
        return;
      }

      // SECURITY-OPS: this is the alerting hook. The literal substring
      // "schema.drift.detected" should be matched in log dashboards /
      // alert rules so operators are paged when an entity drifts.
      this.logger.error(
        `schema.drift.detected service="${serviceName}" — ${violations.length} violation(s):\n  ${violations.join('\n  ')}`,
      );

      if (fatal) {
        throw new Error(
          `Schema drift detected in ${violations.length} place(s). ` +
            `Set SCHEMA_DRIFT_FATAL=false to start the service anyway, but ` +
            `the drift must be fixed — either via a migration that aligns the ` +
            `DB to the entity, or by reverting the entity change if it was ` +
            `premature. First violation: ${violations[0]}`,
        );
      }
    }

    /**
     * Query information_schema for the entity's table, then cross-check
     * schema location + column types + nullability.
     */
    private async validateEntity(
      entity: EntityMetadata,
      violations: string[],
    ): Promise<void> {
      const schema = entity.schema ?? 'public';
      const tableName = entity.tableName;

      // Existence + schema check.
      //
      // Filter out per-tenant schemas (`tenant_<uuid>`) — those are
      // CREATE TABLE LIKE replicas of source tables and would produce
      // false positives if `LIMIT 1` happened to land on one. Quoting
      // ADR-012: "schema-per-tenant services declare NO `schema:` option
      // on tenant entities; the validator queries the source schema, which
      // has the canonical table." A query against pg_tables without this
      // filter would arbitrarily return ANY schema's match.
      //
      // Replaced LIMIT 1 with explicit schema filtering: the entity's
      // declared schema is the only candidate we consider.
      const tableRows: Array<{ schemaname: string }> = await this.dataSource
        .query(
          `SELECT schemaname FROM pg_tables
           WHERE tablename = $1
             AND schemaname NOT LIKE 'tenant\\_%' ESCAPE '\\'
             AND schemaname NOT IN ('pg_catalog', 'information_schema')
           ORDER BY (schemaname = $2) DESC, schemaname
           LIMIT 1`,
          [tableName, schema],
        );
      const [firstRow] = tableRows;
      if (!firstRow) {
        // Table doesn't exist in any non-tenant schema — NOT a drift from
        // this validator's perspective (could be a synchronize-yet-to-run
        // state, or a source table that's only replicated to tenant_*
        // schemas at provision time). Skip.
        return;
      }
      if (firstRow.schemaname !== schema) {
        violations.push(
          `[${tableName}] entity declares schema='${schema}' but table lives in '${firstRow.schemaname}'`,
        );
        return;
      }

      // Column type + nullability check.
      const columnRows: Array<{
        column_name: string;
        data_type: string;
        is_nullable: string;
      }> = await this.dataSource.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [schema, tableName],
      );
      const columns = new Map(columnRows.map((r) => [r.column_name, r]));

      for (const column of entity.columns) {
        const dbName = column.databaseName;
        const dbColumn = columns.get(dbName);
        if (!dbColumn) {
          // Entity declares a column the DB lacks. Closes NEW-HIGH-D from
          // the round-2 review: previously the validator silently skipped
          // this case ("new entity column, not yet migrated"), which
          // hid the column-shape mismatch failure mode that broke
          // shared.audit_logs writes (NEW-CRITICAL-A). The skip was
          // wrong-by-construction — if the entity declares a column,
          // every INSERT/SELECT against that column crashes today, NOT
          // "after migration". Operators in a genuine mid-migration
          // window can suppress via SCHEMA_DRIFT_FATAL=false (default).
          violations.push(
            `[${schema}.${tableName}.${dbName}] entity declares column but DB has no such column`,
          );
          continue;
        }

        // Declared-type check for the high-signal uuid case. TypeORM's
        // type field can be many things (string identifier, ctor, object)
        // so we pattern-match on the identifier form only.
        const entityType = typeof column.type === 'string' ? column.type : '';
        if (entityType === 'uuid') {
          if (dbColumn.data_type !== 'uuid') {
            violations.push(
              `[${schema}.${tableName}.${dbName}] entity declares uuid but DB is ${dbColumn.data_type}`,
            );
          }
        }

        // Nullability — entity says NOT NULL but DB says YES → latent
        // null risk. The reverse (DB says NOT NULL, entity says nullable)
        // is safe (no runtime error possible), so skip that direction.
        if (!column.isNullable && dbColumn.is_nullable === 'YES') {
          violations.push(
            `[${schema}.${tableName}.${dbName}] entity declares NOT NULL but DB column is nullable`,
          );
        }
      }
    }
  }

  return SchemaDriftValidator;
}
