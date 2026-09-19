import { assertSafeSchemaName } from '@aquaculture/backend-common/database';
import { Logger } from '@nestjs/common';
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * GIN expression index for message full-text search (MSGFIX-FAZ3 Görev 1 / 3.4).
 *
 * # Why this exists
 *
 * `search-messages.handler.ts` filters with
 * `to_tsvector('english', m."content") @@ plainto_tsquery('english', :q)` and
 * ranks with `ts_rank(to_tsvector('english', m."content"), ...)`. The tsvector
 * is recomputed for EVERY row of every candidate partition — a sequential scan
 * with a per-row parse. `to_tsvector(regconfig, text)` is IMMUTABLE (verified
 * on the live catalog: pg_proc.provolatile = 'i' for the 2-arg form — the
 * 1-arg form is only STABLE because it depends on default_text_search_config),
 * so the expression is indexable. The index expression below is written as
 * `to_tsvector('english'::regconfig, "content")` — the same parse tree the
 * query's `to_tsvector('english', m."content")` produces after the untyped
 * literal is coerced to regconfig — so the planner matches the index.
 *
 * # Partition-aware shape (messages is `PARTITION BY RANGE ("createdAt")`)
 *
 * `CREATE INDEX CONCURRENTLY` is FORBIDDEN on a partitioned parent, so the
 * migration builds the index in the canonical three steps:
 *
 *   1. `CREATE INDEX CONCURRENTLY IF NOT EXISTS` on EVERY existing partition
 *      (each statement is its own autocommit query — CONCURRENTLY cannot run
 *      inside a transaction block).
 *   2. `CREATE INDEX IF NOT EXISTS ... ON ONLY <parent>` — a catalog-only
 *      stub that is created INVALID and holds no storage.
 *   3. `ALTER INDEX <parent-index> ATTACH PARTITION <partition-index>` for
 *      each partition index. When the last partition index is attached,
 *      PostgreSQL flips the partitioned index VALID automatically.
 *
 * WHY THE PARTITIONED PARENT INDEX AT ALL: once `idx_messages_content_fts`
 * exists on the parent, every partition the PartitionManagerService creates
 * LATER automatically gets a matching index created (and attached) by
 * PostgreSQL — future monthly partitions are covered with zero code. The
 * per-partition indexes use the `<partition>_content_fts_idx` naming scheme
 * (mirrors the auto-generated `messages_2026_09_tenantId_idx` pattern; index
 * names are schema-scoped so they cannot all share the parent's name).
 *
 * # Tenant fan-out
 *
 * The migration runner fans this migration out to the `messaging` SOURCE
 * schema AND every provisioned `tenant_<16hex>` schema, pinning search_path
 * per schema (same contract as archived 1782800000000-AddMessageAttachment-
 * IsDeletedIndex). The body therefore operates on the CURRENT schema only
 * (`current_schema()`), re-validated through `assertSafeSchemaName` before
 * any identifier interpolation. Current fan-out cost is tiny: 1 tenant
 * schema + source, 7 monthly partitions each, single-digit rows per
 * partition (~112 kB) — every CONCURRENTLY build is sub-second.
 *
 * # transaction = false (load-bearing)
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block. Both
 * platform runners honour the per-migration `transaction = false` opt-out
 * and run `up()` WITHOUT the per-migration transaction wrapper: the
 * production authority (aqua-db-migrate orchestrator, ORPHAN-CRITICAL-058
 * fix in apps/db-migrate/src/migration-orchestrator.ts) and the in-process
 * runner (libs/backend-common migration-runner.service.ts, dev / E2E when
 * DB_MIGRATE_AUTHORITATIVE is unset — it had wrapped unconditionally until
 * this migration met the E2E harness's three bootstrap partitions). The
 * guard in `up()` stays as the fail-fast for any caller that ignores the
 * opt-out: with partitions present a wrapper transaction can only mean the
 * runner contract was broken, and the message names it.
 *
 * Idempotency: partition builds use IF NOT EXISTS + a self-healing drop of
 * partially-built INVALID indexes (a crashed CONCURRENTLY build leaves an
 * INVALID index that IF NOT EXISTS would happily skip forever); the parent
 * stub uses IF NOT EXISTS; ATTACHs are skipped for already-attached
 * partition indexes (checked via pg_inherits).
 */
export class AddMessagesContentSearchGinIndex1802300000000 implements MigrationInterface {
  name = 'AddMessagesContentSearchGinIndex1802300000000';

  /**
   * CONCURRENTLY cannot run inside BEGIN...COMMIT. db-migrate (the
   * production authority) honors this opt-out and skips the per-migration
   * transaction wrapper (ORPHAN-CRITICAL-058 contract).
   */
  transaction = false;

  private readonly logger = new Logger(AddMessagesContentSearchGinIndex1802300000000.name);

  /** Partitioned parent index name (schema-scoped). */
  private static readonly PARENT_INDEX = 'idx_messages_content_fts';
  /** Per-partition index name template: `<partition>_content_fts_idx`. */
  private static readonly PARTITION_INDEX_SUFFIX = '_content_fts_idx';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);
    assertSafeSchemaName(schema);

    const partitions = await this.listPartitions(queryRunner, schema);
    this.logger.log(
      `Adding messages content-search GIN index in schema "${schema}" ` +
        `(${partitions.length} partition(s))`,
    );

    // Runner-contract guard: with partitions present we MUST run CONCURRENTLY,
    // which requires no active transaction. Every platform runner honours
    // `transaction = false`; an open transaction here means the caller did not.
    if (partitions.length > 0 && queryRunner.isTransactionActive) {
      throw new Error(
        `AddMessagesContentSearchGinIndex1802300000000 cannot build partition indexes ` +
          `CONCURRENTLY inside an active transaction (schema "${schema}" has ` +
          `${partitions.length} partitions). The runner must honour this migration's ` +
          `transaction=false opt-out (ORPHAN-CRITICAL-058 contract: db-migrate orchestrator ` +
          `and the backend-common in-process runner both do).`,
      );
    }

    // 1. Per-partition CONCURRENTLY builds (a DB with zero partitions gets
    //    only the parent stub below; partitions created later inherit the
    //    index from it).
    for (const partition of partitions) {
      await this.healInvalidPartitionIndex(queryRunner, schema, partition);
      const indexName =
        partition + AddMessagesContentSearchGinIndex1802300000000.PARTITION_INDEX_SUFFIX;
      await queryRunner.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${indexName}" ` +
          `ON "${schema}"."${partition}" ` +
          `USING gin (to_tsvector('english'::regconfig, "content"))`,
      );
    }

    // 2. Partitioned parent stub — catalog-only, created INVALID, no storage.
    //    (IF NOT EXISTS satisfies the migration-sql-lint R3/R7 replay gate.)
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "${AddMessagesContentSearchGinIndex1802300000000.PARENT_INDEX}" ` +
        `ON ONLY "${schema}"."messages" ` +
        `USING gin (to_tsvector('english'::regconfig, "content"))`,
    );

    // 3. ATTACH every not-yet-attached partition index. Attaching all of them
    //    flips the parent VALID automatically; partitions created afterwards
    //    get + attach their own index without any migration.
    const attached = await this.listAttachedPartitionTables(queryRunner, schema);
    for (const partition of partitions) {
      if (attached.has(partition)) {
        continue;
      }
      const indexName =
        partition + AddMessagesContentSearchGinIndex1802300000000.PARTITION_INDEX_SUFFIX;
      await queryRunner.query(
        `ALTER INDEX "${schema}"."${AddMessagesContentSearchGinIndex1802300000000.PARENT_INDEX}" ` +
          `ATTACH PARTITION "${schema}"."${indexName}"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const schema = await this.currentSchema(queryRunner);
    assertSafeSchemaName(schema);

    // DELIBERATELY a plain DROP INDEX (not CONCURRENTLY): dropping the
    // partitioned parent cascades to every attached partition index in one
    // catalog operation. A concurrent drop cannot cascade across the
    // partition hierarchy. Rollback of a pure performance index is accepted
    // to run in a maintenance window (short ACCESS EXCLUSIVE; the index set
    // is small — see class docblock).
    await queryRunner.query(
      `DROP INDEX IF EXISTS "${schema}"."${AddMessagesContentSearchGinIndex1802300000000.PARENT_INDEX}"`,
    );

    // Safety net for orphans from a partially-failed up(): partition indexes
    // that exist but were never attached are not covered by the cascade.
    const partitions = await this.listPartitions(queryRunner, schema);
    for (const partition of partitions) {
      const indexName =
        partition + AddMessagesContentSearchGinIndex1802300000000.PARTITION_INDEX_SUFFIX;
      await queryRunner.query(`DROP INDEX IF EXISTS "${schema}"."${indexName}"`);
    }
  }

  /**
   * Assert the DDL really landed: the partitioned parent index exists, is
   * marked valid (all partition indexes attached), and carries the expected
   * expression. Runs per fanned-out schema via current_schema().
   */
  public async postCondition(queryRunner: QueryRunner, targetSchema?: string): Promise<boolean> {
    // The orchestrator passes the schema it is migrating (transaction=false
    // migrations run WITHOUT the search_path pin, so current_schema() is the
    // role default — the original probe validated the wrong namespace and
    // rolled back a DDL that had actually succeeded).
    let schema = targetSchema;
    if (typeof schema !== 'string') {
      const schemaRows: unknown = await queryRunner.query(`SELECT current_schema() AS schema`);
      const schemaRow = (Array.isArray(schemaRows) ? schemaRows[0] : undefined) as
        | { schema?: string | null }
        | undefined;
      schema = schemaRow?.schema ?? undefined;
    }
    if (typeof schema !== 'string') {
      return false;
    }

    const rows: unknown = await queryRunner.query(
      `SELECT i.indisvalid AS valid,
              pg_get_indexdef(i.indexrelid) AS def
         FROM pg_index i
         JOIN pg_class idx ON idx.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = idx.relnamespace
         JOIN pg_class tbl ON tbl.oid = i.indrelid
        WHERE n.nspname = $1
          AND idx.relname = $2
          AND tbl.relname = 'messages'`,
      [schema, AddMessagesContentSearchGinIndex1802300000000.PARENT_INDEX],
    );
    const row = (Array.isArray(rows) ? rows[0] : undefined) as
      | { valid?: boolean; def?: string | null }
      | undefined;
    if (!row || row.valid !== true || typeof row.def !== 'string') {
      return false;
    }
    return (
      row.def.includes('to_tsvector') &&
      row.def.includes('english') &&
      // pg_get_indexdef only quotes identifiers when necessary — the plain
      // lowercase `content` column renders UNQUOTED, so match it bare.
      row.def.includes('content')
    );
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async currentSchema(queryRunner: QueryRunner): Promise<string> {
    const rows: unknown = await queryRunner.query(`SELECT current_schema() AS schema`);
    const row = (Array.isArray(rows) ? rows[0] : undefined) as
      | { schema?: string | null }
      | undefined;
    const schema = row?.schema;
    if (typeof schema !== 'string' || schema.length === 0) {
      throw new Error(
        'AddMessagesContentSearchGinIndex1802300000000: could not resolve current_schema()',
      );
    }
    return schema;
  }

  /**
   * Physical partitions of messages in the target schema, via pg_inherits
   * (schema-qualified — immune to search_path accidents).
   */
  private async listPartitions(queryRunner: QueryRunner, schema: string): Promise<string[]> {
    const rows: unknown = await queryRunner.query(
      `SELECT child.relname AS partition_name
         FROM pg_inherits inh
         JOIN pg_class parent ON parent.oid = inh.inhparent
         JOIN pg_namespace pn ON pn.oid = parent.relnamespace
         JOIN pg_class child ON child.oid = inh.inhrelid
        WHERE pn.nspname = $1
          AND parent.relname = 'messages'
        ORDER BY child.relname`,
      [schema],
    );
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows
      .map((r) => (r as { partition_name?: unknown }).partition_name)
      .filter((name): name is string => typeof name === 'string');
  }

  /**
   * Partition TABLE names whose content-fts index is already attached to the
   * partitioned parent index (attached index-partitions appear in
   * pg_inherits with the PARENT INDEX as inhparent).
   */
  private async listAttachedPartitionTables(
    queryRunner: QueryRunner,
    schema: string,
  ): Promise<Set<string>> {
    const rows: unknown = await queryRunner.query(
      `SELECT tbl.relname AS partition_name
         FROM pg_inherits inh
         JOIN pg_class parentidx ON parentidx.oid = inh.inhparent
         JOIN pg_index ix ON ix.indexrelid = inh.inhrelid
         JOIN pg_class tbl ON tbl.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = parentidx.relnamespace
        WHERE n.nspname = $1
          AND parentidx.relname = $2`,
      [schema, AddMessagesContentSearchGinIndex1802300000000.PARENT_INDEX],
    );
    const attached = new Set<string>();
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const name = (r as { partition_name?: unknown }).partition_name;
        if (typeof name === 'string') {
          attached.add(name);
        }
      }
    }
    return attached;
  }

  /**
   * A crashed CREATE INDEX CONCURRENTLY leaves an INVALID index; IF NOT
   * EXISTS then skips the rebuild forever and the ATTACH would pin an
   * invalid leaf. Drop INVALID leftovers so the concurrent rebuild can run
   * (an INVALID index never finished building, so the DROP is a cheap
   * catalog operation, not a storage scan).
   */
  private async healInvalidPartitionIndex(
    queryRunner: QueryRunner,
    schema: string,
    partition: string,
  ): Promise<void> {
    const indexName =
      partition + AddMessagesContentSearchGinIndex1802300000000.PARTITION_INDEX_SUFFIX;
    const rows: unknown = await queryRunner.query(
      `SELECT 1
         FROM pg_index i
         JOIN pg_class idx ON idx.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = idx.relnamespace
         JOIN pg_class tbl ON tbl.oid = i.indrelid
        WHERE n.nspname = $1
          AND idx.relname = $2
          AND tbl.relname = $3
          AND i.indisvalid = false`,
      [schema, indexName, partition],
    );
    if (Array.isArray(rows) && rows.length > 0) {
      this.logger.warn(
        `Dropping INVALID leftover index "${schema}"."${indexName}" before concurrent rebuild`,
      );
      await queryRunner.query(`DROP INDEX IF EXISTS "${schema}"."${indexName}"`);
    }
  }
}
