import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { Batch, BatchStatus } from '../../entities/batch.entity';
import { TankBatch } from '../../entities/tank-batch.entity';
import { MortalityCullPolicyService } from '../../services/mortality-cull-policy.service';

describe('MortalityCullPolicyService', () => {
  const policy = new MortalityCullPolicyService();

  const OPERATIONAL = [
    BatchStatus.ACTIVE,
    BatchStatus.GROWING,
    BatchStatus.PRE_HARVEST,
    BatchStatus.HARVESTING,
  ];

  function batchWith(overrides: Partial<Batch> = {}): Batch {
    const status = overrides.status ?? BatchStatus.GROWING;
    return {
      batchNumber: 'B-001',
      initialQuantity: 1000,
      totalMortality: 0,
      cullCount: 0,
      harvestedQuantity: undefined,
      ...overrides,
      status,
      isOperational: (): boolean => OPERATIONAL.includes(status),
      isStockMutable: (): boolean =>
        OPERATIONAL.includes(status) || status === BatchStatus.QUARANTINE,
    } as Partial<Batch> as Batch;
  }

  describe('assertQuantityWithinCurrent', () => {
    it('allows mortality/cull quantities up to current quantity', () => {
      expect(() =>
        policy.assertQuantityWithinCurrent({ operation: 'Mortality', quantity: 10, currentQuantity: 10 }),
      ).not.toThrow();
    });

    it('rejects mortality/cull quantities above current quantity', () => {
      expect(() =>
        policy.assertQuantityWithinCurrent({ operation: 'Cull', quantity: 11, currentQuantity: 10 }),
      ).toThrow(BadRequestException);
    });
  });

  describe('assertStockMutable (FARM-CRITICAL-050)', () => {
    it.each([
      BatchStatus.ACTIVE,
      BatchStatus.GROWING,
      BatchStatus.PRE_HARVEST,
      BatchStatus.HARVESTING,
      // QUARANTINE holds LIVE, physically-present stock — a quarantined fish dies
      // and is culled like any other, so mortality/cull MUST be permitted there.
      // Excluding it (the original isOperational-only gate) rejected legitimate
      // removals and left the batch count inflated.
      BatchStatus.QUARANTINE,
    ])('passes for stock-mutable status %s', (status) => {
      expect(() => policy.assertStockMutable(batchWith({ status }))).not.toThrow();
    });

    it.each([
      BatchStatus.HARVESTED,
      BatchStatus.FAILED,
      BatchStatus.CLOSED,
      BatchStatus.TRANSFERRED,
    ])('throws ConflictException for terminal status %s', (status) => {
      expect(() => policy.assertStockMutable(batchWith({ status }))).toThrow(ConflictException);
    });
  });

  describe('assertBatchInTank (FARM-HIGH-053)', () => {
    function tankBatch(overrides: Partial<TankBatch> = {}): TankBatch {
      return { primaryBatchId: undefined, batchDetails: undefined, ...overrides } as Partial<TankBatch> as TankBatch;
    }

    it('throws NotFoundException when the tankBatch is null', () => {
      expect(() => policy.assertBatchInTank({ batchId: 'b1', tankBatch: null })).toThrow(NotFoundException);
    });

    it('throws when batchId is neither primary nor in batchDetails', () => {
      expect(() =>
        policy.assertBatchInTank({ batchId: 'b1', tankBatch: tankBatch({ primaryBatchId: 'other' }) }),
      ).toThrow(NotFoundException);
    });

    it('passes when batchId is the primary batch', () => {
      expect(() =>
        policy.assertBatchInTank({ batchId: 'b1', tankBatch: tankBatch({ primaryBatchId: 'b1' }) }),
      ).not.toThrow();
    });

    it('passes when batchId is present in mixed-batch batchDetails', () => {
      expect(() =>
        policy.assertBatchInTank({
          batchId: 'b1',
          tankBatch: tankBatch({
            primaryBatchId: 'other',
            batchDetails: [{ batchId: 'b1' }, { batchId: 'b2' }] as TankBatch['batchDetails'],
          }),
        }),
      ).not.toThrow();
    });
  });

  describe('assertAggregateWithinInitial (FARM-LOW-050)', () => {
    it('passes at exactly the ceiling', () => {
      // 40 + 30 + 20 + 10 = 100 === initialQuantity
      expect(() =>
        policy.assertAggregateWithinInitial({
          batch: batchWith({ initialQuantity: 100, totalMortality: 40, cullCount: 30, harvestedQuantity: 20 }),
          addedRemoval: 10,
        }),
      ).not.toThrow();
    });

    it('throws when cumulative removals exceed initialQuantity', () => {
      // 40 + 30 + 20 + 11 = 101 > 100
      expect(() =>
        policy.assertAggregateWithinInitial({
          batch: batchWith({ initialQuantity: 100, totalMortality: 40, cullCount: 30, harvestedQuantity: 20 }),
          addedRemoval: 11,
        }),
      ).toThrow(BadRequestException);
    });

    it('treats a missing harvestedQuantity as 0', () => {
      expect(() =>
        policy.assertAggregateWithinInitial({
          batch: batchWith({ initialQuantity: 100, totalMortality: 50, cullCount: 0, harvestedQuantity: undefined }),
          addedRemoval: 50,
        }),
      ).not.toThrow();
    });
  });
});
