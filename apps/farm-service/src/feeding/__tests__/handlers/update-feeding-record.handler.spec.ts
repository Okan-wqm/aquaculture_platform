/**
 * UpdateFeedingRecordHandler pinleri.
 *
 * Her-zaman-yayınlanan `FeedingRecordUpdated` sözleşmesine EK OLARAK
 * FARM-HIGH-248'in kapattığı üç sapma burada pinlenir: miktar düzeltmesi
 * stok hareketini (ledger), gün planının `unplannedActualKg` toplamını ve
 * biyokütle deltasını AYNI transaction'da yazmak ZORUNDADIR. Eskiden yalnız
 * satır + batch aggregate yazılıyordu; fantom stok, bayat plan ve iki yönlü
 * biyokütle sapması üretiyordu (aşağı düzeltmede uygulanmış büyüme geri
 * alınmadığı için ertesi günün bandı yanlış seçiliyordu).
 */
import { NotFoundException } from '@nestjs/common';
import { createMockDataSource } from '@aquaculture/testing';
import type { DataSource, EntityManager } from 'typeorm';

import { UpdateFeedingRecordHandler } from '../../handlers/update-feeding-record.handler';
import { UpdateFeedingRecordCommand } from '../../commands/update-feeding-record.command';
import { FeedingRecord } from '../../entities/feeding-record.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import type { OutboxPublisher } from '@platform/outbox';
import { FeedingLedgerService } from '../../services/feeding-ledger.service';
import { BiomassGrowthApplierService } from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../../../feeding-protocol/services/day-plan-recalc.service';
import { FeedingDayPlan } from '../../../feeding-protocol/entities/feeding-day-plan.entity';

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Tipli kısmi double — tek `as T`, banned-construct kapısına uygun. */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface HarnessOpts {
  feedingRecord?: Partial<FeedingRecord> | null;
  batch?: Partial<Batch> | null;
  /** Kayıt bir gün planına bağlıysa (plan-dışı yem) plan satırı. */
  dayPlan?: Partial<FeedingDayPlan> | null;
  /** Ünite kilidi çözülebildiyse büyüme deltası uygulanır. */
  lockedUnit?: unknown;
  enqueueImpl?: (event: unknown, em: EntityManager) => Promise<void>;
}

function makeHarness(opts: HarnessOpts = {}) {
  const record: Partial<FeedingRecord> | null =
    opts.feedingRecord === null
      ? null
      : ({
          id: 'fr-1',
          tenantId: TENANT_ID,
          batchId: 'batch-1',
          actualAmount: 10,
          feedCost: 100,
          calculateVariance: jest.fn(),
          ...(opts.feedingRecord ?? {}),
        } as unknown as FeedingRecord);

  const batch: Partial<Batch> =
    opts.batch === null
      ? (null as unknown as Partial<Batch>)
      : {
          id: 'batch-1',
          tenantId: TENANT_ID,
          totalFeedConsumed: 500,
          totalFeedCost: 5000,
          ...(opts.batch ?? {}),
        };

  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();

  const savedEntities: unknown[] = [];
  const managerSave = mockManager.save as jest.Mock;
  managerSave.mockImplementation(async (entityOrType: unknown, entity?: unknown) => {
    // repository-style .save(entity) — single arg
    const target = entity ?? entityOrType;
    savedEntities.push(target);
    return target;
  });
  // findOne artık entity'ye göre dallanır: kayıt (ön-okuma + kilitli okuma),
  // batch ve — dayPlanId varsa — gün planı.
  const managerFindOne = mockManager.findOne as jest.Mock;
  managerFindOne.mockImplementation(async (entity: unknown) => {
    if (entity === FeedingRecord) return record;
    if (entity === Batch) return batch;
    if (entity === FeedingDayPlan) return opts.dayPlan ?? null;
    return null;
  });
  // createMockDataSource manager'ında `query` tanımlı olmayabilir — düzeltme
  // revizyon sayacı ve plan UPDATE'i buradan geçtiği için açıkça kurulur.
  const managerQuery = jest.fn().mockResolvedValue([{ count: 0 }]);
  mockManager.query = managerQuery as typeof mockManager.query;

  const commit = mockQueryRunner.commitTransaction as jest.Mock;
  const rollback = mockQueryRunner.rollbackTransaction as jest.Mock;
  const dataSource = mockDataSource;

  const enqueue = jest.fn(async (event: unknown, em: EntityManager) => {
    if (opts.enqueueImpl) return opts.enqueueImpl(event, em);
    return undefined;
  });
  const outboxPublisher = { enqueue } as unknown as OutboxPublisher;

  const applyStockCorrection = jest.fn().mockResolvedValue(undefined);
  const feedingLedger = mock<FeedingLedgerService>({ applyStockCorrection });

  const lockUnitForGrowth = jest.fn().mockResolvedValue(opts.lockedUnit ?? null);
  const applyGrowth = jest.fn().mockResolvedValue(undefined);
  const growthApplier = mock<BiomassGrowthApplierService>({ lockUnitForGrowth, applyGrowth });

  const recalcForUnit = jest.fn().mockResolvedValue(null);
  const recalcService = mock<DayPlanRecalcService>({ recalcForUnit });

  const handler = new UpdateFeedingRecordHandler(
    dataSource as DataSource,
    outboxPublisher,
    feedingLedger,
    growthApplier,
    recalcService,
  );

  return {
    handler,
    enqueue,
    commit,
    rollback,
    managerSave,
    managerFindOne,
    savedEntities,
    batch,
    applyStockCorrection,
    lockUnitForGrowth,
    applyGrowth,
    recalcForUnit,
    managerQuery,
  };
}

function makeCommand(payload: ConstructorParameters<typeof UpdateFeedingRecordCommand>[2]) {
  return new UpdateFeedingRecordCommand(TENANT_ID, 'fr-1', payload, 'user-1');
}

describe('UpdateFeedingRecordHandler — transactional outbox', () => {
  it('actualAmount change: emits event with diff + updates batch total', async () => {
    const { handler, enqueue, commit, managerFindOne } = makeHarness();

    await handler.execute(makeCommand({ actualAmount: 15 }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('FeedingRecordUpdated');
    expect(event['tenantId']).toBe(TENANT_ID);
    expect(event['feedingRecordId']).toBe('fr-1');
    expect(event['batchId']).toBe('batch-1');
    expect(event['previousActualAmountKg']).toBe(10);
    expect(event['newActualAmountKg']).toBe(15);
    expect(event['amountDiffKg']).toBe(5);
    // Feed cost wasn't touched → diff = 0
    expect(event['costDiff']).toBe(0);

    // Batch read + write happens when amount changed
    // Batch KİLİTLİ okunur — kilitsiz read-modify-write lost update üretiyordu.
    expect(managerFindOne).toHaveBeenCalledWith(Batch, {
      where: { id: 'batch-1', tenantId: TENANT_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('feedCost-only change: emits event + updates batch totalFeedCost only', async () => {
    const { handler, enqueue } = makeHarness();

    await handler.execute(makeCommand({ feedCost: 150 }));

    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['amountDiffKg']).toBe(0);
    expect(event['previousFeedCost']).toBe(100);
    expect(event['newFeedCost']).toBe(150);
    expect(event['costDiff']).toBe(50);
  });

  it('notes-only change: event still fires (zero diffs) — stok/büyüme dokunulmaz', async () => {
    const { handler, enqueue, applyStockCorrection, applyGrowth } = makeHarness();

    await handler.execute(makeCommand({ notes: 'adjusted by operator' }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['amountDiffKg']).toBe(0);
    expect(event['costDiff']).toBe(0);
    // Sayısal fark yoksa ne stok hareketi ne büyüme deltası yazılır.
    expect(applyStockCorrection).not.toHaveBeenCalled();
    expect(applyGrowth).not.toHaveBeenCalled();
  });

  it('miktar düzeltmesi stok hareketini ledger üzerinden yazar (FARM-HIGH-248)', async () => {
    const { handler, applyStockCorrection } = makeHarness();

    await handler.execute(makeCommand({ actualAmount: 15 }));

    expect(applyStockCorrection).toHaveBeenCalledTimes(1);
    const args = applyStockCorrection.mock.calls[0]![3] as Record<string, unknown>;
    expect(args['deltaKg']).toBe(5);
    expect(args['deductionKeyBase']).toBe('feeding-deduct-fr-1');
    // Revizyon sayacı önceki düzeltme hareketlerinden türetilir (1. düzeltme).
    expect(args['correctionKey']).toBe('feeding-correct-fr-1-1');
  });

  it('plan-bağlı kayıtta unplannedActualKg + büyüme deltası AYNI tx te yazılır', async () => {
    const lockedUnit = { tankBatch: {}, batches: new Map(), details: [] };
    const { handler, managerQuery, applyGrowth, recalcForUnit } = makeHarness({
      feedingRecord: { tankId: 'tank-1', dayPlanId: 'dp-1' },
      dayPlan: { id: 'dp-1', siteId: 'site-1', resolution: { expectedFcr: 1.25 } as never },
      lockedUnit,
    });

    await handler.execute(makeCommand({ actualAmount: 15 }));

    const planUpdate = managerQuery.mock.calls.find((call) =>
      String(call[0]).includes('unplannedActualKg'),
    );
    expect(planUpdate).toBeDefined();
    expect(planUpdate![1]).toEqual([5, TENANT_ID, 'dp-1']);
    // +5 kg / FCR 1.25 = +4 kg biyokütle; aşağı düzeltmede işaret terse döner.
    expect(applyGrowth).toHaveBeenCalledTimes(1);
    expect(applyGrowth.mock.calls[0]![3]).toBeCloseTo(4);
    expect(recalcForUnit).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      'tank-1',
      'unplanned_feed',
    );
  });

  it('aşağı düzeltme büyümeyi GERİ ALIR (band kayması bu yüzden oluşuyordu)', async () => {
    const lockedUnit = { tankBatch: {}, batches: new Map(), details: [] };
    const { handler, applyGrowth, applyStockCorrection } = makeHarness({
      feedingRecord: { tankId: 'tank-1', dayPlanId: 'dp-1' },
      dayPlan: { id: 'dp-1', siteId: 'site-1', resolution: { expectedFcr: 1.25 } as never },
      lockedUnit,
    });

    await handler.execute(makeCommand({ actualAmount: 6 }));

    expect(applyGrowth.mock.calls[0]![3]).toBeCloseTo(-3.2); // -4 / 1.25
    expect(
      (applyStockCorrection.mock.calls[0]![3] as Record<string, unknown>)['deltaKg'],
    ).toBeCloseTo(-4);
  });

  it('outbox enqueue failure rolls back the row update', async () => {
    const { handler, rollback, commit } = makeHarness({
      enqueueImpl: async () => {
        throw new Error('outbox-enqueue-failed');
      },
    });

    await expect(handler.execute(makeCommand({ actualAmount: 15 }))).rejects.toThrow(
      'outbox-enqueue-failed',
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });

  it('rejects a meal-bound record (C-11): correction must go through correctMealPour', async () => {
    const { handler, enqueue } = makeHarness({
      feedingRecord: { mealId: 'meal-1', pourIndex: 0 },
    });

    await expect(handler.execute(makeCommand({ actualAmount: 15 }))).rejects.toThrow(
      /correctMealPour/,
    );
    // Reddedilen kayıt için ne event ne batch güncellemesi olur.
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('NotFoundException when feeding record is missing — no tx, no event', async () => {
    const { handler, enqueue } = makeHarness({ feedingRecord: null });

    await expect(handler.execute(makeCommand({ actualAmount: 15 }))).rejects.toThrow(
      NotFoundException,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
