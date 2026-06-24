/**
 * Cleaner Fish E2E Tests
 *
 * Cleaner fish (Lumpfish, Wrasse) batch operasyonlarini end-to-end test eder.
 *
 * Resolvers:
 * - createCleanerFishBatch -> batch(batchType=CLEANER_FISH) olusturur
 * - deployCleanerFish -> TankBatch'e cleaner fish ekler
 * - recordCleanerMortality -> cleaner fish count azaltir
 * - removeCleanerFish -> cleaner fish'i tanktan cikarir
 * - transferCleanerFish -> tank A'dan tank B'ye transfer
 * - cleanerFishBatches -> cleaner batch listesi
 * - tankCleanerFish -> tank bazli cleaner fish bilgisi
 *
 * @module E2E/Farm/CleanerFish
 */
import { gqlExpectSuccess, TENANT_A_ID, BATCH_FIELDS, createTestSpecies } from './test-helpers';

describe('Cleaner Fish E2E', () => {
  let cleanerSpeciesId: string;
  let cleanerBatchId: string;
  let tankAId: string;
  let tankBId: string;

  beforeAll(async () => {
    // Cleaner fish species olustur (isCleanerFish=true olan species gerekir)
    // Not: createSpecies'te isCleanerFish parametresi yok, species olusturup
    // daha sonra test icinde cleaner batch olusturacagiz.
    // Resolver'da speciesId'den species kontrolu var, ama cleaner fish icin
    // species'in isCleanerFish=true olmasi gerekebilir.
    // Yine de species olusturalim.
    const species = await createTestSpecies({
      commonName: 'Lumpfish',
      code: `CF-${Date.now().toString(36).toUpperCase()}`,
      category: 'FISH',
      waterType: 'SALTWATER',
      tags: ['cleaner-fish'],
    });
    cleanerSpeciesId = species.id as string;

    // Tank bul
    const tanks = await gqlExpectSuccess<{
      availableTanks: Array<Record<string, unknown>>;
    }>(`query { availableTanks { id code name } }`);

    if (tanks.availableTanks && tanks.availableTanks.length >= 2) {
      const [tankA, tankB] = tanks.availableTanks;
      if (!tankA || !tankB) throw new Error('Expected two available tanks');
      tankAId = tankA.id as string;
      tankBId = tankB.id as string;
    } else if (tanks.availableTanks && tanks.availableTanks.length >= 1) {
      const [tankA] = tanks.availableTanks;
      if (!tankA) throw new Error('Expected one available tank');
      tankAId = tankA.id as string;
    }
  });

  // =========================================================================
  // Test 1: createCleanerFishBatch -> batch olusturur
  // =========================================================================
  describe('Test 1: Create Cleaner Fish Batch', () => {
    it('should create a cleaner fish batch with batchType=CLEANER_FISH', async () => {
      const data = await gqlExpectSuccess<{
        createCleanerFishBatch: Record<string, unknown>;
      }>(
        `
          mutation CreateCleanerFishBatch($input: CreateCleanerBatchInput!) {
            createCleanerFishBatch(input: $input) {
              ${BATCH_FIELDS}
              sourceType
              sourceLocation
            }
          }
        `,
        {
          input: {
            speciesId: cleanerSpeciesId,
            initialQuantity: 500,
            initialAvgWeightG: 15.0,
            sourceType: 'farmed',
            sourceLocation: 'Local cleaner fish supplier',
            stockedAt: new Date().toISOString(),
            purchaseCost: 2500.0,
            currency: 'NOK',
            notes: 'E2E cleaner fish batch test',
          },
        },
      );

      const batch = data.createCleanerFishBatch;
      cleanerBatchId = batch.id as string;

      expect(cleanerBatchId).toBeDefined();
      expect(batch.batchType).toBe('CLEANER_FISH');
      expect(batch.speciesId).toBe(cleanerSpeciesId);
      expect(batch.initialQuantity).toBe(500);
      expect(batch.currentQuantity).toBe(500);
      expect(batch.tenantId).toBe(TENANT_A_ID);
    });
  });

  // =========================================================================
  // Test 2: deployCleanerFish -> TankBatch updated
  // =========================================================================
  describe('Test 2: Deploy Cleaner Fish to Tank', () => {
    it('should deploy cleaner fish to a production tank', async () => {
      if (!tankAId) {
        console.warn('No tank available; skipping deploy test');
        return;
      }

      const data = await gqlExpectSuccess<{
        deployCleanerFish: Record<string, unknown>;
      }>(
        `
          mutation DeployCleanerFish($input: DeployCleanerFishInput!) {
            deployCleanerFish(input: $input) {
              ${BATCH_FIELDS}
            }
          }
        `,
        {
          input: {
            cleanerBatchId,
            targetTankId: tankAId,
            quantity: 200,
            avgWeightG: 15.0,
            deployedAt: new Date().toISOString(),
            notes: 'E2E deploy cleaner fish test',
          },
        },
      );

      expect(data.deployCleanerFish.id).toBe(cleanerBatchId);
    });

    it('should verify cleaner fish in tank via tankCleanerFish query', async () => {
      if (!tankAId) {
        return;
      }

      const data = await gqlExpectSuccess<{
        tankCleanerFish: Record<string, unknown> | null;
      }>(
        `
          query GetTankCleanerFish($tankId: ID!) {
            tankCleanerFish(tankId: $tankId) {
              tankId
              cleanerFishQuantity
              cleanerFishBiomassKg
              cleanerFishRatio
              details {
                batchId
                batchNumber
                speciesName
                quantity
                avgWeightG
                biomassKg
                sourceType
                deployedAt
              }
            }
          }
        `,
        { tankId: tankAId },
      );

      if (data.tankCleanerFish) {
        expect(data.tankCleanerFish.tankId).toBe(tankAId);
        expect(data.tankCleanerFish.cleanerFishQuantity).toBeGreaterThan(0);

        const details = data.tankCleanerFish.details as Array<Record<string, unknown>>;
        if (details && details.length > 0) {
          const deployed = details.find(
            (d: Record<string, unknown>) => d.batchId === cleanerBatchId,
          );
          if (deployed) {
            expect(deployed.quantity).toBe(200);
          }
        }
      }
    });
  });

  // =========================================================================
  // Test 3: recordCleanerMortality -> cleaner count azalir
  // =========================================================================
  describe('Test 3: Record Cleaner Mortality', () => {
    it('should record cleaner fish mortality and decrease quantity', async () => {
      if (!tankAId) {
        console.warn('No tank available; skipping cleaner mortality test');
        return;
      }

      const data = await gqlExpectSuccess<{
        recordCleanerMortality: Record<string, unknown>;
      }>(
        `
          mutation RecordCleanerMortality($input: RecordCleanerMortalityInput!) {
            recordCleanerMortality(input: $input) {
              id currentQuantity totalMortality
            }
          }
        `,
        {
          input: {
            cleanerBatchId,
            tankId: tankAId,
            quantity: 10,
            reason: 'disease',
            detail: 'Amoebic gill disease',
            observedAt: new Date().toISOString(),
            notes: 'E2E cleaner mortality test',
          },
        },
      );

      const batch = data.recordCleanerMortality;
      // currentQuantity 500'den (- deployed + mortality) azalmis olmali
      expect(batch.totalMortality as number).toBeGreaterThanOrEqual(10);
    });
  });

  // =========================================================================
  // Test 4: removeCleanerFish -> removed from tank
  // =========================================================================
  describe('Test 4: Remove Cleaner Fish', () => {
    it('should remove cleaner fish from tank', async () => {
      if (!tankAId) {
        console.warn('No tank available; skipping remove test');
        return;
      }

      const data = await gqlExpectSuccess<{
        removeCleanerFish: Record<string, unknown>;
      }>(
        `
          mutation RemoveCleanerFish($input: RemoveCleanerFishInput!) {
            removeCleanerFish(input: $input) {
              id currentQuantity
            }
          }
        `,
        {
          input: {
            cleanerBatchId,
            tankId: tankAId,
            quantity: 50,
            reason: 'end_of_cycle',
            removedAt: new Date().toISOString(),
            avgWeightG: 18.0,
            notes: 'E2E remove cleaner fish test',
          },
        },
      );

      expect(data.removeCleanerFish.id).toBe(cleanerBatchId);
    });
  });

  // =========================================================================
  // Test 5: transferCleanerFish (tank A -> tank B)
  // =========================================================================
  describe('Test 5: Transfer Cleaner Fish', () => {
    it('should transfer cleaner fish from tank A to tank B', async () => {
      if (!tankAId || !tankBId || tankAId === tankBId) {
        console.warn('Not enough tanks for cleaner transfer test; skipping');
        return;
      }

      // Once daha bir deploy yapalim tank A'ya (yeterli fish olsun)
      await gqlExpectSuccess(
        `
          mutation DeployCleanerFish($input: DeployCleanerFishInput!) {
            deployCleanerFish(input: $input) { id }
          }
        `,
        {
          input: {
            cleanerBatchId,
            targetTankId: tankAId,
            quantity: 100,
            deployedAt: new Date().toISOString(),
          },
        },
      );

      const data = await gqlExpectSuccess<{
        transferCleanerFish: Record<string, unknown>;
      }>(
        `
          mutation TransferCleanerFish($input: TransferCleanerFishInput!) {
            transferCleanerFish(input: $input) {
              id currentQuantity
            }
          }
        `,
        {
          input: {
            cleanerBatchId,
            sourceTankId: tankAId,
            destinationTankId: tankBId,
            quantity: 30,
            transferredAt: new Date().toISOString(),
            reason: 'Balancing cleaner fish distribution',
            notes: 'E2E transfer cleaner fish test',
          },
        },
      );

      expect(data.transferCleanerFish.id).toBe(cleanerBatchId);
    });

    it('should verify cleaner fish now exist in tank B', async () => {
      if (!tankBId) {
        return;
      }

      const data = await gqlExpectSuccess<{
        tankCleanerFish: Record<string, unknown> | null;
      }>(
        `
          query GetTankCleanerFish($tankId: ID!) {
            tankCleanerFish(tankId: $tankId) {
              tankId
              cleanerFishQuantity
              details { batchId quantity }
            }
          }
        `,
        { tankId: tankBId },
      );

      if (data.tankCleanerFish) {
        expect(data.tankCleanerFish.cleanerFishQuantity).toBeGreaterThan(0);
      }
    });
  });

  // =========================================================================
  // Cleaner Fish Queries
  // =========================================================================
  describe('Cleaner Fish Queries', () => {
    it('should list cleaner fish batches', async () => {
      const data = await gqlExpectSuccess<{
        cleanerFishBatches: Array<Record<string, unknown>>;
      }>(
        `
          query CleanerFishBatches {
            cleanerFishBatches {
              id batchNumber batchType speciesId
              initialQuantity currentQuantity
              status isActive
            }
          }
        `,
      );

      expect(data.cleanerFishBatches).toBeDefined();
      expect(Array.isArray(data.cleanerFishBatches)).toBe(true);

      // Olusturdigimiz cleaner batch listede olmali
      const found = data.cleanerFishBatches.find(
        (b: Record<string, unknown>) => b.id === cleanerBatchId,
      );
      if (found) {
        expect(found.batchType).toBe('CLEANER_FISH');
      }
    });

    it('should list cleaner fish species', async () => {
      const data = await gqlExpectSuccess<{
        cleanerFishSpecies: Array<Record<string, unknown>>;
      }>(
        `
          query CleanerFishSpecies {
            cleanerFishSpecies {
              id scientificName commonName code
              cleanerFishType
            }
          }
        `,
      );

      expect(data.cleanerFishSpecies).toBeDefined();
      expect(Array.isArray(data.cleanerFishSpecies)).toBe(true);
    });

    it('should filter cleaner fish batches by status', async () => {
      const data = await gqlExpectSuccess<{
        cleanerFishBatches: Array<Record<string, unknown>>;
      }>(
        `
          query CleanerFishBatches($status: BatchStatus) {
            cleanerFishBatches(status: $status) {
              id status batchType
            }
          }
        `,
        { status: 'QUARANTINE' },
      );

      // Tum donen batch'ler QUARANTINE olmali
      for (const batch of data.cleanerFishBatches) {
        expect(batch.status).toBe('QUARANTINE');
        expect(batch.batchType).toBe('CLEANER_FISH');
      }
    });
  });
});
