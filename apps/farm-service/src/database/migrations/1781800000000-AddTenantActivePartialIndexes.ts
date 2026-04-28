import { MigrationInterface, QueryRunner } from 'typeorm';
import { MigrationLogger } from '@aquaculture/backend-common/database';

/**
 * AddTenantActivePartialIndexes1781800000000
 * ============================================================================
 *
 * Installs partial B-tree indexes of the form
 * `(tenant_id) WHERE is_deleted = false` on every farm schema table
 * that extends `BaseEntity` (i.e. has both `tenant_id` and `is_deleted`
 * columns).
 *
 * # Why
 *
 * Almost every read path in farm-service filters by a pair that the
 * schema already models as standard columns:
 *
 *     WHERE "tenant_id" = $1 AND "is_deleted" = false
 *
 * This pair is the single most common predicate across all
 * getScopedRepository() queries, TypeORM findMany, and CQRS query
 * handlers. The current index layout created by BaseEntity's
 * `@Index()` decorators gives PostgreSQL two separate choices:
 *
 *   1. `(tenant_id)` — a full B-tree on the tenant column. Includes
 *       deleted rows, which means the planner reads entries that will
 *       be filtered out after a heap fetch.
 *   2. `(is_deleted)` — a boolean B-tree. ~99% of rows match
 *       `is_deleted = false`, so this index is effectively worthless:
 *       its selectivity is near zero and the planner rarely picks it.
 *
 * The planner usually picks (1) and heap-filters by `is_deleted` per
 * row. That wastes the dead-row reads AND leaves cold pages in the
 * buffer pool.
 *
 * A **partial** composite index:
 *
 *     CREATE INDEX idx_<table>_tenant_active
 *     ON <table> (tenant_id)
 *     WHERE is_deleted = false;
 *
 * is the shape the query actually wants:
 *
 *   - Contains only live rows → smaller index, fewer pages, higher
 *     buffer-pool hit rate.
 *   - Lets the planner satisfy the full WHERE clause from the index
 *     alone, no heap post-filter needed for the is_deleted check.
 *   - Write overhead is concentrated on inserts/updates of non-deleted
 *     rows (the common case), not every write.
 *
 * On the query mix we care about — "list active records for tenant" —
 * this moves from O(log n_total) + per-row heap filter to
 * O(log n_active) with no filter. Measurable at any table size above a
 * few thousand rows; significant on the hot tables (batches,
 * mortality_records, feeding_records, growth_measurements).
 *
 * # Why additive (not replacing existing indexes)
 *
 * The existing `@Index()` on `tenant_id` is NOT dropped. It still
 * serves queries that legitimately need to see deleted rows — admin
 * tooling for restore, audit trails, data export, the
 * `restore()` path in `BaseEntity` itself. Dropping it would regress
 * those code paths. The cost of keeping both is ~one extra small
 * index per table, which is cheap; the cost of regressing
 * administrative query paths is not.
 *
 * Similarly the existing `@Index()` on `is_deleted` stays — it's
 * nearly useless in isolation but its removal would violate the
 * principle that schema migrations are additive unless the old
 * definition is actively wrong.
 *
 * # Discovery
 *
 * We do not hard-code the table list. The migration introspects
 * `information_schema.columns` to find every base table that has
 * BOTH a `tenant_id` column AND an `is_deleted` column, then
 * installs the partial index on each. This way:
 *
 *   1. Future tables that extend `BaseEntity` automatically get the
 *      index on the next deploy — no per-table migration bookkeeping.
 *   2. Tables that don't extend BaseEntity (audit_logs, outbox,
 *      lookup tables) are automatically skipped.
 *
 * The canonical index name `idx_<table>_tenant_active` is derived
 * from the table name and enforced as the identifier across both
 * up() and down(), so idempotency is guaranteed.
 *
 * # Schema iteration (schema-per-tenant)
 *
 * farm-service is schema-per-tenant: every tenant has its own
 * `tenant_<uuid>` schema containing a copy of the farm tables. A
 * migration that creates an index in the source schema only
 * (`farm`) does NOT propagate to existing tenant schemas because
 * the per-tenant tables were copied via `CREATE TABLE LIKE
 * ... INCLUDING INDEXES` at provision time, not linked.
 *
 * Same pattern as ConvertMessagingOutboxToIdentity1781200000000 and
 * AddCompositeFkIndexesOnMessageChildren1781600000000: iterate every
 * schema that contains the target shape and install the index in
 * each. Sub-millisecond per index per table; cumulative cost scales
 * linearly with tenants × tables.
 *
 * # Exclusion list
 *
 * `farm_outbox` and `audit_logs` are deliberately excluded from the
 * RLS foundation (see RefreshTenantRlsPredicate1781000000000) because
 * they're read cross-tenant by infrastructure workers. Neither has
 * both `tenant_id` AND `is_deleted` in a BaseEntity-shaped sense, but
 * we add them to the explicit exclude list for documentation — so a
 * future reader understands they were considered and rejected.
 */
export class AddTenantActivePartialIndexes1781800000000
  implements MigrationInterface
{
  name = 'AddTenantActivePartialIndexes1781800000000';
  private readonly logger = new MigrationLogger(this.name);

  /** Tables to NEVER index, even if they match the shape. */
  private readonly excludedTables = new Set<string>([
    'farm_outbox',
    'audit_logs',
    'audit_log',
    'migrations', // TypeORM internal
    'typeorm_metadata', // TypeORM internal
  ]);

  public async up(queryRunner: QueryRunner): Promise<void> {
    this.logger.log(
      'Installing (tenant_id) WHERE is_deleted = false partial indexes on farm schema tables',
    );

    const schemas = await this.discoverSchemasWithFarmShape(queryRunner);

    if (schemas.length === 0) {
      this.logger.warn(
        'No schemas with BaseEntity-shaped tables found — nothing to index.',
      );
      return;
    }

    this.logger.log(
      `Found ${schemas.length} schemas with farm tables: ${schemas.join(', ')}`,
    );

    let totalCreated = 0;

    for (const schema of schemas) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
        this.logger.warn(`Skipping invalid schema name: "${schema}"`);
        continue;
      }

      // Per-schema discovery of qualifying tables — a tenant provisioned
      // from an older template might have a subset of tables.
      const tables = await this.discoverBaseEntityTables(queryRunner, schema);

      for (const table of tables) {
        if (this.excludedTables.has(table)) {
          continue;
        }

        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
          this.logger.warn(`[${schema}] skipping invalid table name: "${table}"`);
          continue;
        }

        const indexName = `idx_${table}_tenant_active`;

        // Partial B-tree index. `tenant_id` as leading column because
        // every read path scopes by tenant first; `is_deleted = false`
        // predicate as the partial clause because that's the dominant
        // filter AND the column's selectivity is tiny (soft-deletes
        // are rare).
        //
        // The index is quoted with the schema prefix so it lives in the
        // same schema as the table — critical for schema-per-tenant
        // correctness (an unqualified CREATE INDEX would resolve
        // against search_path and could land on the wrong schema under
        // concurrent migration execution).
        await queryRunner.query(`
          CREATE INDEX IF NOT EXISTS "${indexName}"
          ON "${schema}"."${table}" ("tenant_id")
          WHERE "is_deleted" = false
        `);

        totalCreated++;
      }

      this.logger.log(
        `[${schema}] processed ${tables.length} candidate tables`,
      );
    }

    this.logger.log(
      `Partial index installation complete: ${totalCreated} indexes across ${schemas.length} schemas`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    this.logger.warn(
      'Dropping (tenant_id) WHERE is_deleted = false partial indexes. ' +
        'Active-record queries will fall back to the full (tenant_id) ' +
        'index with per-row heap filter on is_deleted — measurably slower.',
    );

    const schemas = await this.discoverSchemasWithFarmShape(queryRunner);

    for (const schema of schemas) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) continue;

      const tables = await this.discoverBaseEntityTables(queryRunner, schema);

      for (const table of tables) {
        if (this.excludedTables.has(table)) continue;
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) continue;

        const indexName = `idx_${table}_tenant_active`;
        await queryRunner.query(
          `DROP INDEX IF EXISTS "${schema}"."${indexName}"`,
        );
      }
    }

    this.logger.warn('Rollback complete');
  }

  /**
   * Find every schema that contains at least one base table with BOTH
   * `tenant_id` AND `is_deleted` columns. This is the correct set of
   * schemas to iterate because:
   *
   *   - The `farm` source schema qualifies (its tables are templates
   *     for tenant schemas).
   *   - Each provisioned `tenant_<uuid>` schema qualifies (its tables
   *     are copies of the source).
   *   - Other service schemas (`auth`, `billing`, `messaging`, ...)
   *     do NOT qualify because their tables don't use the
   *     farm BaseEntity shape.
   *
   * The DISTINCT ensures a schema appears exactly once even though it
   * contains many qualifying tables.
   */
  private async discoverSchemasWithFarmShape(
    queryRunner: QueryRunner,
  ): Promise<string[]> {
    const rows: Array<{ table_schema: string }> = await queryRunner.query(`
      SELECT DISTINCT c1.table_schema
      FROM information_schema.columns c1
      JOIN information_schema.columns c2
        ON c1.table_schema = c2.table_schema
       AND c1.table_name = c2.table_name
      JOIN information_schema.tables t
        ON t.table_schema = c1.table_schema
       AND t.table_name = c1.table_name
       AND t.table_type = 'BASE TABLE'
      WHERE c1.column_name = 'tenant_id'
        AND c2.column_name = 'is_deleted'
      ORDER BY c1.table_schema
    `);
    return rows.map((r) => r.table_schema);
  }

  /**
   * Within a given schema, find every base table that has BOTH
   * `tenant_id` and `is_deleted` columns. These are the candidate
   * tables for the partial index.
   */
  private async discoverBaseEntityTables(
    queryRunner: QueryRunner,
    schema: string,
  ): Promise<string[]> {
    const rows: Array<{ table_name: string }> = await queryRunner.query(
      `
      SELECT c1.table_name
      FROM information_schema.columns c1
      JOIN information_schema.columns c2
        ON c1.table_schema = c2.table_schema
       AND c1.table_name = c2.table_name
      JOIN information_schema.tables t
        ON t.table_schema = c1.table_schema
       AND t.table_name = c1.table_name
       AND t.table_type = 'BASE TABLE'
      WHERE c1.table_schema = $1
        AND c1.column_name = 'tenant_id'
        AND c2.column_name = 'is_deleted'
      ORDER BY c1.table_name
      `,
      [schema],
    );
    return rows.map((r) => r.table_name);
  }
}
