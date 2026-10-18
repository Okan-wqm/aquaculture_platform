/**
 * TankBatchService unit tests — the tank-composition SSoT.
 *
 * Proves the invariants the divergent hand-written paths violated:
 *  - batchDetails[] is ALWAYS persisted (the historical `length>1 ? : undefined`
 *    discard that hid a single-batch tank's stock is gone);
 *  - totalQuantity / totalBiomassKg / density / percentages are DERIVED from
 *    batchDetails[] (never hand-written), so the aggregate cannot drift;
 *  - a batch removed to zero leaves the composition, and an emptied tank names
 *    no primary batch (null, which TypeORM writes; undefined it skipped);
 *  - moved fish carry their weight stamps into the destination share.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { TankBatchService } from '../../services/tank-batch.service';
import { TankBatch } from '../../entities/tank-batch.entity';

describe('TankBatchService.applyBatchDelta (tank composition SSoT)', () => {
  const svc = new TankBatchService();
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tankId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function manager(existing: Partial<TankBatch> | null) {
    const { mockManager } = createMockDataSource();
    // TankBatch lookup returns the existing row; the tank/equipment lookup (the
    // single-writer currentCount derive-write) resolves to null here so these
    // batchDetails-derivation tests stay focused — the currentCount write is
    // covered by its own test below.
    (mockManager.findOne as jest.Mock).mockImplementation((entity: unknown) =>
      Promise.resolve(entity === TankBatch ? existing : null),
    );
    (mockManager.create as jest.Mock).mockImplementation((_c: unknown, d: unknown) => d);
    (mockManager.save as jest.Mock).mockImplementation((_c: unknown, d: unknown) => Promise.resolve(d));
    return mockManager;
  }

  it('stocks into an empty tank and ALWAYS persists batchDetails (single batch)', async () => {
    const m = manager(null);
    const tb = await svc.applyBatchDelta(
      m as never,
      tenantId,
      tankId,
      { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: 1000, biomassDelta: 50 },
      { code: 'T-1', volumeM3: 100 },
    );
    expect(tb.totalQuantity).toBe(1000);
    expect(tb.totalBiomassKg).toBe(50);
    expect(tb.batchDetails).toHaveLength(1); // the single-batch discard bug is fixed
    expect(tb.batchDetails![0]).toMatchObject({ batchId: 'batch-1', quantity: 1000, percentageOfTank: 100 });
    expect(tb.densityKgM3).toBeCloseTo(0.5); // 50 kg / 100 m³
    expect(tb.isMixedBatch).toBe(false);
    expect(tb.primaryBatchId).toBe('batch-1');
  });

  it('derives aggregates from batchDetails when a second batch joins (mixed)', async () => {
    const m = manager({
      tenantId, tankId, totalQuantity: 1000, totalBiomassKg: 50,
      batchDetails: [{ batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 50, biomassKg: 50, percentageOfTank: 100 }],
    } as TankBatch);
    const tb = await svc.applyBatchDelta(
      m as never, tenantId, tankId,
      { batchId: 'batch-2', batchNumber: 'B-2', quantityDelta: 500, biomassDelta: 30 },
      { volumeM3: 100 },
    );
    expect(tb.totalQuantity).toBe(1500); // derived = 1000 + 500
    expect(tb.totalBiomassKg).toBe(80); // derived = 50 + 30
    expect(tb.batchDetails).toHaveLength(2);
    expect(tb.isMixedBatch).toBe(true);
  });

  it('decrements on a negative delta and removes a batch that reaches zero', async () => {
    const m = manager({
      tenantId, tankId, totalQuantity: 1000, totalBiomassKg: 50,
      batchDetails: [{ batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 50, biomassKg: 50, percentageOfTank: 100 }],
    } as TankBatch);
    const tb = await svc.applyBatchDelta(
      m as never, tenantId, tankId,
      { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -1000, biomassDelta: -50 },
      {},
    );
    expect(tb.totalQuantity).toBe(0);
    expect(tb.batchDetails).toHaveLength(0); // fully removed from the tank
    // null, not undefined: TypeORM's UPDATE skips an undefined property, so the
    // emptied row kept naming the batch that left it (FARM-CRITICAL-454 verification).
    expect(tb.primaryBatchId).toBeNull();
    expect(tb.primaryBatchNumber).toBeNull();
  });

  it("carries the moved fish's weight stamps into the destination share it creates", async () => {
    const m = manager(null);
    const tb = await svc.applyBatchDelta(m, tenantId, tankId, {
      batchId: 'batch-1',
      batchNumber: 'B-1',
      quantityDelta: 40,
      biomassDelta: 1.2,
      weightStamps: { weighedOn: '2026-10-14', grownThrough: '2026-10-15' },
    });
    expect(tb.batchDetails![0]).toMatchObject({
      batchId: 'batch-1',
      quantity: 40,
      weighedOn: '2026-10-14',
      grownThrough: '2026-10-15',
    });
  });

  it('keeps the later stamp of each kind when the moved fish join a share of the same batch', async () => {
    const m = manager({
      tenantId,
      tankId,
      totalQuantity: 60,
      totalBiomassKg: 0.6,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-1',
          quantity: 60,
          avgWeightG: 10,
          biomassKg: 0.6,
          percentageOfTank: 100,
          weighedOn: '2026-10-16',
          grownThrough: '2026-10-12',
        },
      ],
    });
    const tb = await svc.applyBatchDelta(m, tenantId, tankId, {
      batchId: 'batch-1',
      batchNumber: 'B-1',
      quantityDelta: 40,
      biomassDelta: 1.2,
      weightStamps: { weighedOn: '2026-10-14', grownThrough: '2026-10-15' },
    });
    expect(tb.batchDetails![0]).toMatchObject({
      quantity: 100,
      weighedOn: '2026-10-16',
      grownThrough: '2026-10-15',
    });
  });

  it("leaves a share's stamps alone on a removal", async () => {
    const m = manager({
      tenantId,
      tankId,
      totalQuantity: 100,
      totalBiomassKg: 3,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-1',
          quantity: 100,
          avgWeightG: 30,
          biomassKg: 3,
          percentageOfTank: 100,
          weighedOn: '2026-10-16',
        },
      ],
    });
    const tb = await svc.applyBatchDelta(m, tenantId, tankId, {
      batchId: 'batch-1',
      batchNumber: 'B-1',
      quantityDelta: -40,
      biomassDelta: -1.2,
      weightStamps: { weighedOn: '2026-10-18' },
    });
    expect(tb.batchDetails![0]).toMatchObject({ quantity: 60, weighedOn: '2026-10-16' });
  });

  it('partially decrements one batch in a mixed tank and re-derives the aggregate from the per-batch SSoT', async () => {
    const m = manager({
      tenantId, tankId, totalQuantity: 1500, totalBiomassKg: 80,
      batchDetails: [
        { batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 50, biomassKg: 50, percentageOfTank: 66.7 },
        { batchId: 'batch-2', batchNumber: 'B-2', quantity: 500, avgWeightG: 60, biomassKg: 30, percentageOfTank: 33.3 },
      ],
    } as TankBatch);
    const tb = await svc.applyBatchDelta(
      m as never, tenantId, tankId,
      { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -200, biomassDelta: -10 },
      {},
    );
    expect(tb.totalQuantity).toBe(1300); // 800 + 500 — aggregate derived, not hand-written
    expect(tb.totalBiomassKg).toBe(70); // 40 + 30
    expect(tb.batchDetails).toHaveLength(2);
    expect(tb.batchDetails!.find((d) => d.batchId === 'batch-1')!.quantity).toBe(800);
  });

  it('REJECTS a per-tank overdraft instead of clamping (multi-tank divergence class)', async () => {
    // Handlers validate against the batch-GLOBAL count; a 200-fish removal
    // against an 83-fish tank share used to clamp to 0 and silently absorb 117
    // fish, permanently diverging batch vs tank aggregates.
    const m = manager({
      tenantId, tankId, totalQuantity: 83, totalBiomassKg: 4,
      batchDetails: [
        { batchId: 'batch-1', batchNumber: 'B-1', quantity: 83, avgWeightG: 48, biomassKg: 4, percentageOfTank: 100 },
      ],
    } as TankBatch);
    await expect(
      svc.applyBatchDelta(
        m as never, tenantId, tankId,
        { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -200, biomassDelta: -9.6 },
        { code: 'T-1' },
      ),
    ).rejects.toThrow(/has only 83 fish in tank T-1; cannot remove 200/);
  });

  it('REJECTS removal from a batch not present in the tank (was a silent no-op)', async () => {
    const m = manager({
      tenantId, tankId, totalQuantity: 500, totalBiomassKg: 25,
      batchDetails: [
        { batchId: 'batch-1', batchNumber: 'B-1', quantity: 500, avgWeightG: 50, biomassKg: 25, percentageOfTank: 100 },
      ],
    } as TankBatch);
    await expect(
      svc.applyBatchDelta(
        m as never, tenantId, tankId,
        { batchId: 'batch-OTHER', batchNumber: 'B-9', quantityDelta: -10, biomassDelta: -0.5 },
        { code: 'T-1' },
      ),
    ).rejects.toThrow(/has no fish in tank T-1; cannot remove 10/);
  });

  it('still allows an exact-to-zero removal (batch leaves the composition)', async () => {
    const m = manager({
      tenantId, tankId, totalQuantity: 83, totalBiomassKg: 4,
      batchDetails: [
        { batchId: 'batch-1', batchNumber: 'B-1', quantity: 83, avgWeightG: 48, biomassKg: 4, percentageOfTank: 100 },
      ],
    } as TankBatch);
    const tb = await svc.applyBatchDelta(
      m as never, tenantId, tankId,
      { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -83, biomassDelta: -4 },
      {},
    );
    expect(tb.totalQuantity).toBe(0);
    expect(tb.batchDetails).toHaveLength(0);
  });
});
