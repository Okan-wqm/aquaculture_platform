import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  MigrationLogger,
  PostConditionAwareMigration,
  TenantFanOut,
} from '@aquaculture/backend-common/database';

/**
 * AddFarmOperationalQuantityChecks1801500000000
 * ============================================================================
 *
 * # Why this migration exists (Tier-1 make-impossible for physical quantities)
 *
 * Before this migration, farm-service carried exactly ONE DB `@Check`
 * constraint across the whole domain (`feeding_program_tanks.totalFeedTransitions
 * >= 0`). Every other physical-quantity column — fish counts, biomass (kg),
 * weights (g), stock levels, densities — relied SOLELY on DTO `@Min`
 * validation at the application boundary. A direct repository write, a buggy
 * event handler, an upcaster, or a future code path that skips the DTO can
 * therefore persist a negative biomass / negative fish count, which is
 * physically impossible and silently corrupts FCR, density, and regulatory
 * biomass aggregates.
 *
 * The architectural fix (CLAUDE.md hierarchy Tier-1) is to make the wrong
 * state STRUCTURALLY impossible: a DB CHECK constraint rejects the negative
 * write regardless of which code path attempted it. Each constraint is
 * MIRRORED by a `@Check` decorator on the owning entity so entity↔DB parity
 * holds and the SchemaDriftValidator / introspector sees the same shape.
 *
 * # Predicate sourcing (mirror the DTO @Min contracts)
 *
 *   - mortality_records."count" > 0   — DTO is `@Min(1)` (a mortality event of
 *     zero fish is not a record); strictly greater-than, NOT >= 0.
 *   - biomass_reports."reportMonth" BETWEEN 1 AND 12, "reportYear" BETWEEN
 *     2000 AND 2100 — calendar bounds (1-based month per the frontend form).
 *   - all other quantity/biomass/weight/count/stock/density columns: >= 0.
 *
 * NULLABLE columns use `("col" IS NULL OR "col" >= 0)` so legitimately-absent
 * values are never rejected — a CHECK in PostgreSQL passes on NULL only if the
 * predicate evaluates to NULL/true, and an explicit IS NULL branch documents
 * the intent.
 *
 * # EXCLUDED on purpose
 *
 *   - NO `currentBiomass <= maxBiomass` / over-capacity CHECK. Tank
 *     over-capacity is a LEGITIMATE admin-overridable operational state
 *     (project memory: farm tank over-capacity rule) — it is recorded via
 *     `tank_batches.isOverCapacity` + audit, not forbidden. Only
 *     non-negativity + calendar bounds are encoded here.
 *   - NO check on `growth_measurements."biomassGain"` — biomass gain is a
 *     DELTA between measurements and is legitimately NEGATIVE when a batch
 *     loses biomass (mortality/disease). Constraining it >= 0 would reject
 *     real data.
 *   - NO check on feeding `variance` — variance (actual - planned) is signed.
 *
 * # Schema routing & fan-out
 *
 * All target tables are per-tenant (their entities omit `schema:`), so this
 * migration uses BARE table names: the runner pins `search_path` to `farm`
 * then each `tenant_<uuid>` clone and re-runs the migration, so unqualified
 * names resolve to the current schema. `@TenantFanOut({ lockClass:
 * 'tenant-local' })` lets the orchestrator parallelise the per-tenant DDL.
 *
 * # Idempotency (sql-lint R11)
 *
 * PostgreSQL has no `ADD CONSTRAINT IF NOT EXISTS`. Each `ADD CONSTRAINT` is
 * wrapped in a `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL;
 * END $$;` block — the canonical replayable idiom — so a re-run (the runner
 * replays until the ledger logs success) is a clean no-op.
 *
 * # Pre-flight FAIL-LOUD probe
 *
 * `ADD CONSTRAINT ... CHECK` validates existing rows and ERRORS if any row
 * violates the predicate. Rather than surface an opaque postgres `23514`
 * deep inside a DO-block, we probe each constraint's predicate first and
 * throw a clear, actionable error naming the table, predicate, and violating
 * row count so the operator can clean the offending rows before re-running.
 *
 * # postCondition (runner barrier)
 *
 * After the body runs, the runner invokes `postCondition(qr)` inside the
 * wrapper transaction. We assert that a representative set of the new
 * constraints actually exists in `current_schema()` via `pg_constraint` —
 * if the DO-block silently swallowed a real failure (it should not, since we
 * only catch `duplicate_object`), the missing constraint trips the barrier
 * and the ledger row never commits.
 *
 * # down()
 *
 * Documented no-op — dropping a non-negativity invariant is never a routine
 * rollback action; re-permitting negative biomass is a data-integrity
 * regression. A break-glass `DROP CONSTRAINT` would be run by an operator
 * under an explicit incident, not by this `down()`.
 */

/** One CHECK constraint to add: table, stable name, predicate, probe SQL. */
interface QuantityCheck {
  /** Bare per-tenant table name (runner pins search_path). */
  readonly table: string;
  /** Stable constraint name (used for ADD + pg_constraint postCondition). */
  readonly constraint: string;
  /** The CHECK predicate body (without the surrounding CHECK (...)). */
  readonly predicate: string;
  /**
   * Boolean SQL expression that is TRUE for a VIOLATING row. Used by the
   * fail-loud pre-flight probe (`COUNT(*) WHERE <violation>`).
   */
  readonly violation: string;
}

/**
 * Canonical constraint catalogue. Column names verified against the baseline
 * (1800000000000) CREATE TABLE statements before listing here.
 */
const CHECKS: readonly QuantityCheck[] = [
  // --- biomass_reports: calendar bounds + non-negative denormalised total ---
  {
    table: 'biomass_reports',
    constraint: 'CHK_biomass_reports_report_month',
    predicate: `"reportMonth" BETWEEN 1 AND 12`,
    violation: `"reportMonth" < 1 OR "reportMonth" > 12`,
  },
  {
    table: 'biomass_reports',
    constraint: 'CHK_biomass_reports_report_year',
    predicate: `"reportYear" BETWEEN 2000 AND 2100`,
    violation: `"reportYear" < 2000 OR "reportYear" > 2100`,
  },
  {
    table: 'biomass_reports',
    constraint: 'CHK_biomass_reports_total_biomass_nonneg',
    predicate: `"totalBiomassKg" >= 0`,
    violation: `"totalBiomassKg" < 0`,
  },
  // --- mortality_records: a mortality event counts at least one fish ---
  {
    table: 'mortality_records',
    constraint: 'CHK_mortality_records_count_positive',
    predicate: `"count" > 0`,
    violation: `"count" <= 0`,
  },
  // --- tanks: capacity/biomass/density non-negative; currentCount nullable ---
  {
    table: 'tanks',
    constraint: 'CHK_tanks_max_biomass_nonneg',
    predicate: `"maxBiomass" >= 0`,
    violation: `"maxBiomass" < 0`,
  },
  {
    table: 'tanks',
    constraint: 'CHK_tanks_current_biomass_nonneg',
    predicate: `"currentBiomass" >= 0`,
    violation: `"currentBiomass" < 0`,
  },
  {
    table: 'tanks',
    constraint: 'CHK_tanks_max_density_nonneg',
    predicate: `"maxDensity" >= 0`,
    violation: `"maxDensity" < 0`,
  },
  {
    table: 'tanks',
    constraint: 'CHK_tanks_current_count_nonneg',
    predicate: `"currentCount" IS NULL OR "currentCount" >= 0`,
    violation: `"currentCount" IS NOT NULL AND "currentCount" < 0`,
  },
  // --- tank_batches ---
  {
    table: 'tank_batches',
    constraint: 'CHK_tank_batches_total_quantity_nonneg',
    predicate: `"totalQuantity" >= 0`,
    violation: `"totalQuantity" < 0`,
  },
  {
    table: 'tank_batches',
    constraint: 'CHK_tank_batches_avg_weight_nonneg',
    predicate: `"avgWeightG" >= 0`,
    violation: `"avgWeightG" < 0`,
  },
  {
    table: 'tank_batches',
    constraint: 'CHK_tank_batches_total_biomass_nonneg',
    predicate: `"totalBiomassKg" >= 0`,
    violation: `"totalBiomassKg" < 0`,
  },
  {
    table: 'tank_batches',
    constraint: 'CHK_tank_batches_density_nonneg',
    predicate: `"densityKgM3" >= 0`,
    violation: `"densityKgM3" < 0`,
  },
  {
    table: 'tank_batches',
    constraint: 'CHK_tank_batches_cleaner_qty_nonneg',
    predicate: `"cleanerFishQuantity" >= 0`,
    violation: `"cleanerFishQuantity" < 0`,
  },
  {
    table: 'tank_batches',
    constraint: 'CHK_tank_batches_cleaner_biomass_nonneg',
    predicate: `"cleanerFishBiomassKg" >= 0`,
    violation: `"cleanerFishBiomassKg" < 0`,
  },
  {
    table: 'tank_batches',
    constraint: 'CHK_tank_batches_current_quantity_nonneg',
    predicate: `"currentQuantity" IS NULL OR "currentQuantity" >= 0`,
    violation: `"currentQuantity" IS NOT NULL AND "currentQuantity" < 0`,
  },
  {
    table: 'tank_batches',
    constraint: 'CHK_tank_batches_current_biomass_nonneg',
    predicate: `"currentBiomassKg" IS NULL OR "currentBiomassKg" >= 0`,
    violation: `"currentBiomassKg" IS NOT NULL AND "currentBiomassKg" < 0`,
  },
  // --- tank_allocations ---
  {
    table: 'tank_allocations',
    constraint: 'CHK_tank_allocations_quantity_nonneg',
    predicate: `"quantity" >= 0`,
    violation: `"quantity" < 0`,
  },
  {
    table: 'tank_allocations',
    constraint: 'CHK_tank_allocations_avg_weight_nonneg',
    predicate: `"avgWeightG" >= 0`,
    violation: `"avgWeightG" < 0`,
  },
  {
    table: 'tank_allocations',
    constraint: 'CHK_tank_allocations_biomass_nonneg',
    predicate: `"biomassKg" >= 0`,
    violation: `"biomassKg" < 0`,
  },
  {
    table: 'tank_allocations',
    constraint: 'CHK_tank_allocations_density_nonneg',
    predicate: `"densityKgM3" IS NULL OR "densityKgM3" >= 0`,
    violation: `"densityKgM3" IS NOT NULL AND "densityKgM3" < 0`,
  },
  // --- harvest_records ---
  {
    table: 'harvest_records',
    constraint: 'CHK_harvest_records_quantity_nonneg',
    predicate: `"quantityHarvested" >= 0`,
    violation: `"quantityHarvested" < 0`,
  },
  {
    table: 'harvest_records',
    constraint: 'CHK_harvest_records_total_biomass_nonneg',
    predicate: `"totalBiomass" >= 0`,
    violation: `"totalBiomass" < 0`,
  },
  {
    table: 'harvest_records',
    constraint: 'CHK_harvest_records_avg_weight_nonneg',
    predicate: `"averageWeight" >= 0`,
    violation: `"averageWeight" < 0`,
  },
  {
    table: 'harvest_records',
    constraint: 'CHK_harvest_records_min_weight_nonneg',
    predicate: `"minWeight" IS NULL OR "minWeight" >= 0`,
    violation: `"minWeight" IS NOT NULL AND "minWeight" < 0`,
  },
  {
    table: 'harvest_records',
    constraint: 'CHK_harvest_records_max_weight_nonneg',
    predicate: `"maxWeight" IS NULL OR "maxWeight" >= 0`,
    violation: `"maxWeight" IS NOT NULL AND "maxWeight" < 0`,
  },
  {
    table: 'harvest_records',
    constraint: 'CHK_harvest_records_rejected_qty_nonneg',
    predicate: `"rejectedQuantity" IS NULL OR "rejectedQuantity" >= 0`,
    violation: `"rejectedQuantity" IS NOT NULL AND "rejectedQuantity" < 0`,
  },
  {
    table: 'harvest_records',
    constraint: 'CHK_harvest_records_mortality_nonneg',
    predicate: `"mortalityDuringHarvest" IS NULL OR "mortalityDuringHarvest" >= 0`,
    violation: `"mortalityDuringHarvest" IS NOT NULL AND "mortalityDuringHarvest" < 0`,
  },
  // --- feeding_records ---
  {
    table: 'feeding_records',
    constraint: 'CHK_feeding_records_planned_amount_nonneg',
    predicate: `"plannedAmount" >= 0`,
    violation: `"plannedAmount" < 0`,
  },
  {
    table: 'feeding_records',
    constraint: 'CHK_feeding_records_actual_amount_nonneg',
    predicate: `"actualAmount" >= 0`,
    violation: `"actualAmount" < 0`,
  },
  {
    table: 'feeding_records',
    constraint: 'CHK_feeding_records_waste_amount_nonneg',
    predicate: `"wasteAmount" IS NULL OR "wasteAmount" >= 0`,
    violation: `"wasteAmount" IS NOT NULL AND "wasteAmount" < 0`,
  },
  // --- growth_measurements (biomassGain EXCLUDED — signed delta) ---
  {
    table: 'growth_measurements',
    constraint: 'CHK_growth_measurements_sample_size_nonneg',
    predicate: `"sampleSize" >= 0`,
    violation: `"sampleSize" < 0`,
  },
  {
    table: 'growth_measurements',
    constraint: 'CHK_growth_measurements_population_nonneg',
    predicate: `"populationSize" >= 0`,
    violation: `"populationSize" < 0`,
  },
  {
    table: 'growth_measurements',
    constraint: 'CHK_growth_measurements_avg_weight_nonneg',
    predicate: `"averageWeight" >= 0`,
    violation: `"averageWeight" < 0`,
  },
  {
    table: 'growth_measurements',
    constraint: 'CHK_growth_measurements_est_biomass_nonneg',
    predicate: `"estimatedBiomass" >= 0`,
    violation: `"estimatedBiomass" < 0`,
  },
  {
    table: 'growth_measurements',
    constraint: 'CHK_growth_measurements_prev_biomass_nonneg',
    predicate: `"previousBiomass" IS NULL OR "previousBiomass" >= 0`,
    violation: `"previousBiomass" IS NOT NULL AND "previousBiomass" < 0`,
  },
  // --- stock_movements (snake_case table, camelCase-free column) ---
  {
    table: 'stock_movements',
    constraint: 'CHK_stock_movements_quantity_nonneg',
    predicate: `"quantity" >= 0`,
    violation: `"quantity" < 0`,
  },
  // --- feeds ---
  {
    table: 'feeds',
    constraint: 'CHK_feeds_quantity_nonneg',
    predicate: `"quantity" >= 0`,
    violation: `"quantity" < 0`,
  },
  {
    table: 'feeds',
    constraint: 'CHK_feeds_min_stock_nonneg',
    predicate: `"minStock" >= 0`,
    violation: `"minStock" < 0`,
  },
  // --- chemicals ---
  {
    table: 'chemicals',
    constraint: 'CHK_chemicals_quantity_nonneg',
    predicate: `"quantity" >= 0`,
    violation: `"quantity" < 0`,
  },
  {
    table: 'chemicals',
    constraint: 'CHK_chemicals_min_stock_nonneg',
    predicate: `"minStock" >= 0`,
    violation: `"minStock" < 0`,
  },
];

@TenantFanOut({ lockClass: 'tenant-local', concurrency: 8 })
export class AddFarmOperationalQuantityChecks1801500000000
  implements MigrationInterface, PostConditionAwareMigration
{
  name = 'AddFarmOperationalQuantityChecks1801500000000';

  private readonly logger = new MigrationLogger(
    'AddFarmOperationalQuantityChecks1801500000000',
  );

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Lock-timeout envelope. ADD CONSTRAINT takes ACCESS EXCLUSIVE + scans
    // the table to validate existing rows; bound the wait and the scan.
    // SET LOCAL releases on COMMIT. search_path is owned by the runner.
    await queryRunner.query(`SET LOCAL lock_timeout = '30s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '600s'`);

    for (const check of CHECKS) {
      // FAIL-LOUD pre-flight: a violating row would make ADD CONSTRAINT throw
      // an opaque 23514 deep inside the DO-block. Probe first, throw clearly.
      const rows: Array<{ violations: string }> = await queryRunner.query(
        `SELECT COUNT(*)::text AS violations
         FROM "${check.table}"
         WHERE ${check.violation}`,
      );
      const violations = Number(rows[0]?.violations ?? '0');
      if (violations > 0) {
        throw new Error(
          `[AddFarmOperationalQuantityChecks] Table "${check.table}" has ` +
            `${violations} row(s) violating CHECK (${check.predicate}). ` +
            `ADD CONSTRAINT would fail validation. Operator MUST clean the ` +
            `violating rows before re-running this migration.`,
        );
      }

      // Idempotent ADD CONSTRAINT via the canonical DO/EXCEPTION idiom
      // (PG has no ADD CONSTRAINT IF NOT EXISTS). Only duplicate_object is
      // swallowed — every other error (including 23514 validation, which the
      // pre-flight already ruled out) propagates and aborts the migration.
      await queryRunner.query(`
        DO $$
        BEGIN
          ALTER TABLE "${check.table}"
            ADD CONSTRAINT "${check.constraint}" CHECK (${check.predicate});
        EXCEPTION
          WHEN duplicate_object THEN NULL;
        END
        $$;
      `);
      this.logger.log(
        `CHECK "${check.constraint}" ensured on "${check.table}" (${check.predicate})`,
      );
    }

    this.logger.log(
      `Added/ensured ${CHECKS.length} non-negativity / range CHECK constraint(s).`,
    );
  }

  /**
   * Runner barrier: assert a representative set of the new constraints exists
   * in the current (runner-pinned) schema. Returns false → runner rolls the
   * wrapper tx back and the ledger row never commits.
   */
  public async postCondition(queryRunner: QueryRunner): Promise<boolean> {
    // Sentinels span tables + both predicate shapes (>0, BETWEEN, nullable).
    const sentinels = [
      'CHK_mortality_records_count_positive',
      'CHK_biomass_reports_report_month',
      'CHK_tanks_current_biomass_nonneg',
      'CHK_stock_movements_quantity_nonneg',
      'CHK_feeds_quantity_nonneg',
    ];
    const rows: Array<{ present: string }> = await queryRunner.query(
      `SELECT COUNT(*)::text AS present
       FROM pg_constraint c
       JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE n.nspname = current_schema()
         AND c.contype = 'c'
         AND c.conname = ANY($1::text[])`,
      [sentinels],
    );
    const present = Number(rows[0]?.present ?? '0');
    if (present !== sentinels.length) {
      this.logger.error(
        `postCondition FAILED: expected ${sentinels.length} sentinel CHECK ` +
          `constraints in current_schema(), found ${present}.`,
      );
      return false;
    }
    return true;
  }

  public async down(): Promise<void> {
    // Intentional no-op — see class docblock § down(). Re-permitting negative
    // biomass/count is a data-integrity regression, not a routine rollback.
    this.logger.warn(
      'down() is a no-op: dropping non-negativity CHECK constraints would ' +
        're-permit physically-impossible negative quantities. Drop individual ' +
        'constraints via an explicit operator procedure only.',
    );
  }
}
