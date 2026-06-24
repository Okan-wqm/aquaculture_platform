/**
 * Batch Full Lifecycle E2E Tests
 *
 * Batch'in dogumundan olumune kadar TAM yasam dongusunu test eder.
 * Bu test suite farm-service'in EN KRiTiK testi olup asagidaki adimlari kapsar:
 *
 * 1.  createSpecies (prerequisite)
 * 2.  createBatch(speciesId, inputType=FRY) -> status=QUARANTINE
 * 3.  batchNumber auto-generated dogrula (B-2024-XXXXX pattern)
 * 4.  allocateBatchToTank(batchId, tankId) -> BatchLocation olusur
 * 5.  updateBatchStatus -> ACTIVE (valid transition)
 * 6.  updateBatchStatus -> GROWING
 * 7.  recordMortality(batchId, count, cause) -> currentQuantity azalir
 * 8.  transferBatch(sourceTank -> destTank) -> BatchLocation guncellenir
 * 9.  updateBatchStatus -> PRE_HARVEST
 * 10. updateBatchStatus -> HARVESTING
 * 11. updateBatchStatus -> HARVESTED
 * 12. closeBatch -> CLOSED (terminal)
 * 13. CLOSED'dan baska state'e gecis -> REJECT
 *
 * @module E2E/Farm/BatchLifecycle
 */
import {
  gqlExpectSuccess,
  gqlExpectError,
  TENANT_A_ID,
  TENANT_B_ID,
  USER_B_ID,
  BATCH_FIELDS,
  createTestSpecies,
} from './test-helpers';

describe('Batch Full Lifecycle E2E', () => {
  let speciesId: string;
  let batchId: string;
  let batchNumber: string;
  let tankId: string;
  let destTankId: string;

  // =========================================================================
  // Step 1: createSpecies (prerequisite)
  // =========================================================================
  describe('Step 1: Create prerequisite species', () => {
    it('should create a species for batch tests', async () => {
      const species = await createTestSpecies({
        commonName: 'Lifecycle Test Seabass',
        category: 'FISH',
        waterType: 'SALTWATER',
      });

      speciesId = species.id as string;
      expect(speciesId).toBeDefined();
    });
  });

  // =========================================================================
  // Step 2: createBatch -> status=QUARANTINE
  // =========================================================================
  describe('Step 2: Create batch', () => {
    it('should create a batch with status QUARANTINE', async () => {
      const data = await gqlExpectSuccess<{ createBatch: Record<string, unknown> }>(
        `
          mutation CreateBatch($input: CreateBatchInput!) {
            createBatch(input: $input) {
              ${BATCH_FIELDS}
            }
          }
        `,
        {
          input: {
            name: 'Lifecycle Batch',
            speciesId,
            inputType: 'FRY',
            initialQuantity: 10000,
            initialWeight: {
              avgWeight: 5.0,
              totalBiomass: 50.0,
            },
            stockedAt: new Date().toISOString().split('T')[0],
            targetFCR: 1.5,
            initialLocations: [],
            notes: 'Full lifecycle test batch',
          },
        },
      );

      const batch = data.createBatch;
      batchId = batch.id as string;
      batchNumber = batch.batchNumber as string;

      expect(batchId).toBeDefined();
      expect(batch.speciesId).toBe(speciesId);
      expect(batch.inputType).toBe('FRY');
      expect(batch.initialQuantity).toBe(10000);
      expect(batch.currentQuantity).toBe(10000);
      expect(batch.status).toBe('QUARANTINE');
      expect(batch.isActive).toBe(true);
      expect(batch.tenantId).toBe(TENANT_A_ID);
    });
  });

  // =========================================================================
  // Step 3: batchNumber auto-generated dogrula
  // =========================================================================
  describe('Step 3: Batch number format', () => {
    it('should have auto-generated batchNumber matching B-YYYY-XXXXX pattern', () => {
      expect(batchNumber).toBeDefined();
      expect(batchNumber).toMatch(/^B-\d{4}-\d{5}$/);
    });

    it('should verify batch via query returns the same batchNumber', async () => {
      const data = await gqlExpectSuccess<{ batch: Record<string, unknown> }>(
        `
          query GetBatch($id: ID!) {
            batch(id: $id) {
              id batchNumber status
            }
          }
        `,
        { id: batchId },
      );

      expect(data.batch.batchNumber).toBe(batchNumber);
    });

    it('generateBatchNumber should return a unique number', async () => {
      const data = await gqlExpectSuccess<{ generateBatchNumber: string }>(
        `
          query GenerateBatchNumber {
            generateBatchNumber
          }
        `,
      );

      expect(data.generateBatchNumber).toMatch(/^B-\d{4}-\d{5}$/);
      expect(data.generateBatchNumber).not.toBe(batchNumber);
    });
  });

  // =========================================================================
  // Step 4: allocateBatchToTank -> BatchLocation olusur
  // =========================================================================
  describe('Step 4: Allocate batch to tank', () => {
    beforeAll(async () => {
      // availableTanks sorgula -- bir tank ID al
      const data = await gqlExpectSuccess<{
        availableTanks: Array<Record<string, unknown>>;
      }>(
        `
          query AvailableTanks {
            availableTanks {
              id code name volume
            }
          }
        `,
      );

      if (data.availableTanks && data.availableTanks.length >= 2) {
        const [sourceTank, destinationTank] = data.availableTanks;
        if (!sourceTank || !destinationTank) throw new Error('Expected two available tanks');
        tankId = sourceTank.id as string;
        destTankId = destinationTank.id as string;
      } else if (data.availableTanks && data.availableTanks.length === 1) {
        const [sourceTank] = data.availableTanks;
        if (!sourceTank) throw new Error('Expected one available tank');
        tankId = sourceTank.id as string;
        destTankId = tankId; // fallback: ayni tank
      }
    });

    it('should allocate batch to a tank', async () => {
      if (!tankId) {
        console.warn('No available tanks found; skipping tank allocation test');
        return;
      }

      const data = await gqlExpectSuccess<{
        allocateBatchToTank: Record<string, unknown>;
      }>(
        `
          mutation AllocateToTank($input: AllocateToTankInput!) {
            allocateBatchToTank(input: $input) {
              ${BATCH_FIELDS}
            }
          }
        `,
        {
          input: {
            batchId,
            tankId,
            quantity: 10000,
            avgWeightG: 5.0,
            allocationType: 'INITIAL_STOCKING',
          },
        },
      );

      expect(data.allocateBatchToTank.id).toBe(batchId);
    });
  });

  // =========================================================================
  // Step 5: updateBatchStatus -> ACTIVE
  // =========================================================================
  describe('Step 5: QUARANTINE -> ACTIVE', () => {
    it('should transition batch from QUARANTINE to ACTIVE', async () => {
      const data = await gqlExpectSuccess<{
        updateBatchStatus: Record<string, unknown>;
      }>(
        `
          mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!, $reason: String) {
            updateBatchStatus(id: $id, status: $status, reason: $reason) {
              ${BATCH_FIELDS}
            }
          }
        `,
        {
          id: batchId,
          status: 'ACTIVE',
          reason: 'Quarantine period completed, health check passed',
        },
      );

      expect(data.updateBatchStatus.id).toBe(batchId);
      expect(data.updateBatchStatus.status).toBe('ACTIVE');
      expect(data.updateBatchStatus.statusChangedAt).toBeDefined();
    });
  });

  // =========================================================================
  // Step 6: updateBatchStatus -> GROWING
  // =========================================================================
  describe('Step 6: ACTIVE -> GROWING', () => {
    it('should transition batch from ACTIVE to GROWING', async () => {
      const data = await gqlExpectSuccess<{
        updateBatchStatus: Record<string, unknown>;
      }>(
        `
          mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!) {
            updateBatchStatus(id: $id, status: $status) {
              id status
            }
          }
        `,
        { id: batchId, status: 'GROWING' },
      );

      expect(data.updateBatchStatus.status).toBe('GROWING');
    });
  });

  // =========================================================================
  // Step 7: recordMortality -> currentQuantity azalir
  // =========================================================================
  describe('Step 7: Record mortality', () => {
    it('should record mortality and decrease currentQuantity', async () => {
      if (!tankId) {
        console.warn('No tank allocated; skipping mortality test');
        return;
      }

      // onceki deger
      const before = await gqlExpectSuccess<{ batch: Record<string, unknown> }>(
        `query { batch(id: "${batchId}") { currentQuantity totalMortality } }`,
      );
      const prevQuantity = before.batch.currentQuantity as number;

      const mortalityCount = 50;

      const data = await gqlExpectSuccess<{
        recordMortality: Record<string, unknown>;
      }>(
        `
          mutation RecordMortality($input: RecordMortalityInput!) {
            recordMortality(input: $input) {
              id currentQuantity totalMortality
            }
          }
        `,
        {
          input: {
            batchId,
            tankId,
            quantity: mortalityCount,
            reason: 'DISEASE',
            detail: 'Bacterial infection in tank',
            observedAt: new Date().toISOString(),
            notes: 'E2E lifecycle mortality test',
          },
        },
      );

      expect(data.recordMortality.currentQuantity).toBe(prevQuantity - mortalityCount);
      expect(data.recordMortality.totalMortality).toBeGreaterThanOrEqual(mortalityCount);
    });
  });

  // =========================================================================
  // Step 8: transferBatch -> BatchLocation guncellenir
  // =========================================================================
  describe('Step 8: Transfer batch between tanks', () => {
    it('should transfer batch from source tank to destination tank', async () => {
      if (!tankId || !destTankId || tankId === destTankId) {
        console.warn('Not enough tanks for transfer test; skipping');
        return;
      }

      const data = await gqlExpectSuccess<{
        transferBatch: Record<string, unknown>;
      }>(
        `
          mutation TransferBatch($input: TransferBatchInput!) {
            transferBatch(input: $input) {
              ${BATCH_FIELDS}
            }
          }
        `,
        {
          input: {
            batchId,
            sourceTankId: tankId,
            destinationTankId: destTankId,
            quantity: 2000,
            avgWeightG: 8.0,
            transferredAt: new Date().toISOString(),
            transferReason: 'Density management',
            notes: 'E2E lifecycle transfer test',
          },
        },
      );

      expect(data.transferBatch.id).toBe(batchId);
    });
  });

  // =========================================================================
  // Step 9: updateBatchStatus -> PRE_HARVEST
  // =========================================================================
  describe('Step 9: GROWING -> PRE_HARVEST', () => {
    it('should transition batch to PRE_HARVEST', async () => {
      const data = await gqlExpectSuccess<{
        updateBatchStatus: Record<string, unknown>;
      }>(
        `
          mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!) {
            updateBatchStatus(id: $id, status: $status) {
              id status
            }
          }
        `,
        { id: batchId, status: 'PRE_HARVEST' },
      );

      expect(data.updateBatchStatus.status).toBe('PRE_HARVEST');
    });
  });

  // =========================================================================
  // Step 10: updateBatchStatus -> HARVESTING
  // =========================================================================
  describe('Step 10: PRE_HARVEST -> HARVESTING', () => {
    it('should transition batch to HARVESTING', async () => {
      const data = await gqlExpectSuccess<{
        updateBatchStatus: Record<string, unknown>;
      }>(
        `
          mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!) {
            updateBatchStatus(id: $id, status: $status) {
              id status
            }
          }
        `,
        { id: batchId, status: 'HARVESTING' },
      );

      expect(data.updateBatchStatus.status).toBe('HARVESTING');
    });
  });

  // =========================================================================
  // Step 11: updateBatchStatus -> HARVESTED
  // =========================================================================
  describe('Step 11: HARVESTING -> HARVESTED', () => {
    it('should transition batch to HARVESTED', async () => {
      const data = await gqlExpectSuccess<{
        updateBatchStatus: Record<string, unknown>;
      }>(
        `
          mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!) {
            updateBatchStatus(id: $id, status: $status) {
              id status
            }
          }
        `,
        { id: batchId, status: 'HARVESTED' },
      );

      expect(data.updateBatchStatus.status).toBe('HARVESTED');
    });
  });

  // =========================================================================
  // Step 12: closeBatch -> CLOSED (terminal)
  // =========================================================================
  describe('Step 12: Close batch', () => {
    it('should close batch with HARVEST_COMPLETED reason', async () => {
      const data = await gqlExpectSuccess<{
        closeBatch: Record<string, unknown>;
      }>(
        `
          mutation CloseBatch($id: ID!, $reason: BatchCloseReason!, $notes: String) {
            closeBatch(id: $id, reason: $reason, notes: $notes) {
              ${BATCH_FIELDS}
            }
          }
        `,
        {
          id: batchId,
          reason: 'HARVEST_COMPLETED',
          notes: 'Full lifecycle test completed',
        },
      );

      expect(data.closeBatch.id).toBe(batchId);
      expect(data.closeBatch.status).toBe('CLOSED');
    });
  });

  // =========================================================================
  // Step 13: CLOSED'dan baska state'e gecis -> REJECT
  // =========================================================================
  describe('Step 13: CLOSED is terminal', () => {
    it('should reject transition from CLOSED to ACTIVE', async () => {
      const errors = await gqlExpectError(
        `
          mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!) {
            updateBatchStatus(id: $id, status: $status) {
              id status
            }
          }
        `,
        { id: batchId, status: 'ACTIVE' },
      );

      expect(errors.length).toBeGreaterThan(0);
      const msg = errors.map((e) => e.message.toLowerCase()).join(' ');
      expect(
        msg.includes('invalid') ||
          msg.includes('gecersiz') ||
          msg.includes('transition') ||
          msg.includes('gecis') ||
          msg.includes('cannot'),
      ).toBe(true);
    });

    it('should reject transition from CLOSED to GROWING', async () => {
      const errors = await gqlExpectError(
        `
          mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!) {
            updateBatchStatus(id: $id, status: $status) { id status }
          }
        `,
        { id: batchId, status: 'GROWING' },
      );

      expect(errors.length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Cross-tenant: Tenant B bu batch'i goremez
  // =========================================================================
  describe('Cross-tenant isolation', () => {
    it('should NOT return batch to Tenant B', async () => {
      const errors = await gqlExpectError(
        `
          query GetBatch($id: ID!) {
            batch(id: $id) { id tenantId }
          }
        `,
        { id: batchId },
        TENANT_B_ID,
        USER_B_ID,
      );

      expect(errors.length).toBeGreaterThan(0);
    });

    it('should NOT include batch in Tenant B batches list', async () => {
      const data = await gqlExpectSuccess<{
        batches: { items: Array<Record<string, unknown>> };
      }>(
        `
          query ListBatches {
            batches {
              items { id tenantId }
            }
          }
        `,
        {},
        TENANT_B_ID,
        USER_B_ID,
      );

      const leak = data.batches.items.find((b: Record<string, unknown>) => b.id === batchId);
      expect(leak).toBeUndefined();
    });
  });

  // =========================================================================
  // DB dogrulamasi: Final state verification
  // =========================================================================
  describe('Final DB verification', () => {
    it('should verify final batch state via query', async () => {
      const data = await gqlExpectSuccess<{ batch: Record<string, unknown> }>(
        `
          query GetBatch($id: ID!) {
            batch(id: $id) {
              ${BATCH_FIELDS}
            }
          }
        `,
        { id: batchId },
      );

      const batch = data.batch;
      expect(batch.status).toBe('CLOSED');
      expect(batch.initialQuantity).toBe(10000);
      // currentQuantity < initialQuantity (mortality dusulmus)
      expect(batch.currentQuantity as number).toBeLessThan(10000);
      expect(batch.totalMortality as number).toBeGreaterThan(0);
    });
  });
});
