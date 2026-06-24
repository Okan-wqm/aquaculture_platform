/**
 * Batch Status Machine E2E Tests
 *
 * Batch status gecislerini (state machine) test eder.
 * Valid ve invalid transition'lari ayri ayri dogrular.
 *
 * Valid transitions (batch.entity.ts canTransitionTo'dan):
 *   QUARANTINE -> ACTIVE, FAILED
 *   ACTIVE     -> GROWING, TRANSFERRED, FAILED
 *   GROWING    -> PRE_HARVEST, TRANSFERRED, FAILED
 *   PRE_HARVEST -> HARVESTING, GROWING, FAILED
 *   HARVESTING -> HARVESTED, FAILED
 *   HARVESTED  -> CLOSED
 *   TRANSFERRED -> CLOSED
 *   FAILED     -> CLOSED
 *   CLOSED     -> (hicbir sey - terminal)
 *
 * @module E2E/Farm/BatchStatusTransitions
 */
import {
  gqlExpectSuccess,
  gqlExpectError,
  createTestSpecies,
  createTestBatch,
} from './test-helpers';

// Helper: yeni batch olustur (her test icin temiz QUARANTINE batch)
async function createFreshBatch(speciesId: string): Promise<string> {
  const batch = await createTestBatch({ speciesId });
  expect(batch.status).toBe('QUARANTINE');
  return batch.id as string;
}

// Helper: batch status'unu degistir
async function transitionTo(
  batchId: string,
  status: string,
  reason?: string,
): Promise<Record<string, unknown>> {
  const data = await gqlExpectSuccess<{
    updateBatchStatus: Record<string, unknown>;
  }>(
    `
      mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!, $reason: String) {
        updateBatchStatus(id: $id, status: $status, reason: $reason) {
          id status statusChangedAt statusReason
        }
      }
    `,
    { id: batchId, status, reason },
  );
  return data.updateBatchStatus;
}

// Helper: batch status degisimi reject olmasini bekle
async function expectTransitionReject(batchId: string, status: string): Promise<void> {
  const errors = await gqlExpectError(
    `
      mutation UpdateBatchStatus($id: ID!, $status: BatchStatus!) {
        updateBatchStatus(id: $id, status: $status) {
          id status
        }
      }
    `,
    { id: batchId, status },
  );

  expect(errors.length).toBeGreaterThan(0);
  const msg = errors.map((e) => e.message.toLowerCase()).join(' ');
  expect(
    msg.includes('invalid') ||
      msg.includes('gecersiz') ||
      msg.includes('transition') ||
      msg.includes('gecis') ||
      msg.includes('cannot') ||
      msg.includes('gecem'),
  ).toBe(true);
}

describe('Batch Status Machine E2E', () => {
  let speciesId: string;

  beforeAll(async () => {
    const species = await createTestSpecies({
      commonName: 'Status Machine Test Fish',
    });
    speciesId = species.id as string;
  });

  // =========================================================================
  // VALID TRANSITIONS
  // =========================================================================
  describe('Valid Transitions', () => {
    it('QUARANTINE -> ACTIVE (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      const result = await transitionTo(batchId, 'ACTIVE', 'Health check passed');
      expect(result.status).toBe('ACTIVE');
    });

    it('QUARANTINE -> FAILED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      const result = await transitionTo(batchId, 'FAILED', 'Mass mortality in quarantine');
      expect(result.status).toBe('FAILED');
    });

    it('ACTIVE -> GROWING (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      const result = await transitionTo(batchId, 'GROWING');
      expect(result.status).toBe('GROWING');
    });

    it('ACTIVE -> TRANSFERRED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      const result = await transitionTo(batchId, 'TRANSFERRED', 'Batch moved to other site');
      expect(result.status).toBe('TRANSFERRED');
    });

    it('ACTIVE -> FAILED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      const result = await transitionTo(batchId, 'FAILED', 'Disease outbreak');
      expect(result.status).toBe('FAILED');
    });

    it('GROWING -> PRE_HARVEST (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      const result = await transitionTo(batchId, 'PRE_HARVEST');
      expect(result.status).toBe('PRE_HARVEST');
    });

    it('GROWING -> TRANSFERRED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      const result = await transitionTo(batchId, 'TRANSFERRED');
      expect(result.status).toBe('TRANSFERRED');
    });

    it('GROWING -> FAILED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      const result = await transitionTo(batchId, 'FAILED');
      expect(result.status).toBe('FAILED');
    });

    it('PRE_HARVEST -> HARVESTING (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await transitionTo(batchId, 'PRE_HARVEST');
      const result = await transitionTo(batchId, 'HARVESTING');
      expect(result.status).toBe('HARVESTING');
    });

    it('PRE_HARVEST -> GROWING (valid — go back)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await transitionTo(batchId, 'PRE_HARVEST');
      const result = await transitionTo(batchId, 'GROWING', 'Not ready for harvest yet');
      expect(result.status).toBe('GROWING');
    });

    it('PRE_HARVEST -> FAILED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await transitionTo(batchId, 'PRE_HARVEST');
      const result = await transitionTo(batchId, 'FAILED');
      expect(result.status).toBe('FAILED');
    });

    it('HARVESTING -> HARVESTED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await transitionTo(batchId, 'PRE_HARVEST');
      await transitionTo(batchId, 'HARVESTING');
      const result = await transitionTo(batchId, 'HARVESTED');
      expect(result.status).toBe('HARVESTED');
    });

    it('HARVESTING -> FAILED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await transitionTo(batchId, 'PRE_HARVEST');
      await transitionTo(batchId, 'HARVESTING');
      const result = await transitionTo(batchId, 'FAILED');
      expect(result.status).toBe('FAILED');
    });

    it('HARVESTED -> CLOSED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await transitionTo(batchId, 'PRE_HARVEST');
      await transitionTo(batchId, 'HARVESTING');
      await transitionTo(batchId, 'HARVESTED');

      // closeBatch mutation kullan
      const data = await gqlExpectSuccess<{
        closeBatch: Record<string, unknown>;
      }>(
        `
          mutation CloseBatch($id: ID!, $reason: BatchCloseReason!) {
            closeBatch(id: $id, reason: $reason) {
              id status
            }
          }
        `,
        { id: batchId, reason: 'HARVEST_COMPLETED' },
      );
      expect(data.closeBatch.status).toBe('CLOSED');
    });

    it('TRANSFERRED -> CLOSED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'TRANSFERRED');

      const data = await gqlExpectSuccess<{
        closeBatch: Record<string, unknown>;
      }>(
        `
          mutation CloseBatch($id: ID!, $reason: BatchCloseReason!) {
            closeBatch(id: $id, reason: $reason) {
              id status
            }
          }
        `,
        { id: batchId, reason: 'TRANSFERRED' },
      );
      expect(data.closeBatch.status).toBe('CLOSED');
    });

    it('FAILED -> CLOSED (valid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'FAILED', 'Total loss');

      const data = await gqlExpectSuccess<{
        closeBatch: Record<string, unknown>;
      }>(
        `
          mutation CloseBatch($id: ID!, $reason: BatchCloseReason!) {
            closeBatch(id: $id, reason: $reason) {
              id status
            }
          }
        `,
        { id: batchId, reason: 'FAILED' },
      );
      expect(data.closeBatch.status).toBe('CLOSED');
    });
  });

  // =========================================================================
  // INVALID TRANSITIONS
  // =========================================================================
  describe('Invalid Transitions', () => {
    it('QUARANTINE -> HARVESTING (invalid — skip stages)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await expectTransitionReject(batchId, 'HARVESTING');
    });

    it('QUARANTINE -> GROWING (invalid — must go through ACTIVE)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await expectTransitionReject(batchId, 'GROWING');
    });

    it('QUARANTINE -> PRE_HARVEST (invalid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await expectTransitionReject(batchId, 'PRE_HARVEST');
    });

    it('QUARANTINE -> HARVESTED (invalid)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await expectTransitionReject(batchId, 'HARVESTED');
    });

    it('QUARANTINE -> CLOSED (invalid — not terminal from QUARANTINE)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await expectTransitionReject(batchId, 'CLOSED');
    });

    it('CLOSED -> ACTIVE (invalid — terminal state)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'FAILED');
      // Close it
      await gqlExpectSuccess(
        `
          mutation CloseBatch($id: ID!, $reason: BatchCloseReason!) {
            closeBatch(id: $id, reason: $reason) { id status }
          }
        `,
        { id: batchId, reason: 'FAILED' },
      );
      await expectTransitionReject(batchId, 'ACTIVE');
    });

    it('CLOSED -> GROWING (invalid — terminal state)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'FAILED');
      await gqlExpectSuccess(
        `
          mutation CloseBatch($id: ID!, $reason: BatchCloseReason!) {
            closeBatch(id: $id, reason: $reason) { id status }
          }
        `,
        { id: batchId, reason: 'FAILED' },
      );
      await expectTransitionReject(batchId, 'GROWING');
    });

    it('HARVESTED -> GROWING (invalid — backward transition)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await transitionTo(batchId, 'PRE_HARVEST');
      await transitionTo(batchId, 'HARVESTING');
      await transitionTo(batchId, 'HARVESTED');
      await expectTransitionReject(batchId, 'GROWING');
    });

    it('GROWING -> QUARANTINE (invalid — backward transition)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await expectTransitionReject(batchId, 'QUARANTINE');
    });

    it('ACTIVE -> QUARANTINE (invalid — backward transition)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await expectTransitionReject(batchId, 'QUARANTINE');
    });

    it('ACTIVE -> HARVESTED (invalid — skip stages)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await expectTransitionReject(batchId, 'HARVESTED');
    });

    it('GROWING -> HARVESTED (invalid — skip stages)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await expectTransitionReject(batchId, 'HARVESTED');
    });

    it('HARVESTING -> QUARANTINE (invalid — backward)', async () => {
      const batchId = await createFreshBatch(speciesId);
      await transitionTo(batchId, 'ACTIVE');
      await transitionTo(batchId, 'GROWING');
      await transitionTo(batchId, 'PRE_HARVEST');
      await transitionTo(batchId, 'HARVESTING');
      await expectTransitionReject(batchId, 'QUARANTINE');
    });
  });
});
