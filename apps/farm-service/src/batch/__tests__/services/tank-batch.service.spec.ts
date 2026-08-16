/**
 * TankBatchService unit tests — the tank-composition SSoT.
 *
 * Proves the invariants the divergent hand-written paths violated:
 *  - batchDetails[] is ALWAYS persisted (the historical `length>1 ? : undefined`
 *    discard that hid a single-batch tank's stock is gone);
 *  - totalQuantity / totalBiomassKg / density / percentages are DERIVED from
 *    batchDetails[] (never hand-written), so the aggregate cannot drift;
 *  - a batch removed to zero leaves the composition.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { TankBatchService, type TankBatchMutationSetV1 } from '../../services/tank-batch.service';
import { TankBatch } from '../../entities/tank-batch.entity';
import {
  RecordingBatchAggregateMutationPort,
  runInFarmMutationTestTransaction,
} from '../../../__tests__/support/durable-mutation-test-authority';

describe('TankBatchService.applyBatchDelta (tank composition SSoT)', () => {
  const svc = new TankBatchService(new RecordingBatchAggregateMutationPort());
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const tankId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function tankBatchFixture(overrides: Partial<TankBatch>): TankBatch {
    return Object.assign(new TankBatch(), {
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      tenantId,
      tankId,
      totalQuantity: 0,
      totalBiomassKg: 0,
      avgWeightG: 0,
      densityKgM3: 0,
      isMixedBatch: false,
      cleanerFishQuantity: 0,
      cleanerFishBiomassKg: 0,
      isOverCapacity: false,
      createdAt: new Date('2026-07-20T00:00:00.000Z'),
      updatedAt: new Date('2026-07-20T00:00:00.000Z'),
      ...overrides,
    });
  }

  function manager(existing: Partial<TankBatch> | null) {
    const { mockManager } = createMockDataSource();
    // TankBatch lookup returns the existing row; the tank/equipment lookup (the
    // single-writer currentCount derive-write) resolves to null here so these
    // batchDetails-derivation tests stay focused — the currentCount write is
    // covered by its own test below.
    (mockManager.findOne as jest.Mock).mockImplementation((entity: unknown) =>
      Promise.resolve(entity === TankBatch ? existing : null),
    );
    (mockManager.find as jest.Mock).mockImplementation((entity: unknown) =>
      Promise.resolve(entity === TankBatch && existing ? [existing] : []),
    );
    (mockManager.query as jest.Mock).mockResolvedValue(undefined);
    (mockManager.create as jest.Mock).mockImplementation((_c: unknown, d: unknown) => d);
    (mockManager.save as jest.Mock).mockImplementation((_c: unknown, d: unknown) =>
      Promise.resolve(d),
    );
    return mockManager;
  }

  function applyBatchDelta(
    entityManager: ReturnType<typeof manager>,
    delta: Parameters<TankBatchService['applyBatchDelta']>[4],
    tankMeta?: Parameters<TankBatchService['applyBatchDelta']>[5],
  ) {
    return runInFarmMutationTestTransaction(entityManager, tenantId, (session) =>
      svc.applyBatchDelta(entityManager, session, tenantId, tankId, delta, tankMeta),
    );
  }

  it('stocks into an empty tank and ALWAYS persists batchDetails (single batch)', async () => {
    const m = manager(null);
    const tb = await applyBatchDelta(
      m,
      { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: 1000, biomassDelta: 50 },
      {
        code: 'T-1',
        volumeM3: 100,
        capacity: { isOverCapacity: true, utilizationPercent: 125 },
      },
    );
    expect(tb.totalQuantity).toBe(1000);
    expect(tb.totalBiomassKg).toBe(50);
    expect(tb.batchDetails).toHaveLength(1); // the single-batch discard bug is fixed
    expect(tb.batchDetails![0]).toMatchObject({
      batchId: 'batch-1',
      quantity: 1000,
      percentageOfTank: 100,
    });
    expect(tb.densityKgM3).toBeCloseTo(0.5); // 50 kg / 100 m³
    expect(tb.isMixedBatch).toBe(false);
    expect(tb.primaryBatchId).toBe('batch-1');
    expect(tb.isOverCapacity).toBe(true);
    expect(tb.capacityUsedPercent).toBe(125);
  });

  it('persists stock, capacity projection and closed transition intent in one aggregate commit', async () => {
    const mutations = new RecordingBatchAggregateMutationPort();
    const service = new TankBatchService(mutations);
    const m = manager(null);

    const saved = await runInFarmMutationTestTransaction(m, tenantId, (session) =>
      service.applyBatchDelta(
        m,
        session,
        tenantId,
        tankId,
        {
          batchId: 'batch-transfer',
          batchNumber: 'B-TRANSFER',
          quantityDelta: 10,
          biomassDelta: 2,
          transitionIntent: 'stock_transfer',
        },
        {
          volumeM3: 20,
          capacity: { isOverCapacity: false, utilizationPercent: 40 },
        },
      ),
    );

    expect(mutations.commitTankBatchTransition).toHaveBeenCalledTimes(1);
    expect(mutations.commitTankBatchTransition).toHaveBeenCalledWith(expect.anything(), {
      intent: 'stock_transfer',
      aggregate: saved,
    });
    expect(saved).toMatchObject({
      totalQuantity: 10,
      totalBiomassKg: 2,
      isOverCapacity: false,
      capacityUsedPercent: 40,
    });
  });

  it('derives aggregates from batchDetails when a second batch joins (mixed)', async () => {
    const m = manager({
      tenantId,
      tankId,
      totalQuantity: 1000,
      totalBiomassKg: 50,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-1',
          quantity: 1000,
          avgWeightG: 50,
          biomassKg: 50,
          percentageOfTank: 100,
        },
      ],
    } as TankBatch);
    const tb = await applyBatchDelta(
      m,
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
      tenantId,
      tankId,
      totalQuantity: 1000,
      totalBiomassKg: 50,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-1',
          quantity: 1000,
          avgWeightG: 50,
          biomassKg: 50,
          percentageOfTank: 100,
        },
      ],
    } as TankBatch);
    const tb = await applyBatchDelta(
      m,
      { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -1000, biomassDelta: -50 },
      {},
    );
    expect(tb.totalQuantity).toBe(0);
    expect(tb.batchDetails).toHaveLength(0); // fully removed from the tank
    expect(tb.primaryBatchId).toBeUndefined();
  });

  it('partially decrements one batch in a mixed tank and re-derives the aggregate from the per-batch SSoT', async () => {
    const m = manager({
      tenantId,
      tankId,
      totalQuantity: 1500,
      totalBiomassKg: 80,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-1',
          quantity: 1000,
          avgWeightG: 50,
          biomassKg: 50,
          percentageOfTank: 66.7,
        },
        {
          batchId: 'batch-2',
          batchNumber: 'B-2',
          quantity: 500,
          avgWeightG: 60,
          biomassKg: 30,
          percentageOfTank: 33.3,
        },
      ],
    } as TankBatch);
    const tb = await applyBatchDelta(
      m,
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
      tenantId,
      tankId,
      totalQuantity: 83,
      totalBiomassKg: 4,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-1',
          quantity: 83,
          avgWeightG: 48,
          biomassKg: 4,
          percentageOfTank: 100,
        },
      ],
    } as TankBatch);
    await expect(
      applyBatchDelta(
        m,
        { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -200, biomassDelta: -9.6 },
        { code: 'T-1' },
      ),
    ).rejects.toThrow(/has only 83 fish in tank T-1; cannot remove 200/);
  });

  it('REJECTS removal from a batch not present in the tank (was a silent no-op)', async () => {
    const m = manager({
      tenantId,
      tankId,
      totalQuantity: 500,
      totalBiomassKg: 25,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-1',
          quantity: 500,
          avgWeightG: 50,
          biomassKg: 25,
          percentageOfTank: 100,
        },
      ],
    } as TankBatch);
    await expect(
      applyBatchDelta(
        m,
        { batchId: 'batch-OTHER', batchNumber: 'B-9', quantityDelta: -10, biomassDelta: -0.5 },
        { code: 'T-1' },
      ),
    ).rejects.toThrow(/has no fish in tank T-1; cannot remove 10/);
  });

  it('still allows an exact-to-zero removal (batch leaves the composition)', async () => {
    const m = manager({
      tenantId,
      tankId,
      totalQuantity: 83,
      totalBiomassKg: 4,
      batchDetails: [
        {
          batchId: 'batch-1',
          batchNumber: 'B-1',
          quantity: 83,
          avgWeightG: 48,
          biomassKg: 4,
          percentageOfTank: 100,
        },
      ],
    } as TankBatch);
    const tb = await applyBatchDelta(
      m,
      { batchId: 'batch-1', batchNumber: 'B-1', quantityDelta: -83, biomassDelta: -4 },
      {},
    );
    expect(tb.totalQuantity).toBe(0);
    expect(tb.batchDetails).toHaveLength(0);
  });

  it('compiles reversed transfer legs into one sorted, callback-scoped lock authority', async () => {
    const sourceTankId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const destinationTankId = '11111111-1111-4111-8111-111111111111';
    const source = tankBatchFixture({
      tankId: sourceTankId,
      totalQuantity: 100,
      totalBiomassKg: 5,
      avgWeightG: 50,
      densityKgM3: 1,
      cleanerFishBiomassKg: 0,
      batchDetails: [],
    });
    const destination = tankBatchFixture({
      tankId: destinationTankId,
      totalQuantity: 50,
      totalBiomassKg: 3,
      avgWeightG: 60,
      densityKgM3: 1,
      cleanerFishBiomassKg: 0,
      batchDetails: [],
    });
    const m = manager(null);
    (m.find as jest.Mock).mockResolvedValue([destination, source]);
    let escapedScope: TankBatchMutationSetV1 | undefined;

    await runInFarmMutationTestTransaction(m, tenantId, (session) =>
      svc.withLockedTankBatchSet(
        m,
        session,
        tenantId,
        [sourceTankId, destinationTankId],
        async (scope) => {
          escapedScope = scope;
          expect(scope.unitIds).toEqual([destinationTankId, sourceTankId]);
          expect(scope.snapshot(sourceTankId)?.totalQuantity).toBe(100);
        },
      ),
    );

    expect(m.find).toHaveBeenCalledWith(
      TankBatch,
      expect.objectContaining({
        order: { tankId: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(m.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`tank-batch-mutation/v1:${tenantId}:${destinationTankId}`],
    );
    expect(m.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`tank-batch-mutation/v1:${tenantId}:${sourceTankId}`],
    );
    expect(m.query.mock.invocationCallOrder[1]).toBeLessThan(m.find.mock.invocationCallOrder[0]!);
    const scopeAfterCallback = escapedScope;
    if (!scopeAfterCallback) throw new Error('TankBatch mutation scope was not observed');
    expect(() => scopeAfterCallback.snapshot(sourceTankId)).toThrow(
      'cannot outlive its lock callback',
    );
  });

  it('serializes existing and first-stock units under one canonical advisory namespace', async () => {
    const sourceTankId = '11111111-1111-4111-8111-111111111111';
    const emptyDestinationId = '22222222-2222-4222-8222-222222222222';
    const source = tankBatchFixture({
      tankId: sourceTankId,
      totalQuantity: 100,
      totalBiomassKg: 5,
      avgWeightG: 50,
      densityKgM3: 1,
      cleanerFishBiomassKg: 0,
      batchDetails: [],
    });
    const m = manager(null);
    (m.find as jest.Mock).mockResolvedValue([source]);

    await runInFarmMutationTestTransaction(m, tenantId, (session) =>
      svc.withLockedTankBatchSet(
        m,
        session,
        tenantId,
        [emptyDestinationId, sourceTankId],
        async (scope) => {
          expect(scope.snapshot(emptyDestinationId)).toBeNull();
        },
      ),
    );

    expect(m.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`tank-batch-mutation/v1:${tenantId}:${sourceTankId}`],
    );
    expect(m.query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`tank-batch-mutation/v1:${tenantId}:${emptyDestinationId}`],
    );
  });
});
