/**
 * TankCountReconcileService unit tests — the ledger-based count reconciliation.
 *
 * Proves: dryRun (default) computes the per-tank-batch diff WITHOUT writing;
 * apply routes non-zero corrections through applyBatchDelta (the single writer);
 * a pre-SSoT row (batchDetails NULL) baselines from totalQuantity instead of 0
 * and gets a zero-delta self-heal when its currentQuantity mirror is stale; an
 * incomplete ledger (no inflow rows / negative net) is fail-closed — reported,
 * never applied.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { TankBatchService } from '../../services/tank-batch.service';
import { TankCountReconcileService } from '../../services/tank-count-reconcile.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TANK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BATCH = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

interface MockLedgerRow {
  tankId: string;
  batchId: string;
  trueQty: string;
  inflowRows: string;
}

function harness(ledger: MockLedgerRow[], tankBatch: unknown) {
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

// Post-SSoT row whose batchDetails drifted from the ledger.
const DRIFTED_TANK_BATCH = {
  tankId: TANK,
  primaryBatchId: BATCH,
  primaryBatchNumber: 'B-001',
  totalQuantity: 900,
  currentQuantity: 900,
  avgWeightG: 50,
  batchDetails: [{ batchId: BATCH, batchNumber: 'B-001', quantity: 900, avgWeightG: 50 }],
};

// Pre-SSoT row: batchDetails NULL, converged totalQuantity, STALE currentQuantity
// mirror — the exact live shape behind the 900-vs-719 mobile/web divergence.
const PRE_SSOT_STALE_MIRROR = {
  tankId: TANK,
  primaryBatchId: BATCH,
  primaryBatchNumber: 'B-001',
  totalQuantity: 719,
  currentQuantity: 900,
  avgWeightG: 50,
  batchDetails: null,
};

describe('TankCountReconcileService.reconcile', () => {
  it('dryRun (default) reports the diff and does NOT write', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '2' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT);

    expect(rows).toEqual([
      {
        tankId: TANK,
        batchId: BATCH,
        batchNumber: 'B-001',
        currentQuantity: 900,
        mirrorQuantity: 900,
        ledgerQuantity: 719,
        delta: -181,
        ledgerComplete: true,
        applied: false,
        healed: false,
      },
    ]);
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('apply (dryRun=false) routes the correction through applyBatchDelta (the single writer)', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '2' }],
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

  it('pre-SSoT row baselines from totalQuantity (not 0) — no phantom delta', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '5' }],
      PRE_SSOT_STALE_MIRROR,
    );

    const rows = await svc.reconcile(TENANT);

    expect(rows[0]).toMatchObject({
      currentQuantity: 719, // totalQuantity fallback — NOT 0
      mirrorQuantity: 900, // the stale mobile-surfaced mirror, reported for review
      ledgerQuantity: 719,
      delta: 0,
      ledgerComplete: true,
      healed: false, // dry-run never writes
    });
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('apply self-heals a stale mirror at delta 0 via a zero-delta applyBatchDelta', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '5' }],
      PRE_SSOT_STALE_MIRROR,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.healed).toBe(true);
    expect(rows[0]!.applied).toBe(false);
    expect(applyBatchDelta).toHaveBeenCalledTimes(1);
    expect(applyBatchDelta).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      TANK,
      expect.objectContaining({ batchId: BATCH, quantityDelta: 0, biomassDelta: 0 }),
    );
  });

  it('fail-closed: an incomplete ledger (negative net) is reported but NEVER applied', async () => {
    const { svc, applyBatchDelta } = harness(
      // Missing initial stocking → net went negative (transfer_out > known inflows).
      [{ tankId: TANK, batchId: BATCH, trueQty: '-902', inflowRows: '4' }],
      { ...DRIFTED_TANK_BATCH, totalQuantity: 98, currentQuantity: 180 },
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.ledgerComplete).toBe(false);
    expect(rows[0]!.applied).toBe(false);
    expect(rows[0]!.healed).toBe(false);
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('fail-closed: no inflow rows at all → ledgerComplete=false, never applied', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '50', inflowRows: '0' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.ledgerComplete).toBe(false);
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('does NOT write when consistent and already healed (delta 0, fresh mirror, details present)', async () => {
    const { svc, applyBatchDelta } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '900', inflowRows: '2' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.delta).toBe(0);
    expect(rows[0]!.applied).toBe(false);
    expect(rows[0]!.healed).toBe(false);
    expect(applyBatchDelta).not.toHaveBeenCalled();
  });

  it('honours the tankIds filter (skips tanks not requested)', async () => {
    const { svc, applyBatchDelta } = harness(
      [
        { tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '2' },
        { tankId: 'other-tank', batchId: BATCH, trueQty: '10', inflowRows: '1' },
      ],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false, tankIds: [TANK] });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tankId).toBe(TANK);
    expect(applyBatchDelta).toHaveBeenCalledTimes(1);
  });
});
