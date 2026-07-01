/**
 * TankCountReconcileService unit tests — the ledger-based count reconciliation.
 *
 * Proves: dryRun (default) computes the per-tank-batch diff WITHOUT writing, and
 * apply routes every non-zero correction through applyBatchDelta (the single
 * writer) so tank_batches + currentCount land on the ledger truth.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { TankBatchService } from '../../services/tank-batch.service';
import { TankCountReconcileService } from '../../services/tank-count-reconcile.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TANK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BATCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function harness(
  ledger: Array<{ tankId: string; batchId: string; trueQty: string }>,
  tankBatch: unknown,
) {
  const { mockDataSource, mockManager } = createMockDataSource();
  // The factory mock has no `query`; the reconcile ledger SQL uses it.
  mockManager.query = jest.fn().mockResolvedValue(ledger);
  (mockManager.findOne as jest.Mock).mockResolvedValue(tankBatch);
  const applyBatchDelta = jest.fn().mockResolvedValue({});
  const tankBatchService = {
    applyBatchDelta,
  } as Partial<TankBatchService> as TankBatchService;
  const svc = new TankCountReconcileService(mockDataSource, tankBatchService);
  return { svc, applyBatchDelta };
}

const DRIFTED_TANK_BATCH = {
  tankId: TANK,
  primaryBatchNumber: 'B-001',
  // stored 900 but the ledger says 719 — the 900-vs-719 divergence
  batchDetails: [{ batchId: BATCH, batchNumber: 'B-001', quantity: 900, avgWeightG: 50 }],
};

describe('TankCountReconcileService.reconcile', () => {
  it('dryRun (default) reports the diff and does NOT write', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT);

    expect(rows).toEqual([
      {
        tankId: TANK,
        batchId: BATCH,
        batchNumber: 'B-001',
        currentQuantity: 900,
        ledgerQuantity: 719,
        delta: -181,
        applied: false,
      },
    ]);
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('apply (dryRun=false) routes the correction through applyBatchDelta (the single writer)', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.applied).toBe(true);
    expect(applyBatchDelta).toHaveBeenCalledTimes(1);
    expect(applyBatchDelta).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      TANK,
      expect.objectContaining({
        batchId: BATCH,
        quantityDelta: -181,
        biomassDelta: (-181 * 50) / 1000,
      }),
    );
  });

  it('does NOT write when already consistent (delta 0), even in apply mode', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '900' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.delta).toBe(0);
    expect(rows[0]!.applied).toBe(false);
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('honours the tankIds filter (skips tanks not requested)', async () => {
    const { svc, applyBatchDelta } = harness(
      [
        { tankId: TANK, batchId: BATCH, trueQty: '719' },
        { tankId: 'other-tank', batchId: BATCH, trueQty: '10' },
      ],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false, tankIds: [TANK] });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tankId).toBe(TANK);
    expect(applyBatchDelta).toHaveBeenCalledTimes(1);
  });
});
