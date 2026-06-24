/**
 * Batch Performance & Metrics E2E Tests
 *
 * Batch performans hesaplamalari, olay gecmisi ve yardimci sorgulari test eder.
 *
 * Resolvers:
 * - batchPerformance(id) -> FCR, SGR, mortality rate
 * - batchHistory(id) -> event timeline
 * - generateBatchNumber -> unique, correct format
 * - availableTanks -> bos tanklar listesi
 *
 * @module E2E/Farm/BatchMetrics
 */
import {
  gqlExpectSuccess,
  BATCH_PERFORMANCE_FIELDS,
  BATCH_HISTORY_FIELDS,
  AVAILABLE_TANK_FIELDS,
  createTestSpecies,
  createTestBatch,
} from './test-helpers';

describe('Batch Performance & Metrics E2E', () => {
  let speciesId: string;
  let batchId: string;
  let tankId: string;

  beforeAll(async () => {
    // Species olustur
    const species = await createTestSpecies({
      commonName: 'Metrics Test Fish',
    });
    speciesId = species.id as string;

    // Batch olustur
    const batch = await createTestBatch({
      speciesId,
      name: 'Metrics Test Batch',
      initialQuantity: 5000,
      initialAvgWeightG: 10.0,
      initialTotalBiomassKg: 50.0,
    });
    batchId = batch.id as string;

    // Status'u ACTIVE yap
    await gqlExpectSuccess(
      `
        mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!) {
          updateBatchStatus(id: $id, status: $status) { id status }
        }
      `,
      { id: batchId, status: 'ACTIVE' },
    );

    // Tank al
    const tanks = await gqlExpectSuccess<{
      availableTanks: Array<Record<string, unknown>>;
    }>(`query { availableTanks { id code name } }`);
    if (tanks.availableTanks && tanks.availableTanks.length > 0) {
      const [firstTank] = tanks.availableTanks;
      if (!firstTank) throw new Error('Expected at least one available tank');
      tankId = firstTank.id as string;

      // Tank'a allocation yap
      await gqlExpectSuccess(
        `
          mutation AllocateToTank($input: AllocateToTankInput!) {
            allocateBatchToTank(input: $input) { id }
          }
        `,
        {
          input: {
            batchId,
            tankId,
            quantity: 5000,
            avgWeightG: 10.0,
            allocationType: 'INITIAL_STOCKING',
          },
        },
      );
    }

    // Mortality kaydet (mortality rate > 0 olsun)
    if (tankId) {
      await gqlExpectSuccess(
        `
          mutation RecordMortality($input: RecordMortalityInput!) {
            recordMortality(input: $input) { id currentQuantity totalMortality }
          }
        `,
        {
          input: {
            batchId,
            tankId,
            quantity: 25,
            reason: 'DISEASE',
            observedAt: new Date().toISOString(),
          },
        },
      );
    }
  });

  // =========================================================================
  // Test 1: batchPerformance -> FCR, SGR, mortality rate
  // =========================================================================
  describe('Test 1: Batch Performance', () => {
    it('should return batch performance metrics', async () => {
      const data = await gqlExpectSuccess<{
        batchPerformance: Record<string, unknown>;
      }>(
        `
          query GetBatchPerformance($id: ID!) {
            batchPerformance(id: $id) {
              ${BATCH_PERFORMANCE_FIELDS}
            }
          }
        `,
        { id: batchId },
      );

      const perf = data.batchPerformance;

      // Temel alanlar
      expect(perf.batchId).toBe(batchId);
      expect(perf.batchNumber).toBeDefined();
      expect(perf.speciesName).toBeDefined();

      // Miktar metrikleri
      expect(perf.initialQuantity).toBe(5000);
      expect(perf.currentQuantity).toBeLessThan(5000); // mortality kaydedildi

      // Biomass metrikleri
      expect(typeof perf.initialBiomassKg).toBe('number');
      expect(typeof perf.currentBiomassKg).toBe('number');
      expect(typeof perf.initialAvgWeightG).toBe('number');
      expect(typeof perf.currentAvgWeightG).toBe('number');

      // Mortality / Survival
      expect(perf.totalMortality).toBeGreaterThan(0);
      expect(typeof perf.mortalityRate).toBe('number');
      expect(perf.mortalityRate as number).toBeGreaterThan(0);
      expect(typeof perf.survivalRate).toBe('number');
      expect(perf.survivalRate as number).toBeLessThan(100);
      expect(typeof perf.retentionRate).toBe('number');

      // Growth metrikleri
      expect(typeof perf.sgr).toBe('number');
      expect(typeof perf.daysInProduction).toBe('number');
      expect(perf.daysInProduction as number).toBeGreaterThanOrEqual(0);
      expect(typeof perf.avgDailyGrowthG).toBe('number');

      // Cost metrikleri
      expect(typeof perf.purchaseCost).toBe('number');
      expect(typeof perf.totalCost).toBe('number');
      expect(typeof perf.costPerKg).toBe('number');
      expect(typeof perf.costPerFish).toBe('number');

      // Feed metrikleri
      expect(typeof perf.totalFeedConsumedKg).toBe('number');
      expect(typeof perf.totalFeedCost).toBe('number');

      // Performance index
      expect(typeof perf.performanceIndex).toBe('number');
      expect(perf.performanceStatus).toBeDefined();
      expect(
        [
          'EXCELLENT',
          'GOOD',
          'AVERAGE',
          'BELOW_AVERAGE',
          'POOR',
          'excellent',
          'good',
          'average',
          'below_average',
          'poor',
        ].includes(perf.performanceStatus as string),
      ).toBe(true);
    });

    it('should return FCR information in performance', async () => {
      const data = await gqlExpectSuccess<{
        batchPerformance: Record<string, unknown>;
      }>(
        `
          query GetBatchPerformance($id: ID!) {
            batchPerformance(id: $id) {
              batchId
              fcr {
                target
                actual
                theoretical
                variance
                status
              }
            }
          }
        `,
        { id: batchId },
      );

      const fcr = data.batchPerformance.fcr as Record<string, unknown>;
      expect(fcr).toBeDefined();
      expect(typeof fcr.target).toBe('number');
      expect(typeof fcr.actual).toBe('number');
      expect(typeof fcr.theoretical).toBe('number');
      expect(typeof fcr.variance).toBe('number');
      expect(fcr.status).toBeDefined();
    });
  });

  // =========================================================================
  // Test 2: batchHistory -> event timeline
  // =========================================================================
  describe('Test 2: Batch History', () => {
    it('should return batch history events', async () => {
      const data = await gqlExpectSuccess<{
        batchHistory: Array<Record<string, unknown>>;
      }>(
        `
          query GetBatchHistory($id: ID!) {
            batchHistory(id: $id) {
              ${BATCH_HISTORY_FIELDS}
            }
          }
        `,
        { id: batchId },
      );

      expect(data.batchHistory).toBeDefined();
      expect(Array.isArray(data.batchHistory)).toBe(true);

      // En az 1 event olmali (CREATED)
      expect(data.batchHistory.length).toBeGreaterThanOrEqual(1);

      // Her event'te temel alanlar var
      for (const entry of data.batchHistory) {
        expect(entry.id).toBeDefined();
        expect(entry.eventType).toBeDefined();
        expect(entry.timestamp).toBeDefined();
        expect(entry.description).toBeDefined();
      }
    });

    it('should filter history by event type', async () => {
      const data = await gqlExpectSuccess<{
        batchHistory: Array<Record<string, unknown>>;
      }>(
        `
          query GetBatchHistory($id: ID!, $eventTypes: [BatchHistoryEventType!]) {
            batchHistory(id: $id, eventTypes: $eventTypes) {
              id eventType description
            }
          }
        `,
        {
          id: batchId,
          eventTypes: ['STATUS_CHANGED'],
        },
      );

      // Filtrelenmis sonuc
      for (const entry of data.batchHistory) {
        expect(entry.eventType).toBe('STATUS_CHANGED');
      }
    });

    it('should have MORTALITY event in history after recording mortality', async () => {
      const data = await gqlExpectSuccess<{
        batchHistory: Array<Record<string, unknown>>;
      }>(
        `
          query GetBatchHistory($id: ID!, $eventTypes: [BatchHistoryEventType!]) {
            batchHistory(id: $id, eventTypes: $eventTypes) {
              id eventType description quantityChange
            }
          }
        `,
        {
          id: batchId,
          eventTypes: ['MORTALITY'],
        },
      );

      if (tankId) {
        // Mortality kaydedildiyse event olmali
        expect(data.batchHistory.length).toBeGreaterThanOrEqual(1);
        const mortalityEvent = data.batchHistory[0];
        if (!mortalityEvent) throw new Error('Expected mortality event in batch history');
        expect(mortalityEvent.eventType).toBe('MORTALITY');
      }
    });
  });

  // =========================================================================
  // Test 3: generateBatchNumber -> unique, correct format
  // =========================================================================
  describe('Test 3: Generate Batch Number', () => {
    it('should generate batch number with B-YYYY-XXXXX format', async () => {
      const data = await gqlExpectSuccess<{ generateBatchNumber: string }>(
        `query { generateBatchNumber }`,
      );

      expect(data.generateBatchNumber).toBeDefined();
      expect(data.generateBatchNumber).toMatch(/^B-\d{4}-\d{5}$/);
    });

    it('should generate unique batch numbers on consecutive calls', async () => {
      const results: string[] = [];

      for (let i = 0; i < 3; i++) {
        const data = await gqlExpectSuccess<{ generateBatchNumber: string }>(
          `query { generateBatchNumber }`,
        );
        results.push(data.generateBatchNumber);
      }

      // Tum numaralar unique olmali
      const uniqueSet = new Set(results);
      expect(uniqueSet.size).toBe(results.length);
    });
  });

  // =========================================================================
  // Test 4: availableTanks -> bos tanklar listesi
  // =========================================================================
  describe('Test 4: Available Tanks', () => {
    it('should return available tanks list', async () => {
      const data = await gqlExpectSuccess<{
        availableTanks: Array<Record<string, unknown>>;
      }>(
        `
          query AvailableTanks {
            availableTanks {
              ${AVAILABLE_TANK_FIELDS}
            }
          }
        `,
      );

      expect(data.availableTanks).toBeDefined();
      expect(Array.isArray(data.availableTanks)).toBe(true);

      // Her tank'ta gerekli alanlar var
      for (const tank of data.availableTanks) {
        expect(tank.id).toBeDefined();
        expect(tank.code).toBeDefined();
        expect(tank.name).toBeDefined();
        expect(typeof tank.volume).toBe('number');
        expect(typeof tank.maxBiomass).toBe('number');
        expect(typeof tank.currentBiomass).toBe('number');
        expect(typeof tank.availableCapacity).toBe('number');
        expect(typeof tank.currentCount).toBe('number');
        expect(typeof tank.maxDensity).toBe('number');
        expect(typeof tank.currentDensity).toBe('number');
        expect(tank.status).toBeDefined();
        expect(tank.departmentId).toBeDefined();
        expect(tank.departmentName).toBeDefined();
      }
    });

    it('should filter available tanks excluding full tanks', async () => {
      const data = await gqlExpectSuccess<{
        availableTanks: Array<Record<string, unknown>>;
      }>(
        `
          query AvailableTanks($excludeFullTanks: Boolean) {
            availableTanks(excludeFullTanks: $excludeFullTanks) {
              id availableCapacity currentDensity maxDensity
            }
          }
        `,
        { excludeFullTanks: true },
      );

      // excludeFullTanks=true ise donen tanklarin kapasitesi > 0 olmali
      for (const tank of data.availableTanks) {
        expect(tank.availableCapacity as number).toBeGreaterThan(0);
      }
    });
  });
});
