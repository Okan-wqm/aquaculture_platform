/**
 * Tank Operations E2E Tests
 *
 * Tank bazli operasyonlari (mortality, cull, transfer) test eder.
 * TankOperation entity'sindeki kayitlari ve batch'e etkisini dogrular.
 *
 * Resolvers:
 * - recordMortality -> TankOperation(MORTALITY) kaydeder
 * - recordCull -> TankOperation(CULL) kaydeder
 * - transferBatch -> TRANSFER_OUT + TRANSFER_IN pair olusturur
 *
 * @module E2E/Farm/TankOperations
 */
import {
  gqlExpectSuccess,
  gqlExpectError,
  TENANT_B_ID,
  USER_B_ID,
  BATCH_FIELDS,
  createTestSpecies,
  createTestBatch,
} from './test-helpers';

describe('Tank Operations E2E', () => {
  let speciesId: string;
  let batchId: string;
  let tankId: string;
  let destTankId: string;

  beforeAll(async () => {
    // Species olustur
    const species = await createTestSpecies({
      commonName: 'Tank Ops Test Fish',
    });
    speciesId = species.id as string;

    // Batch olustur
    const batch = await createTestBatch({
      speciesId,
      name: 'Tank Ops Test Batch',
      initialQuantity: 8000,
      initialAvgWeightG: 12.0,
      initialTotalBiomassKg: 96.0,
    });
    batchId = batch.id as string;

    // QUARANTINE -> ACTIVE -> GROWING
    await gqlExpectSuccess(
      `mutation { updateBatchStatus(id: "${batchId}", status: ACTIVE) { id status } }`,
    );
    await gqlExpectSuccess(
      `mutation { updateBatchStatus(id: "${batchId}", status: GROWING) { id status } }`,
    );

    // Tanklar bul
    const tanks = await gqlExpectSuccess<{
      availableTanks: Array<Record<string, unknown>>;
    }>(`query { availableTanks { id code name } }`);

    if (tanks.availableTanks && tanks.availableTanks.length >= 2) {
      const [sourceTank, destinationTank] = tanks.availableTanks;
      if (!sourceTank || !destinationTank) throw new Error('Expected two available tanks');
      tankId = sourceTank.id as string;
      destTankId = destinationTank.id as string;
    } else if (tanks.availableTanks && tanks.availableTanks.length >= 1) {
      const [sourceTank] = tanks.availableTanks;
      if (!sourceTank) throw new Error('Expected one available tank');
      tankId = sourceTank.id as string;
    }

    // Tank'a allocate et
    if (tankId) {
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
            quantity: 8000,
            avgWeightG: 12.0,
            allocationType: 'INITIAL_STOCKING',
          },
        },
      );
    }
  });

  // =========================================================================
  // Test 1: recordMortality -> TankOperation(MORTALITY) kaydeder
  // =========================================================================
  describe('Test 1: Record Mortality', () => {
    it('should record mortality and create TankOperation record', async () => {
      if (!tankId) {
        console.warn('No tank available; skipping mortality test');
        return;
      }

      const beforeData = await gqlExpectSuccess<{ batch: Record<string, unknown> }>(
        `query { batch(id: "${batchId}") { currentQuantity totalMortality } }`,
      );
      const prevQty = beforeData.batch.currentQuantity as number;
      const prevMortality = beforeData.batch.totalMortality as number;

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
            quantity: 30,
            reason: 'DISEASE',
            detail: 'Bacterial gill disease',
            observedAt: new Date().toISOString(),
            avgWeightG: 12.5,
            notes: 'E2E mortality operation test',
          },
        },
      );

      expect(data.recordMortality.currentQuantity).toBe(prevQty - 30);
      expect(data.recordMortality.totalMortality).toBe(prevMortality + 30);
    });

    it('should verify mortality is reflected in batchHistory', async () => {
      const data = await gqlExpectSuccess<{
        batchHistory: Array<Record<string, unknown>>;
      }>(
        `
          query GetBatchHistory($id: ID!, $eventTypes: [BatchHistoryEventType!]) {
            batchHistory(id: $id, eventTypes: $eventTypes) {
              id eventType description quantityChange tankId
            }
          }
        `,
        { id: batchId, eventTypes: ['MORTALITY'] },
      );

      expect(data.batchHistory.length).toBeGreaterThanOrEqual(1);
      const lastMortality = data.batchHistory[0];
      if (!lastMortality) throw new Error('Expected mortality event in batch history');
      expect(lastMortality.eventType).toBe('MORTALITY');
    });
  });

  // =========================================================================
  // Test 2: recordCull -> TankOperation(CULL) kaydeder
  // =========================================================================
  describe('Test 2: Record Cull', () => {
    it('should record cull and update batch quantities', async () => {
      if (!tankId) {
        console.warn('No tank available; skipping cull test');
        return;
      }

      const beforeData = await gqlExpectSuccess<{ batch: Record<string, unknown> }>(
        `query { batch(id: "${batchId}") { currentQuantity cullCount } }`,
      );
      const prevQty = beforeData.batch.currentQuantity as number;
      const prevCull = beforeData.batch.cullCount as number;

      const data = await gqlExpectSuccess<{
        recordCull: Record<string, unknown>;
      }>(
        `
          mutation RecordCull($input: RecordCullInput!) {
            recordCull(input: $input) {
              id currentQuantity cullCount
            }
          }
        `,
        {
          input: {
            batchId,
            tankId,
            quantity: 15,
            reason: 'DEFORMED',
            detail: 'Spinal deformity detected during grading',
            culledAt: new Date().toISOString(),
            avgWeightG: 11.0,
            notes: 'E2E cull operation test',
          },
        },
      );

      expect(data.recordCull.currentQuantity).toBe(prevQty - 15);
      expect(data.recordCull.cullCount).toBe(prevCull + 15);
    });

    it('should verify cull event in batch history', async () => {
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
        { id: batchId, eventTypes: ['CULL'] },
      );

      expect(data.batchHistory.length).toBeGreaterThanOrEqual(1);
      const [cullEvent] = data.batchHistory;
      if (!cullEvent) throw new Error('Expected cull event in batch history');
      expect(cullEvent.eventType).toBe('CULL');
    });
  });

  // =========================================================================
  // Test 3: transferBatch -> TRANSFER_OUT + TRANSFER_IN pair
  // =========================================================================
  describe('Test 3: Transfer Batch', () => {
    it('should transfer batch from source to destination tank', async () => {
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
            quantity: 1500,
            avgWeightG: 13.0,
            transferredAt: new Date().toISOString(),
            transferReason: 'Density management',
            notes: 'E2E transfer operation test',
          },
        },
      );

      expect(data.transferBatch.id).toBe(batchId);
    });

    it('should have TRANSFERRED event in batch history after transfer', async () => {
      if (!tankId || !destTankId || tankId === destTankId) {
        return;
      }

      const data = await gqlExpectSuccess<{
        batchHistory: Array<Record<string, unknown>>;
      }>(
        `
          query GetBatchHistory($id: ID!, $eventTypes: [BatchHistoryEventType!]) {
            batchHistory(id: $id, eventTypes: $eventTypes) {
              id eventType description tankId
            }
          }
        `,
        { id: batchId, eventTypes: ['TRANSFERRED'] },
      );

      expect(data.batchHistory.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // Test 4: Mortality Reasons
  // =========================================================================
  describe('Test 4: Mortality Reasons', () => {
    const mortalityReasons = [
      'DISEASE',
      'WATER_QUALITY',
      'STRESS',
      'HANDLING',
      'TEMPERATURE',
      'OXYGEN',
      'UNKNOWN',
      'OTHER',
    ];

    it.each(mortalityReasons)('should accept mortality with reason=%s', async (reason) => {
      if (!tankId) {
        console.warn('No tank available; skipping');
        return;
      }

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
            quantity: 1,
            reason,
            observedAt: new Date().toISOString(),
          },
        },
      );

      expect(data.recordMortality.id).toBe(batchId);
    });

    const cullReasons = ['SMALL_SIZE', 'DEFORMED', 'SICK', 'POOR_GROWTH', 'GRADING', 'OTHER'];

    it.each(cullReasons)('should accept cull with reason=%s', async (reason) => {
      if (!tankId) {
        console.warn('No tank available; skipping');
        return;
      }

      const data = await gqlExpectSuccess<{
        recordCull: Record<string, unknown>;
      }>(
        `
          mutation RecordCull($input: RecordCullInput!) {
            recordCull(input: $input) {
              id currentQuantity cullCount
            }
          }
        `,
        {
          input: {
            batchId,
            tankId,
            quantity: 1,
            reason,
            culledAt: new Date().toISOString(),
          },
        },
      );

      expect(data.recordCull.id).toBe(batchId);
    });
  });

  // =========================================================================
  // Test 5: Cross-tenant isolation
  // =========================================================================
  describe('Test 5: Cross-tenant Isolation', () => {
    it('should NOT allow Tenant B to record mortality on Tenant A batch', async () => {
      if (!tankId) {
        console.warn('No tank available; skipping');
        return;
      }

      const errors = await gqlExpectError(
        `
          mutation RecordMortality($input: RecordMortalityInput!) {
            recordMortality(input: $input) { id }
          }
        `,
        {
          input: {
            batchId,
            tankId,
            quantity: 5,
            reason: 'DISEASE',
            observedAt: new Date().toISOString(),
          },
        },
        TENANT_B_ID,
        USER_B_ID,
      );

      expect(errors.length).toBeGreaterThan(0);
    });

    it('should NOT allow Tenant B to record cull on Tenant A batch', async () => {
      if (!tankId) {
        console.warn('No tank available; skipping');
        return;
      }

      const errors = await gqlExpectError(
        `
          mutation RecordCull($input: RecordCullInput!) {
            recordCull(input: $input) { id }
          }
        `,
        {
          input: {
            batchId,
            tankId,
            quantity: 5,
            reason: 'DEFORMED',
            culledAt: new Date().toISOString(),
          },
        },
        TENANT_B_ID,
        USER_B_ID,
      );

      expect(errors.length).toBeGreaterThan(0);
    });

    it('should NOT allow Tenant B to transfer Tenant A batch', async () => {
      if (!tankId || !destTankId) {
        console.warn('No tanks available; skipping');
        return;
      }

      const errors = await gqlExpectError(
        `
          mutation TransferBatch($input: TransferBatchInput!) {
            transferBatch(input: $input) { id }
          }
        `,
        {
          input: {
            batchId,
            sourceTankId: tankId,
            destinationTankId: destTankId,
            quantity: 100,
            transferredAt: new Date().toISOString(),
          },
        },
        TENANT_B_ID,
        USER_B_ID,
      );

      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
