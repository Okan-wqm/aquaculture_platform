/**
 * Production data-path invariant for combined-batch scoping.
 *
 * The Mortality/Cull/Transfer/Grading modals scope every quantity to the
 * SELECTED batch via `tank.batchDetails` — which only works if BOTH mappers on
 * the production path carry it: backend batchMetrics → tankToTankWithBatch →
 * tankWithBatchToTankBatch → modal prop. That exact plumbing was silently
 * dropped once (a shared-checkout sweep), shipping the feature inert while the
 * modal specs stayed green (they inject batchDetails as a prop). This spec pins
 * the path itself.
 */
import { describe, expect, it } from 'vitest';

import type { Tank } from '../../../hooks/useTanks';
import { tankToTankWithBatch, tankWithBatchToTankBatch } from '../types';

const DETAILS = [
  { batchId: 'b-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 250, biomassKg: 250, percentageOfTank: 66.7 },
  { batchId: 'b-2', batchNumber: 'B-2', quantity: 500, avgWeightG: 200, biomassKg: 100, percentageOfTank: 33.3 },
];

const TANK: Tank = {
  id: 'tank-1',
  tenantId: 't-1',
  name: 'Grow-out A',
  code: 'GT-A',
  equipmentTypeId: 'et-1',
  status: 'ACTIVE',
  isActive: true,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  batchMetrics: {
    batchId: 'b-1',
    batchNumber: 'B-1',
    pieces: 1500,
    avgWeight: 233,
    biomass: 350,
    isMixedBatch: true,
    batchDetails: DETAILS,
  },
};

describe('combined-batch production data path', () => {
  it('tankToTankWithBatch carries batchDetails from batchMetrics', () => {
    const withBatch = tankToTankWithBatch(TANK);
    expect(withBatch.batchDetails).toEqual(DETAILS);
    expect(withBatch.isMixedBatch).toBe(true);
  });

  it('tankWithBatchToTankBatch hands batchDetails to the operation modals', () => {
    const modalTank = tankWithBatchToTankBatch(tankToTankWithBatch(TANK));
    expect(modalTank.batchDetails).toEqual(DETAILS);
    expect(modalTank.primaryBatchId).toBe('b-1');
    // The modals' combined gate — must be true for a 2-batch tank.
    expect((modalTank.batchDetails?.length ?? 0) > 1).toBe(true);
  });
});
