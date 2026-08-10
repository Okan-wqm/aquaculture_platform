/**
 * TankBatchService unit tests — the tank-composition SSoT.
 *
 * Proves the invariants the divergent hand-written paths violated:
 *  - batchDetails[] is ALWAYS persisted (the historical `length>1 ? : undefined`
 *    discard that hid a single-batch tank's stock is gone);
 *  - totalQuantity / totalBiomassKg / density / percentages are DERIVED from
 *    batchDetails[] (never hand-written), so the aggregate cannot drift;
 *  - a batch removed to zero leaves the composition.
 *
 * Every case drives the writer through `applyStockChange` because that is now
 * the only door: the writer is private, so a caller cannot obtain the stock
 * handle without the ration recalculation that follows it.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createMockDataSource } from '@aquaculture/testing';

import { TankBatchService } from '../../services/tank-batch.service';
import type {
  StockChangeReason,
  UnitRationRecalculator,
} from '../../services/unit-ration-recalculator.port';
import { TankBatch } from '../../entities/tank-batch.entity';

interface Settlement {
  unitId: string;
  reason: StockChangeReason;
  stockBiomassDeltaKg: number;
}

function makeService(): { svc: TankBatchService; settlements: Settlement[] } {
  const settlements: Settlement[] = [];
  const recalculator: UnitRationRecalculator = {
    recalcAfterStockChange: async (_manager, _tenantId, unitId, reason, stockBiomassDeltaKg) => {
      settlements.push({ unitId, reason, stockBiomassDeltaKg });
    },
  };
  return { svc: new TankBatchService(recalculator), settlements };
}

describe('TankBatchService.applyStockChange (tank composition SSoT)', () => {
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tankId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const otherTankId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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
    const { svc } = makeService();
    const m = manager(null);
    const tb = await svc.applyStockChange(m as never, tenantId, 'allocation', (stock) =>
      stock.applyDelta(
        tankId,
        { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: 1000, biomassDelta: 50 },
        { code: 'T-1', volumeM3: 100 },
      ),
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
    const { svc } = makeService();
    const m = manager({
      tenantId, tankId, totalQuantity: 1000, totalBiomassKg: 50,
      batchDetails: [{ batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 50, biomassKg: 50, percentageOfTank: 100 }],
    } as TankBatch);
    const tb = await svc.applyStockChange(m as never, tenantId, 'allocation', (stock) =>
      stock.applyDelta(
        tankId,
        { batchId: 'batch-2', batchNumber: 'B-2', quantityDelta: 500, biomassDelta: 30 },
        { volumeM3: 100 },
      ),
    );
    expect(tb.totalQuantity).toBe(1500); // derived = 1000 + 500
    expect(tb.totalBiomassKg).toBe(80); // derived = 50 + 30
    expect(tb.batchDetails).toHaveLength(2);
    expect(tb.isMixedBatch).toBe(true);
  });

  it('decrements on a negative delta and removes a batch that reaches zero', async () => {
    const { svc } = makeService();
    const m = manager({
      tenantId, tankId, totalQuantity: 1000, totalBiomassKg: 50,
      batchDetails: [{ batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 50, biomassKg: 50, percentageOfTank: 100 }],
    } as TankBatch);
    const tb = await svc.applyStockChange(m as never, tenantId, 'harvest', (stock) =>
      stock.applyDelta(
        tankId,
        { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -1000, biomassDelta: -50 },
        {},
      ),
    );
    expect(tb.totalQuantity).toBe(0);
    expect(tb.batchDetails).toHaveLength(0); // fully removed from the tank
    expect(tb.primaryBatchId).toBeUndefined();
  });

  it('partially decrements one batch in a mixed tank and re-derives the aggregate from the per-batch SSoT', async () => {
    const { svc } = makeService();
    const m = manager({
      tenantId, tankId, totalQuantity: 1500, totalBiomassKg: 80,
      batchDetails: [
        { batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 50, biomassKg: 50, percentageOfTank: 66.7 },
        { batchId: 'batch-2', batchNumber: 'B-2', quantity: 500, avgWeightG: 60, biomassKg: 30, percentageOfTank: 33.3 },
      ],
    } as TankBatch);
    const tb = await svc.applyStockChange(m as never, tenantId, 'mortality', (stock) =>
      stock.applyDelta(
        tankId,
        { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -200, biomassDelta: -10 },
        {},
      ),
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
    const { svc, settlements } = makeService();
    const m = manager({
      tenantId, tankId, totalQuantity: 83, totalBiomassKg: 4,
      batchDetails: [
        { batchId: 'batch-1', batchNumber: 'B-1', quantity: 83, avgWeightG: 48, biomassKg: 4, percentageOfTank: 100 },
      ],
    } as TankBatch);
    await expect(
      svc.applyStockChange(m as never, tenantId, 'mortality', (stock) =>
        stock.applyDelta(
          tankId,
          { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -200, biomassDelta: -9.6 },
          { code: 'T-1' },
        ),
      ),
    ).rejects.toThrow(/has only 83 fish in tank T-1; cannot remove 200/);
    // A rejected stock change reprices nothing — the transaction is going back.
    expect(settlements).toHaveLength(0);
  });

  it('REJECTS removal from a batch not present in the tank (was a silent no-op)', async () => {
    const { svc } = makeService();
    const m = manager({
      tenantId, tankId, totalQuantity: 500, totalBiomassKg: 25,
      batchDetails: [
        { batchId: 'batch-1', batchNumber: 'B-1', quantity: 500, avgWeightG: 50, biomassKg: 25, percentageOfTank: 100 },
      ],
    } as TankBatch);
    await expect(
      svc.applyStockChange(m as never, tenantId, 'cull', (stock) =>
        stock.applyDelta(
          tankId,
          { batchId: 'batch-OTHER', batchNumber: 'B-9', quantityDelta: -10, biomassDelta: -0.5 },
          { code: 'T-1' },
        ),
      ),
    ).rejects.toThrow(/has no fish in tank T-1; cannot remove 10/);
  });

  it('still allows an exact-to-zero removal (batch leaves the composition)', async () => {
    const { svc } = makeService();
    const m = manager({
      tenantId, tankId, totalQuantity: 83, totalBiomassKg: 4,
      batchDetails: [
        { batchId: 'batch-1', batchNumber: 'B-1', quantity: 83, avgWeightG: 48, biomassKg: 4, percentageOfTank: 100 },
      ],
    } as TankBatch);
    const tb = await svc.applyStockChange(m as never, tenantId, 'harvest', (stock) =>
      stock.applyDelta(
        tankId,
        { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -83, biomassDelta: -4 },
        {},
      ),
    );
    expect(tb.totalQuantity).toBe(0);
    expect(tb.batchDetails).toHaveLength(0);
  });

  // ==========================================================================
  // THE SETTLEMENT GUARANTEE — a stock change IS a ration change
  // ==========================================================================

  it('settles the unit it touched with the reason and the signed biomass delta', async () => {
    const { svc, settlements } = makeService();
    const m = manager(null);
    await svc.applyStockChange(m as never, tenantId, 'allocation', (stock) =>
      stock.applyDelta(tankId, {
        batchId: 'batch-1',
        batchNumber: 'B-1',
        quantityDelta: 1000,
        biomassDelta: 50,
      }),
    );
    expect(settlements).toEqual([
      { unitId: tankId, reason: 'allocation', stockBiomassDeltaKg: 50 },
    ]);
  });

  it('settles a unit ONCE per scope, with the deltas summed (batched writes)', async () => {
    // A caller that legitimately writes several deltas to one unit (a grading
    // moving two batches out of the same tank) must still produce ONE
    // recalculation — not one per delta, which would log the same day twice and
    // reprice from a half-applied stock state.
    const { svc, settlements } = makeService();
    const m = manager(null);
    await svc.applyStockChange(m as never, tenantId, 'transfer', async (stock) => {
      await stock.applyDelta(tankId, {
        batchId: 'batch-1',
        batchNumber: 'B-1',
        quantityDelta: 400,
        biomassDelta: 20,
      });
      await stock.applyDelta(tankId, {
        batchId: 'batch-2',
        batchNumber: 'B-2',
        quantityDelta: 100,
        biomassDelta: 6,
      });
    });
    expect(settlements).toEqual([
      { unitId: tankId, reason: 'transfer', stockBiomassDeltaKg: 26 },
    ]);
  });

  it('settles BOTH legs of a transfer exactly once, in ascending unit order', async () => {
    // Deterministic order matters: two concurrent transfers over the same pair
    // of units must take the day-plan locks in the same direction.
    const { svc, settlements } = makeService();
    const m = manager({
      tenantId, tankId, totalQuantity: 1000, totalBiomassKg: 50,
      batchDetails: [{ batchId: 'batch-1', batchNumber: 'B-1', quantity: 1000, avgWeightG: 50, biomassKg: 50, percentageOfTank: 100 }],
    } as TankBatch);
    await svc.applyStockChange(m as never, tenantId, 'transfer', async (stock) => {
      // destination first on purpose — the scope, not the caller, orders the work
      await stock.applyDelta(otherTankId, {
        batchId: 'batch-1',
        batchNumber: 'B-1',
        quantityDelta: 300,
        biomassDelta: 15,
      });
      await stock.applyDelta(tankId, {
        batchId: 'batch-1',
        batchNumber: 'B-1',
        quantityDelta: -300,
        biomassDelta: -15,
      });
    });
    expect(settlements).toEqual([
      { unitId: tankId, reason: 'transfer', stockBiomassDeltaKg: -15 },
      { unitId: otherTankId, reason: 'transfer', stockBiomassDeltaKg: 15 },
    ]);
  });
});

/**
 * The mechanism itself, guarded.
 *
 * `private` is what makes the recalculation impossible to omit: a future writer
 * cannot reach the composition writer except through `applyStockChange`, which
 * always settles. The compiler enforces that — but a future edit could flip the
 * modifier back to public and re-open the door, and the compiler would be happy.
 * These two checks make THAT edit fail out loud.
 */
describe('the stock writer stays unreachable without the recalculation', () => {
  const servicePath = join(__dirname, '../../services/tank-batch.service.ts');

  it('declares applyBatchDelta private', () => {
    expect(readFileSync(servicePath, 'utf8')).toContain('private async applyBatchDelta(');
  });

  it('binds a recalculator to the port, so the writer cannot be provided without one', () => {
    // The token is injected without @Optional(): an unbound recalculator does
    // not boot. This keeps the binding visible in the module that owns it.
    const modulePath = join(__dirname, '../../tank-batch.module.ts');
    const moduleSource = readFileSync(modulePath, 'utf8');
    expect(moduleSource).toContain('UNIT_RATION_RECALCULATOR');
    expect(moduleSource).toContain('useExisting: DayPlanRecalcService');
  });

  it('is the only file in the repository that calls it', () => {
    // The needle is assembled at runtime so this spec is not its own match.
    const call = ['.', 'applyBatchDelta', '('].join('');
    // `git grep` searches TRACKED files only — an untracked scratch file in a
    // shared checkout must not decide whether this invariant holds.
    const hits = execFileSync(
      'git',
      ['grep', '-l', '--fixed-strings', call, '--', 'apps/', 'libs/', 'platform/'],
      { cwd: join(__dirname, '../../../../../..'), encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);

    expect(hits).toEqual(['apps/farm-service/src/batch/services/tank-batch.service.ts']);
  });
});
