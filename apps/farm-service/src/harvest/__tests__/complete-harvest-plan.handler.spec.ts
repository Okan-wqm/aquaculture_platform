/**
 * CompleteHarvestPlanHandler — completing a plan moves real stock, atomically.
 *
 * FARM-HIGH-359: completing a plan used to write only the plan's own "actual"
 * fields, so the batch quantity and the tank stock never moved.
 *
 * FARM-HIGH-394: #1670 then moved the stock through one
 * CreateHarvestRecordCommand per tank — each its own transaction — and saved
 * the plan COMPLETED last without locking it, so a failure on tank 2 left
 * tank 1 harvested and a retry or double-submit harvested again. Completion is
 * now ONE transaction: plan row locked, every tank written through the single
 * HarvestRecordWriter on that transaction's manager, plan saved COMPLETED in
 * it. (The real-Postgres rollback + double-submit proof is
 * `__tests__/e2e/complete-harvest-plan-atomicity.postgres.spec.ts`.)
 *
 * FARM-HIGH-396: the harvest records carry the caller's quality class and no
 * fabricated buyer / customer delivery.
 *
 * SEC-HIGH-188: a caller below the completeHarvestPlan floor — an empty role
 * set included — is refused before anything is read; the verified caller is
 * carried unchanged into every write.
 */
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Role } from '@aquaculture/backend-common/decorators';
import type { SiteScopeCaller } from '@aquaculture/backend-common/security';
import { collaborator, createMockDataSource, stub } from '@aquaculture/testing';
import type { SelectQueryBuilder } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { TankBatch, type BatchDetail } from '../../batch/entities/tank-batch.entity';
import { Tank } from '../../tank/entities/tank.entity';
import type { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import {
  CompleteHarvestPlanCommand,
  type CompleteHarvestPlanActuals,
} from '../commands/complete-harvest-plan.command';
import { HarvestPlan, HarvestPlanStatus } from '../entities/harvest-plan.entity';
import { HarvestRecord, QualityClass } from '../entities/harvest-record.entity';
import { CompleteHarvestPlanHandler } from '../handlers/complete-harvest-plan.handler';
import type {
  HarvestRecordWrite,
  HarvestRecordWriter,
  HarvestRecordWriteResult,
} from '../services/harvest-record-writer.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const PLAN_ID = '22222222-2222-4222-8222-222222222222';
const BATCH_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_BATCH_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '55555555-5555-4555-8555-555555555555';
const SITE_ID = '66666666-6666-4666-8666-666666666666';

function caller(roles: Role[], assignedSiteIds: string[] = []): SiteScopeCaller {
  return { sub: USER_ID, roles, assignedSiteIds };
}

function detail(batchId: string, quantity: number): BatchDetail {
  return {
    batchId,
    batchNumber: `B-${quantity}`,
    quantity,
    avgWeightG: 50,
    biomassKg: (quantity * 50) / 1000,
    percentageOfTank: 100,
  };
}

function tankBatch(tankId: string, details: BatchDetail[]): TankBatch {
  return Object.assign(new TankBatch(), {
    tenantId: TENANT_ID,
    tankId,
    batchDetails: details,
    totalQuantity: details.reduce((sum, d) => sum + d.quantity, 0),
  });
}

const ACTUALS: CompleteHarvestPlanActuals = {
  actualQuantity: 400,
  actualBiomass: 20,
  actualAvgWeight: 50,
  qualityClass: QualityClass.ORDINAER,
};

interface HarnessOptions {
  status?: HarvestPlanStatus;
  tankBatches?: TankBatch[];
  /** Fail the writer on the n-th tank (1-based). */
  failOnWrite?: number;
  /** The n-th write empties the batch (1-based). */
  finalOnWrite?: number;
  completedWith?: Partial<HarvestPlan>;
}

function harness(options: HarnessOptions = {}) {
  const plan = Object.assign(new HarvestPlan(), {
    id: PLAN_ID,
    tenantId: TENANT_ID,
    planCode: 'HP-2026-00001',
    batchId: BATCH_ID,
    status: options.status ?? HarvestPlanStatus.IN_PROGRESS,
    ...options.completedWith,
  });
  const batch = Object.assign(new Batch(), { id: BATCH_ID, tenantId: TENANT_ID });
  const events: string[] = [];

  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSource();
  mockManager.findOne.mockImplementation((entity: unknown) => {
    if (entity === HarvestPlan) return Promise.resolve(plan);
    if (entity === Batch) return Promise.resolve(batch);
    return Promise.resolve(null);
  });
  mockManager.save.mockImplementation((_entity: unknown, value: unknown) => {
    if (value instanceof HarvestPlan) events.push(`save:${value.status}`);
    return Promise.resolve(value);
  });
  const stockQuery = {
    where: jest.fn(),
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    setLock: jest.fn(),
    getMany: jest.fn().mockResolvedValue(options.tankBatches ?? []),
  };
  for (const method of ['where', 'andWhere', 'orderBy', 'setLock'] as const) {
    stockQuery[method].mockReturnValue(stockQuery);
  }
  mockManager.createQueryBuilder.mockReturnValue(stub<SelectQueryBuilder<TankBatch>>(stockQuery));

  const writes: HarvestRecordWrite[] = [];
  const write = jest.fn(
    (_manager: unknown, request: HarvestRecordWrite): Promise<HarvestRecordWriteResult> => {
      writes.push(request);
      events.push(`write:${plan.status}`);
      if (options.failOnWrite === writes.length) {
        return Promise.reject(new Error(`tank ${request.input.tankId} failed`));
      }
      return Promise.resolve({
        harvestRecord: Object.assign(new HarvestRecord(), { id: `hr-${writes.length}` }),
        isFinalHarvest: options.finalOnWrite === writes.length,
        recordCode: `HR-2026-0000${writes.length}`,
      });
    },
  );
  const closeBatchAfterFinalHarvest = jest.fn().mockResolvedValue(undefined);
  const writer = collaborator<HarvestRecordWriter>(
    { write, closeBatchAfterFinalHarvest },
    'HarvestRecordWriter',
  );
  const financeSettings = collaborator<FinanceSettingsService>(
    { getDefaultCurrency: jest.fn().mockResolvedValue('NOK') },
    'FinanceSettingsService',
  );

  const handler = new CompleteHarvestPlanHandler(mockDataSource, financeSettings, writer);
  return {
    handler,
    plan,
    writes,
    write,
    events,
    closeBatchAfterFinalHarvest,
    mockManager,
    stockQuery,
    commit: mockQueryRunner.commitTransaction,
    rollback: mockQueryRunner.rollbackTransaction,
  };
}

function complete(
  who: SiteScopeCaller = caller([Role.MODULE_MANAGER], [SITE_ID]),
  actuals: CompleteHarvestPlanActuals = ACTUALS,
): CompleteHarvestPlanCommand {
  return new CompleteHarvestPlanCommand(TENANT_ID, PLAN_ID, actuals, who);
}

describe('CompleteHarvestPlanHandler — stock movement in one transaction (FARM-HIGH-394)', () => {
  it('writes one harvest per stocked tank, proportional, then saves the plan COMPLETED in the same transaction', async () => {
    const h = harness({
      tankBatches: [
        tankBatch('tank-a', [detail(BATCH_ID, 600)]),
        tankBatch('tank-b', [detail(BATCH_ID, 200), detail(OTHER_BATCH_ID, 999)]),
      ],
    });

    const result = await h.handler.execute(complete());

    expect(h.writes.map((w) => [w.input.tankId, w.input.quantityHarvested])).toEqual([
      ['tank-a', 300],
      ['tank-b', 100],
    ]);
    for (const request of h.writes) {
      expect(request.tenantId).toBe(TENANT_ID);
      expect(request.input.batchId).toBe(BATCH_ID);
      expect(request.input.harvestPlanId).toBe(PLAN_ID);
      expect(request.caller).toEqual(caller([Role.MODULE_MANAGER], [SITE_ID]));
      expect(request.defaultCurrency).toBe('NOK');
    }
    // Every write receives the transaction's own manager.
    expect(h.write.mock.calls.every(([manager]) => manager === h.mockManager)).toBe(true);
    expect(h.events).toEqual([
      `write:${HarvestPlanStatus.IN_PROGRESS}`,
      `write:${HarvestPlanStatus.IN_PROGRESS}`,
      `save:${HarvestPlanStatus.COMPLETED}`,
    ]);
    expect(h.commit).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(HarvestPlanStatus.COMPLETED);
    expect(result.actualQuantityHarvested).toBe(400);
  });

  it('locks the plan row and the stock rows before reading them', async () => {
    const h = harness({ tankBatches: [tankBatch('tank-a', [detail(BATCH_ID, 600)])] });

    await h.handler.execute(complete());

    expect(h.mockManager.findOne).toHaveBeenCalledWith(HarvestPlan, {
      where: { id: PLAN_ID, tenantId: TENANT_ID },
      lock: { mode: 'pessimistic_write' },
    });
    expect(h.stockQuery.setLock).toHaveBeenCalledWith('pessimistic_write');
  });

  it('locks tanks before their tank-batch rows, the order every stock write takes (FARM-MEDIUM-400)', async () => {
    const h = harness({
      tankBatches: [
        tankBatch('tank-b', [detail(BATCH_ID, 200)]),
        tankBatch('tank-a', [detail(BATCH_ID, 600)]),
      ],
    });

    await h.handler.execute(complete());

    // Unlocked candidate read, then tanks FOR UPDATE, then tank-batch rows FOR UPDATE.
    expect(h.mockManager.createQueryBuilder.mock.calls.map(([entity]) => entity)).toEqual([
      TankBatch,
      Tank,
      TankBatch,
    ]);
    expect(h.stockQuery.setLock).toHaveBeenCalledTimes(2);
    expect(h.stockQuery.andWhere).toHaveBeenCalledWith('t.id IN (:...tankIds)', {
      tankIds: ['tank-a', 'tank-b'],
    });
  });

  it('books the counted biomass exactly across the tanks', async () => {
    const h = harness({
      tankBatches: [
        tankBatch('tank-a', [detail(BATCH_ID, 1)]),
        tankBatch('tank-b', [detail(BATCH_ID, 1)]),
        tankBatch('tank-c', [detail(BATCH_ID, 1)]),
      ],
    });

    await h.handler.execute(
      complete(undefined, { ...ACTUALS, actualQuantity: 3, actualBiomass: 1 }),
    );

    const booked = h.writes.reduce((sum, w) => sum + w.input.totalBiomass, 0);
    expect(Number(booked.toFixed(3))).toBe(1);
  });

  it('a failure on tank 2 aborts the whole completion: rolled back, plan never saved', async () => {
    const h = harness({
      tankBatches: [
        tankBatch('tank-a', [detail(BATCH_ID, 600)]),
        tankBatch('tank-b', [detail(BATCH_ID, 200)]),
      ],
      failOnWrite: 2,
    });

    await expect(h.handler.execute(complete())).rejects.toThrow('tank tank-b failed');

    expect(h.rollback).toHaveBeenCalledTimes(1);
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.events).not.toContain(`save:${HarvestPlanStatus.COMPLETED}`);
    expect(h.closeBatchAfterFinalHarvest).not.toHaveBeenCalled();
  });

  it('runs the batch-closure chain after the commit when the completion empties the batch', async () => {
    const h = harness({
      tankBatches: [tankBatch('tank-a', [detail(BATCH_ID, 400)])],
      finalOnWrite: 1,
    });

    await h.handler.execute(complete());

    expect(h.closeBatchAfterFinalHarvest).toHaveBeenCalledWith(
      TENANT_ID,
      BATCH_ID,
      USER_ID,
      'HR-2026-00001',
    );
    expect(h.commit.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
      h.closeBatchAfterFinalHarvest.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe('CompleteHarvestPlanHandler — plan state (FARM-HIGH-394)', () => {
  it('a repeated completion with the same counted results is an idempotent no-op', async () => {
    const h = harness({
      status: HarvestPlanStatus.COMPLETED,
      completedWith: {
        actualQuantityHarvested: 400,
        actualBiomassHarvested: 20,
        actualAvgWeight: 50,
      },
      tankBatches: [tankBatch('tank-a', [detail(BATCH_ID, 600)])],
    });

    const result = await h.handler.execute(complete());

    expect(result).toBe(h.plan);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('a completion with different results against a COMPLETED plan is a conflict', async () => {
    const h = harness({
      status: HarvestPlanStatus.COMPLETED,
      completedWith: {
        actualQuantityHarvested: 350,
        actualBiomassHarvested: 20,
        actualAvgWeight: 50,
      },
    });

    await expect(h.handler.execute(complete())).rejects.toThrow(ConflictException);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('refuses a plan that is not in progress and moves no stock', async () => {
    const h = harness({
      status: HarvestPlanStatus.SCHEDULED,
      tankBatches: [tankBatch('tank-a', [detail(BATCH_ID, 600)])],
    });

    await expect(h.handler.execute(complete())).rejects.toThrow(BadRequestException);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
});

describe('CompleteHarvestPlanHandler — counted quantity vs book stock (FARM-MEDIUM-397)', () => {
  it('refuses a count above the book stock with the figures, moving nothing', async () => {
    const h = harness({ tankBatches: [tankBatch('tank-a', [detail(BATCH_ID, 150)])] });

    await expect(h.handler.execute(complete())).rejects.toThrow(
      /Counted harvest quantity 400 exceeds the batch's book stock of 150/,
    );
    expect(h.write).not.toHaveBeenCalled();
    expect(h.rollback).toHaveBeenCalledTimes(1);
  });

  it('refuses a completion when no tank holds the batch', async () => {
    const h = harness({ tankBatches: [tankBatch('tank-c', [detail(OTHER_BATCH_ID, 500)])] });

    await expect(h.handler.execute(complete())).rejects.toThrow(BadRequestException);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
});

describe('CompleteHarvestPlanHandler — recorded facts (FARM-HIGH-396)', () => {
  it("records the caller's quality class and no buyer or customer delivery", async () => {
    const h = harness({ tankBatches: [tankBatch('tank-a', [detail(BATCH_ID, 600)])] });

    await h.handler.execute(
      complete(undefined, { ...ACTUALS, qualityClass: QualityClass.PRODUKSJONSFISK }),
    );

    const [request] = h.writes;
    expect(request?.input.qualityClass).toBe(QualityClass.PRODUKSJONSFISK);
    expect(request?.input.buyerName).toBeUndefined();
    expect(request?.input.pricePerKg).toBeUndefined();
  });
});

describe('CompleteHarvestPlanHandler — caller authority (SEC-HIGH-188)', () => {
  const stocked = (): TankBatch[] => [tankBatch('tank-a', [detail(BATCH_ID, 600)])];

  it('refuses a caller with no roles: nothing is read, moved or saved', async () => {
    const h = harness({ tankBatches: stocked() });

    await expect(h.handler.execute(complete(caller([], [SITE_ID])))).rejects.toThrow(
      ForbiddenException,
    );
    expect(h.mockManager.findOne).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('refuses a caller below the completeHarvestPlan floor even when site-assigned', async () => {
    const h = harness({ tankBatches: stocked() });

    await expect(
      h.handler.execute(complete(caller([Role.MODULE_USER], [SITE_ID]))),
    ).rejects.toThrow(ForbiddenException);
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each([[Role.MODULE_MANAGER], [Role.TENANT_ADMIN], [Role.SUPER_ADMIN]])(
    'carries the verified %s caller unchanged into the stock movement',
    async (role) => {
      const h = harness({ tankBatches: stocked() });

      await h.handler.execute(complete(caller([role])));

      expect(h.writes.map((w) => w.caller)).toEqual([caller([role])]);
    },
  );
});
