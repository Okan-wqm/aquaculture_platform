/**
 * TankCountReconcileService unit tests — the ledger-based count reconciliation.
 *
 * Proves: dryRun (default) computes the per-tank-batch diff WITHOUT writing;
 * apply routes non-zero corrections through the stock scope (the single writer),
 * which also reprices the unit's remaining meals — a correction that moves the
 * count without moving the ration would leave the day feeding a number the
 * operator just declared wrong;
 * a pre-SSoT row (batchDetails NULL) baselines from totalQuantity instead of 0
 * and gets a zero-delta self-heal that seeds batchDetails (the currentQuantity
 * mirror itself is retired — ORPHAN-HIGH-353); an
 * incomplete ledger (no inflow rows / negative net) is fail-closed — reported,
 * never applied.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { TankCountReconcileService } from '../../services/tank-count-reconcile.service';
import { createStockChangeDouble } from '../support/stock-change-double';

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
  const stockChange = createStockChangeDouble();
  const svc = new TankCountReconcileService(mockDataSource, stockChange.tankBatchService);
  return { svc, stockChange };
}

// Post-SSoT row whose batchDetails drifted from the ledger.
const DRIFTED_TANK_BATCH = {
  tankId: TANK,
  primaryBatchId: BATCH,
  primaryBatchNumber: 'B-001',
  totalQuantity: 900,
  avgWeightG: 50,
  batchDetails: [{ batchId: BATCH, batchNumber: 'B-001', quantity: 900, avgWeightG: 50 }],
};

// Pre-SSoT row: batchDetails NULL with a converged totalQuantity — needs the
// zero-delta seed so the per-batch SSoT exists (the historical stale-mirror
// column behind the 900-vs-719 divergence is dropped; ORPHAN-HIGH-353).
const PRE_SSOT_NO_DETAILS = {
  tankId: TANK,
  primaryBatchId: BATCH,
  primaryBatchNumber: 'B-001',
  totalQuantity: 719,
  avgWeightG: 50,
  batchDetails: null,
};

describe('TankCountReconcileService.reconcile', () => {
  it('dryRun (default) reports the diff and does NOT write', async () => {
    const { svc, stockChange } = harness(
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
        ledgerQuantity: 719,
        delta: -181,
        ledgerComplete: true,
        applied: false,
        healed: false,
      },
    ]);
    expect(stockChange.deltas).toHaveLength(0);
  });

  it('apply (dryRun=false) routes the correction through the stock scope (single writer + ration settlement)', async () => {
    const { svc, stockChange } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '2' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.applied).toBe(true);
    expect(stockChange.deltas).toHaveLength(1);
    expect(stockChange.deltas[0]).toMatchObject({
      reason: 'count_reconcile',
      tankId: TANK,
      delta: {
        batchId: BATCH,
        quantityDelta: -181,
        biomassDelta: (-181 * 50) / 1000,
      },
    });
    // The unit was touched exactly once, so the scope reprices it exactly once.
    expect(stockChange.touchedUnits()).toEqual([TANK]);
  });

  it('pre-SSoT row baselines from totalQuantity (not 0) — no phantom delta', async () => {
    const { svc, stockChange } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '5' }],
      PRE_SSOT_NO_DETAILS,
    );

    const rows = await svc.reconcile(TENANT);

    expect(rows[0]).toMatchObject({
      currentQuantity: 719, // totalQuantity fallback — NOT 0
      ledgerQuantity: 719,
      delta: 0,
      ledgerComplete: true,
      healed: false, // dry-run never writes
    });
    expect(stockChange.deltas).toHaveLength(0);
  });

  it('apply seeds missing batchDetails at delta 0 via a zero-delta write', async () => {
    const { svc, stockChange } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '5' }],
      PRE_SSOT_NO_DETAILS,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.healed).toBe(true);
    expect(rows[0]!.applied).toBe(false);
    expect(stockChange.deltas).toHaveLength(1);
    expect(stockChange.deltas[0]).toMatchObject({
      reason: 'count_reconcile',
      delta: { batchId: BATCH, quantityDelta: 0, biomassDelta: 0 },
    });
  });

  it('fail-closed: an incomplete ledger (negative net) is reported but NEVER applied', async () => {
    const { svc, stockChange } = harness(
      // Missing initial stocking → net went negative (transfer_out > known inflows).
      [{ tankId: TANK, batchId: BATCH, trueQty: '-902', inflowRows: '4' }],
      { ...DRIFTED_TANK_BATCH, totalQuantity: 98 },
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.ledgerComplete).toBe(false);
    expect(rows[0]!.applied).toBe(false);
    expect(rows[0]!.healed).toBe(false);
    expect(stockChange.deltas).toHaveLength(0);
  });

  it('fail-closed: no inflow rows at all → ledgerComplete=false, never applied', async () => {
    const { svc, stockChange } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '50', inflowRows: '0' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.ledgerComplete).toBe(false);
    expect(stockChange.deltas).toHaveLength(0);
  });

  it('does NOT write when consistent and already healed (delta 0, details present)', async () => {
    const { svc, stockChange } = harness(
      [{ tankId: TANK, batchId: BATCH, trueQty: '900', inflowRows: '2' }],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false });

    expect(rows[0]!.delta).toBe(0);
    expect(rows[0]!.applied).toBe(false);
    expect(rows[0]!.healed).toBe(false);
    expect(stockChange.deltas).toHaveLength(0);
  });

  it('honours the tankIds filter (skips tanks not requested)', async () => {
    const { svc, stockChange } = harness(
      [
        { tankId: TANK, batchId: BATCH, trueQty: '719', inflowRows: '2' },
        { tankId: 'other-tank', batchId: BATCH, trueQty: '10', inflowRows: '1' },
      ],
      DRIFTED_TANK_BATCH,
    );

    const rows = await svc.reconcile(TENANT, { dryRun: false, tankIds: [TANK] });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.tankId).toBe(TANK);
    expect(stockChange.deltas).toHaveLength(1);
  });
});
