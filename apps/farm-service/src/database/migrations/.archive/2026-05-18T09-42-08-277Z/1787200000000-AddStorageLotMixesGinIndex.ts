import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * AddStorageLotMixesGinIndex
 * ============================================================================
 *
 * Phase 5.2 of the "Farm modülü kalan kör noktalar" plan. The
 * original plan enumerated four speculative GIN indexes on hot JSONB
 * paths:
 *
 *   - idx_wq_ph          on water_quality_measurements.parameters->pH
 *   - idx_wq_do          on water_quality_measurements.parameters->dissolvedOxygen
 *   - idx_wq_temp        on water_quality_measurements.parameters->temperature
 *   - idx_batches_v2_weight_actual on batches_v2.weight->actual->>avg
 *
 * A code-level grep of apps/farm-service/src/**\/*.ts shows:
 *
 *   - `water_quality_measurements` has dedicated scalar columns
 *     (`temperature`, `dissolvedOxygen`, `pH`, `ammonia`, `nitrite`)
 *     that are the actual query targets. The `parameters` JSONB is
 *     written but not filtered on — adding GIN indexes on paths no
 *     production query touches would add INSERT overhead and disk
 *     use with no measurable benefit.
 *   - `batches_v2.weight` is READ at per-batch granularity (the
 *     BatchCostCalculator and GetBatchPerformance handlers dereference
 *     `batch.weight.actual.totalBiomass` after loading one row) but
 *     never FILTERED on. Indexes only speed up WHERE, not SELECT.
 *
 * The ONE JSONB column that IS queried with `@>` containment in the
 * current codebase is `farm.storage_lot_mixes.contributingLots`,
 * which phase 2.4 added specifically for the `traceLot(lotNumber)`
 * regulatory trace path:
 *
 *   apps/farm-service/src/storage/services/lot-mix.service.ts:191
 *     .andWhere(`mix."contributingLots" @> :lotFilter`, {
 *       lotFilter: JSON.stringify([{ lotNumber }]),
 *     })
 *
 * Without a GIN index this query falls back to a sequential scan of
 * every mix row in the tenant. Current volume is low (one row per
 * mix event; a silo might see O(10) mixes a year) but every call
 * triggers a full table scan regardless. Trace latency is regulated
 * (Mattilsynet + EU 178/2002 expect a 2-hour traceback) so ensuring
 * the query is indexed keeps the margin wide as volumes grow.
 *
 * This migration creates the one index that matches a real query.
 * The speculative water-quality + batch weight indexes are skipped
 * until a query actually filters on those JSONB paths; the plan
 * entry is annotated "narrowed to real workload" on the phase 5.2
 * line of docs/illustrator/farm-modulu-kor-noktalar-dogrulama.md.
 *
 * # CREATE INDEX CONCURRENTLY
 *
 * CREATE INDEX CONCURRENTLY cannot run inside a transaction. The
 * TypeORM migration runner wraps every migration in one by default,
 * so we opt OUT for this migration via `transaction = false` on the
 * class — a TypeORM 0.3 supported escape hatch documented on
 * MigrationInterface. The migration runs outside BEGIN/COMMIT and
 * CONCURRENTLY succeeds. A failed CONCURRENTLY leaves an INVALID
 * index behind (checkable via `pg_index.indisvalid = false`); the
 * up() body is idempotent via `IF NOT EXISTS` so a re-run picks up
 * where it left off.
 *
 * `storage_lot_mixes` is a phase-2.4 table introduced on 2026-04-22
 * with low row count per tenant at the time of this index, but
 * CONCURRENTLY future-proofs the migration against later deploys
 * against tenants that have accumulated thousands of rows.
 */
export class AddStorageLotMixesGinIndex1787200000000
  implements MigrationInterface
{
  /** Required for CREATE INDEX CONCURRENTLY — see docblock above. */
  public transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_storage_lot_mixes_contributing_lots_gin
      ON farm.storage_lot_mixes
      USING GIN ("contributingLots" jsonb_path_ops)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX CONCURRENTLY IF EXISTS farm.idx_storage_lot_mixes_contributing_lots_gin
    `);
  }
}
