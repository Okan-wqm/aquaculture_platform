/**
 * Batch Lifecycle Contract Tests
 *
 * The previous integration spec targeted the removed v1 Batch schema
 * (`batchCode`, `STOCKED`, `currentBiomassKg`, old FCR shape). These tests
 * verify the current v2 lifecycle and value-object contracts without
 * reintroducing legacy fields.
 */
import {
  Batch,
  BatchInputType,
  BatchStatus,
} from '../../entities/batch.entity';

describe('Batch Lifecycle Contract', () => {
  const createBatch = (overrides: Partial<Batch> = {}): Batch =>
    Object.assign(new Batch(), {
      id: 'batch-1',
      tenantId: 'tenant-1',
      batchNumber: 'B-2026-00001',
      name: 'Lifecycle Contract Batch',
      speciesId: 'species-1',
      inputType: BatchInputType.FRY,
      initialQuantity: 10_000,
      currentQuantity: 9_500,
      totalMortality: 500,
      cullCount: 0,
      totalFeedConsumed: 750,
      totalFeedCost: 1_500,
      stockedAt: new Date('2026-01-01T00:00:00.000Z'),
      status: BatchStatus.QUARANTINE,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      version: 1,
      weight: {
        initial: {
          avgWeight: 5,
          totalBiomass: 50,
          measuredAt: new Date('2026-01-01T00:00:00.000Z'),
        },
        theoretical: {
          avgWeight: 45,
          totalBiomass: 427.5,
          lastCalculatedAt: new Date('2026-02-01T00:00:00.000Z'),
          basedOnFCR: 1.2,
        },
        actual: {
          avgWeight: 50,
          totalBiomass: 475,
          lastMeasuredAt: new Date('2026-02-01T00:00:00.000Z'),
          sampleSize: 100,
          confidencePercent: 95,
        },
        variance: {
          weightDifference: 5,
          percentageDifference: 11.11,
          isSignificant: true,
        },
      },
      fcr: {
        target: 1.2,
        actual: 0,
        theoretical: 1.2,
        isUserOverride: false,
        lastUpdatedAt: new Date('2026-02-01T00:00:00.000Z'),
      },
      feedingSummary: {
        totalFeedGiven: 750,
        totalFeedCost: 1_500,
      },
      growthMetrics: {
        growthRate: {
          actual: 1.5,
          target: 1.4,
          variancePercent: 7.14,
        },
        daysInProduction: 31,
        projections: {
          harvestDate: new Date('2026-08-01T00:00:00.000Z'),
          harvestWeight: 500,
          confidenceLevel: 'medium',
        },
      },
      mortalitySummary: {
        totalMortality: 500,
        mortalityRate: 5,
      },
      ...overrides,
    });

  it('starts new v2 batches in quarantine, not removed STOCKED state', () => {
    const batch = createBatch();

    expect(batch.batchNumber).toBe('B-2026-00001');
    expect(batch.status).toBe(BatchStatus.QUARANTINE);
    expect(batch.currentQuantity).toBe(9_500);
    expect(batch.getCurrentBiomass()).toBe(475);
    expect(batch.getCurrentAvgWeight()).toBe(50);
  });

  it('calculates mortality, survival, retention, and SGR from v2 value objects', () => {
    const batch = createBatch({
      actualHarvestDate: new Date('2026-02-01T00:00:00.000Z'),
    });

    expect(batch.getMortalityRate()).toBe(5);
    expect(batch.getSurvivalRate()).toBe(95);
    expect(batch.getRetentionRate()).toBe(95);
    // FCR is no longer an entity method — it is owned solely by
    // FcrCalculationService.calculateCumulativeFCR (ledger-aware), covered by
    // its own spec. SGR remains on the entity (uses getCurrentAvgWeight).
    expect(batch.calculateSGR()).toBeGreaterThan(0);
    expect(batch.getDaysInProduction()).toBe(31);
  });

  it('derives current biomass from the live count (cannot go stale)', () => {
    // The stored weight.actual.totalBiomass snapshot is 475 (9500 × 50 / 1000).
    // Removing 500 more fish must drop the DERIVED biomass even though the
    // stored snapshot is unchanged — proving qty × avgWeight tracks removals.
    const batch = createBatch({ currentQuantity: 9_000 });
    expect(batch.getCurrentBiomass()).toBe(450); // 9000 × 50 / 1000
  });

  it('enforces the current lifecycle transition matrix', () => {
    expect(createBatch({ status: BatchStatus.QUARANTINE }).canTransitionTo(BatchStatus.ACTIVE)).toBe(true);
    expect(createBatch({ status: BatchStatus.ACTIVE }).canTransitionTo(BatchStatus.GROWING)).toBe(true);
    expect(createBatch({ status: BatchStatus.GROWING }).canTransitionTo(BatchStatus.PRE_HARVEST)).toBe(true);
    expect(createBatch({ status: BatchStatus.PRE_HARVEST }).canTransitionTo(BatchStatus.HARVESTING)).toBe(true);
    expect(createBatch({ status: BatchStatus.HARVESTING }).canTransitionTo(BatchStatus.HARVESTED)).toBe(true);
    expect(createBatch({ status: BatchStatus.HARVESTED }).canTransitionTo(BatchStatus.CLOSED)).toBe(true);

    expect(createBatch({ status: BatchStatus.QUARANTINE }).canTransitionTo(BatchStatus.CLOSED)).toBe(false);
    expect(createBatch({ status: BatchStatus.CLOSED }).canTransitionTo(BatchStatus.ACTIVE)).toBe(false);
  });

  it('treats only active production states as operational', () => {
    expect(createBatch({ status: BatchStatus.ACTIVE }).isOperational()).toBe(true);
    expect(createBatch({ status: BatchStatus.GROWING }).isOperational()).toBe(true);
    expect(createBatch({ status: BatchStatus.PRE_HARVEST }).isOperational()).toBe(true);
    expect(createBatch({ status: BatchStatus.HARVESTING }).isOperational()).toBe(true);

    expect(createBatch({ status: BatchStatus.QUARANTINE }).isOperational()).toBe(false);
    expect(createBatch({ status: BatchStatus.HARVESTED }).isOperational()).toBe(false);
    expect(createBatch({ status: BatchStatus.CLOSED }).isOperational()).toBe(false);
  });

  it('records closure using current status fields instead of deleted closedAt/closeReason fields', () => {
    const closedAt = new Date('2026-02-01T00:00:00.000Z');
    const batch = createBatch({
      status: BatchStatus.CLOSED,
      isActive: false,
      statusChangedAt: closedAt,
      statusReason: 'harvest_completed: final harvest complete',
      actualHarvestDate: closedAt,
    });

    expect(batch.status).toBe(BatchStatus.CLOSED);
    expect(batch.isActive).toBe(false);
    expect(batch.statusChangedAt).toBe(closedAt);
    expect(batch.statusReason).toContain('harvest_completed');
    expect(batch.actualHarvestDate).toBe(closedAt);
  });
});
