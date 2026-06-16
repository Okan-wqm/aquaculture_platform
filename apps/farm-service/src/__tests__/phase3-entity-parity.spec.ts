/**
 * Phase-3 farm-hardening entity↔DB parity invariants.
 * ============================================================================
 *
 * These specs read TypeORM metadata (no DB needed) to prove the ENTITY-side
 * half of the three Phase-3 migrations is in place, so a future baseline regen
 * reproduces the correct schema shape:
 *
 *   - 1801300000000: Farm/Pond/Worker createdAt+updatedAt pinned `timestamptz`
 *     (not the bare-decorator default `timestamp without time zone`).
 *   - 1801400000000: WaterQualityMeasurement carries a partial-UNIQUE index on
 *     (tenantId, relatedSensorReadingId) WHERE relatedSensorReadingId IS NOT NULL.
 *   - 1801500000000: the operational-quantity @Check constraints exist on their
 *     owning entities with the SAME constraint names the migration adds (so the
 *     introspector / SchemaDriftValidator sees matching entity↔DB shape).
 *   - ondelete-drift: the 6 batch-child @ManyToOne→Batch relations declare
 *     onDelete RESTRICT (matching the baseline DB FKs, which are already
 *     ON DELETE RESTRICT) so a baseline regen reproduces the same delete action,
 *     and batch_feed_assignments keeps its NO-ACTION (no onDelete) relation.
 *
 * They FAIL against the pre-fix entities (no timestamptz, no partial-unique, no
 * @Check, CASCADE/SET NULL onDelete), proving the fix and guarding the regression.
 */
import { getMetadataArgsStorage } from 'typeorm';

import { BatchDocument } from '../batch/entities/batch-document.entity';
import { BatchFeedAssignment } from '../batch/entities/batch-feed-assignment.entity';
import { BatchLocation } from '../batch/entities/batch-location.entity';
import { TankAllocation } from '../batch/entities/tank-allocation.entity';
import { TankBatch } from '../batch/entities/tank-batch.entity';
import { TankOperation } from '../batch/entities/tank-operation.entity';
import { MortalityRecord } from '../batch/entities/mortality-record.entity';
import { Chemical } from '../chemical/entities/chemical.entity';
import { Farm } from '../farm/entities/farm.entity';
import { Pond } from '../farm/entities/pond.entity';
import { Feed } from '../feed/entities/feed.entity';
import { FeedingRecord } from '../feeding/entities/feeding-record.entity';
import { GrowthMeasurement } from '../growth/entities/growth-measurement.entity';
import { HarvestRecord } from '../harvest/entities/harvest-record.entity';
import { BiomassReport } from '../regulatory/entities/biomass-report.entity';
import { StockMovement } from '../storage/entities/stock-movement.entity';
import { Tank } from '../tank/entities/tank.entity';
import { Worker } from '../worker/entities/worker.entity';
import { WaterQualityMeasurement } from '../water-quality/entities/water-quality-measurement.entity';

describe('Phase-3 entity parity — 1801300000000 audit-column timestamptz pin', () => {
  const columns = getMetadataArgsStorage().columns;

  const TIMESTAMPTZ_COLUMNS: ReadonlyArray<{ entity: Function; property: string }> = [
    { entity: Farm, property: 'createdAt' },
    { entity: Farm, property: 'updatedAt' },
    { entity: Pond, property: 'createdAt' },
    { entity: Pond, property: 'updatedAt' },
    { entity: Worker, property: 'createdAt' },
    { entity: Worker, property: 'updatedAt' },
  ];

  it.each(TIMESTAMPTZ_COLUMNS)(
    '$entity.name.$property is declared timestamptz (not the bare-decorator timestamp default)',
    ({ entity, property }) => {
      const col = columns.find(
        (c) => c.target === entity && c.propertyName === property,
      );
      expect(col).toBeDefined();
      // The bare @CreateDateColumn()/@UpdateDateColumn() default to `timestamp`
      // (without tz) — the bug. The pin must make the type explicitly timestamptz.
      expect(col?.options.type).toBe('timestamptz');
    },
  );
});

describe('Phase-3 entity parity — 1801400000000 WQ related-sensor-reading partial UNIQUE', () => {
  const indices = getMetadataArgsStorage().indices.filter(
    (i) => i.target === WaterQualityMeasurement,
  );

  it('declares a partial UNIQUE index on (tenantId, relatedSensorReadingId)', () => {
    const match = indices.find((i) => {
      const cols = i.columns;
      return (
        Array.isArray(cols) &&
        cols.length === 2 &&
        cols[0] === 'tenantId' &&
        cols[1] === 'relatedSensorReadingId'
      );
    });
    expect(match).toBeDefined();
    expect(match?.unique).toBe(true);
    expect(match?.where).toContain('relatedSensorReadingId');
    expect(match?.where).toMatch(/IS\s+NOT\s+NULL/i);
  });

  it('does not keep a redundant non-unique standalone index on relatedSensorReadingId', () => {
    // A property-level @Index() would surface as a single-column index whose
    // column is exactly ['relatedSensorReadingId']; the partial-unique already
    // serves the lookup path, so the standalone one must be gone.
    const standalone = indices.find(
      (i) =>
        Array.isArray(i.columns) &&
        i.columns.length === 1 &&
        i.columns[0] === 'relatedSensorReadingId',
    );
    expect(standalone).toBeUndefined();
  });
});

describe('Phase-3 entity parity — 1801500000000 operational-quantity @Check constraints', () => {
  const checks = getMetadataArgsStorage().checks;

  /**
   * Every constraint name here MUST match a constraint the migration adds, so
   * entity-derived metadata and the live DB constraint align. The expression
   * is asserted to contain the guarded column so a copy-paste slip is caught.
   */
  const EXPECTED_CHECKS: ReadonlyArray<{
    entity: Function;
    name: string;
    mustContain: string;
  }> = [
    { entity: MortalityRecord, name: 'CHK_mortality_records_count_positive', mustContain: '"count" > 0' },
    { entity: BiomassReport, name: 'CHK_biomass_reports_report_month', mustContain: 'reportMonth' },
    { entity: BiomassReport, name: 'CHK_biomass_reports_report_year', mustContain: 'reportYear' },
    { entity: BiomassReport, name: 'CHK_biomass_reports_total_biomass_nonneg', mustContain: 'totalBiomassKg' },
    { entity: Tank, name: 'CHK_tanks_max_biomass_nonneg', mustContain: 'maxBiomass' },
    { entity: Tank, name: 'CHK_tanks_current_biomass_nonneg', mustContain: 'currentBiomass' },
    { entity: Tank, name: 'CHK_tanks_max_density_nonneg', mustContain: 'maxDensity' },
    { entity: Tank, name: 'CHK_tanks_current_count_nonneg', mustContain: 'currentCount' },
    { entity: TankBatch, name: 'CHK_tank_batches_total_quantity_nonneg', mustContain: 'totalQuantity' },
    { entity: TankBatch, name: 'CHK_tank_batches_total_biomass_nonneg', mustContain: 'totalBiomassKg' },
    { entity: TankBatch, name: 'CHK_tank_batches_current_quantity_nonneg', mustContain: 'currentQuantity' },
    { entity: TankAllocation, name: 'CHK_tank_allocations_quantity_nonneg', mustContain: 'quantity' },
    { entity: TankAllocation, name: 'CHK_tank_allocations_biomass_nonneg', mustContain: 'biomassKg' },
    { entity: TankAllocation, name: 'CHK_tank_allocations_density_nonneg', mustContain: 'densityKgM3' },
    { entity: HarvestRecord, name: 'CHK_harvest_records_quantity_nonneg', mustContain: 'quantityHarvested' },
    { entity: HarvestRecord, name: 'CHK_harvest_records_total_biomass_nonneg', mustContain: 'totalBiomass' },
    { entity: HarvestRecord, name: 'CHK_harvest_records_min_weight_nonneg', mustContain: 'minWeight' },
    { entity: FeedingRecord, name: 'CHK_feeding_records_planned_amount_nonneg', mustContain: 'plannedAmount' },
    { entity: FeedingRecord, name: 'CHK_feeding_records_actual_amount_nonneg', mustContain: 'actualAmount' },
    { entity: FeedingRecord, name: 'CHK_feeding_records_waste_amount_nonneg', mustContain: 'wasteAmount' },
    { entity: GrowthMeasurement, name: 'CHK_growth_measurements_sample_size_nonneg', mustContain: 'sampleSize' },
    { entity: GrowthMeasurement, name: 'CHK_growth_measurements_est_biomass_nonneg', mustContain: 'estimatedBiomass' },
    { entity: GrowthMeasurement, name: 'CHK_growth_measurements_prev_biomass_nonneg', mustContain: 'previousBiomass' },
    { entity: StockMovement, name: 'CHK_stock_movements_quantity_nonneg', mustContain: 'quantity' },
    { entity: Feed, name: 'CHK_feeds_quantity_nonneg', mustContain: 'quantity' },
    { entity: Feed, name: 'CHK_feeds_min_stock_nonneg', mustContain: 'minStock' },
    { entity: Chemical, name: 'CHK_chemicals_quantity_nonneg', mustContain: 'quantity' },
    { entity: Chemical, name: 'CHK_chemicals_min_stock_nonneg', mustContain: 'minStock' },
  ];

  it.each(EXPECTED_CHECKS)(
    '$entity.name declares @Check $name',
    ({ entity, name, mustContain }) => {
      const match = checks.find(
        (c) => c.target === entity && c.name === name,
      );
      expect(match).toBeDefined();
      expect(match?.expression).toContain(mustContain);
    },
  );

  it('does NOT add an over-capacity (currentBiomass <= maxBiomass) CHECK to Tank', () => {
    // Project rule: tank over-capacity is a legitimate admin-overridable state.
    const overCapacity = checks.find(
      (c) =>
        c.target === Tank &&
        typeof c.expression === 'string' &&
        /currentBiomass[^<]*<=?\s*"?maxBiomass/.test(c.expression),
    );
    expect(overCapacity).toBeUndefined();
  });

  it('does NOT constrain growth biomassGain (signed delta — legitimately negative)', () => {
    const biomassGain = checks.find(
      (c) =>
        c.target === GrowthMeasurement &&
        typeof c.expression === 'string' &&
        c.expression.includes('biomassGain'),
    );
    expect(biomassGain).toBeUndefined();
  });
});

describe('Phase-3 entity parity — ondelete-drift batch-child FK action alignment', () => {
  const relations = getMetadataArgsStorage().relations;

  /**
   * The baseline (1800000000000) emits all 6 batch-child FKs to batches_v2 as
   * ON DELETE RESTRICT, but the entity @ManyToOne decorators had drifted to
   * CASCADE (5) / SET NULL (1). Batches are NEVER hard-deleted — DeleteBatchHandler
   * and BatchService.deleteBatch both perform a soft lifecycle close (isActive=false,
   * status=CLOSED) — so cascade/set-null was never load-bearing and is unsafe for the
   * retention-bound children (batch_documents = certificates, mortality_records =
   * Mattilsynet data). Aligning the entity to RESTRICT (the DB truth AND the regen
   * default) closes the drift class with no migration. Each row below asserts the
   * chosen action so a regression back to CASCADE/SET NULL fails the build.
   */
  const EXPECTED_BATCH_FK_ON_DELETE: ReadonlyArray<{
    entity: Function;
    property: string;
  }> = [
    { entity: BatchDocument, property: 'batch' },
    { entity: MortalityRecord, property: 'batch' },
    { entity: TankOperation, property: 'batch' },
    { entity: TankAllocation, property: 'batch' },
    { entity: BatchLocation, property: 'batch' },
    { entity: TankBatch, property: 'primaryBatch' },
  ];

  it.each(EXPECTED_BATCH_FK_ON_DELETE)(
    '$entity.name.$property @ManyToOne→Batch declares onDelete RESTRICT (matches baseline DB FK, regen-stable)',
    ({ entity, property }) => {
      const rel = relations.find(
        (r) => r.target === entity && r.propertyName === property,
      );
      expect(rel).toBeDefined();
      expect(rel?.options.onDelete).toBe('RESTRICT');
    },
  );

  it('batch_feed_assignments.batch keeps NO ACTION (no onDelete) — untouched, already correct', () => {
    // The baseline emits FK_9edd460ca918f2959169674cbbd as ON DELETE NO ACTION,
    // and the entity has no onDelete option (= NO ACTION). This is the one
    // batch-child FK that did NOT drift; it must stay untouched.
    const rel = relations.find(
      (r) => r.target === BatchFeedAssignment && r.propertyName === 'batch',
    );
    expect(rel).toBeDefined();
    expect(rel?.options.onDelete).toBeUndefined();
  });
});
