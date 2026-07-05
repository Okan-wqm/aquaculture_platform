/**
 * DailyFeedingExecutionService.applyPendingDailyGrowth — DAILY-mode roll-up.
 *
 * Sums each tank's pending FCR growth (fed / clamped-FCR) and applies ONE weight
 * update to the still-morning biomass, then stamps every processed execution so
 * growth is never applied twice. runInTenantTransaction is mocked to run the
 * callback against a fake EntityManager.
 */
import { DataSource, EntityManager, Repository, ObjectLiteral } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';

const runInTenantTransaction = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (ds: unknown, schema: string, tenantId: string, cb: unknown) =>
    runInTenantTransaction(ds, schema, tenantId, cb),
}));

import { DailyFeedingExecutionService } from '../daily-feeding-execution.service';
import {
  DailyFeedingExecution,
  ExecutionStatus,
} from '../../entities/daily-feeding-execution.entity';
import { TankBatch } from '../../../batch/entities/tank-batch.entity';
import { Tank } from '../../../tank/entities/tank.entity';
import { Batch } from '../../../batch/entities/batch.entity';
import { BilinearInterpolationService } from '../bilinear-interpolation.service';
import { WaterTemperatureService } from '../../../water-quality/services/water-temperature.service';
import { BatchDomainService } from '../../../batch/services/batch-domain.service';
import { StockMovementService } from '../../../storage/services/stock-movement.service';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const TENANT = '11111111-1111-4111-8111-111111111111';

function execFixture(
  id: string,
  fedKg: number | null,
  fcr: number,
  over: Partial<DailyFeedingExecution> = {},
): DailyFeedingExecution {
  return mock<DailyFeedingExecution>({
    id,
    equipmentId: 'tank-1',
    status: ExecutionStatus.COMPLETED,
    actualFeedKg: fedKg,
    executionDate: new Date('2026-07-04T00:00:00.000Z'),
    calculations: mock<DailyFeedingExecution['calculations']>({ expectedFCR: fcr }),
    ...over,
  });
}

/** A fake manager that satisfies applyPendingDailyGrowth + updateTankBiomassWithManager. */
function makeManager(
  pending: DailyFeedingExecution[],
  tankBatch: TankBatch | null,
): {
  manager: EntityManager;
  update: jest.Mock;
  savedTankBatch: () => TankBatch | null;
} {
  const update = jest.fn().mockResolvedValue(undefined);
  const findOne = jest.fn().mockImplementation((entity: unknown) => {
    if (entity === TankBatch) return Promise.resolve(tankBatch);
    return Promise.resolve(null); // no primary Batch, no Tank row → skipped
  });
  const manager = mock<EntityManager>({
    find: jest.fn().mockResolvedValue(pending),
    findOne,
    save: jest.fn().mockResolvedValue(undefined),
    update,
  });
  return { manager, update, savedTankBatch: () => tankBatch };
}

function makeService(): DailyFeedingExecutionService {
  const repo = <T extends ObjectLiteral>(): Repository<T> => mock<Repository<T>>({});
  return new DailyFeedingExecutionService(
    repo(),
    repo(),
    repo(),
    repo<TankBatch>(),
    repo<Batch>(),
    repo<Tank>(),
    repo(),
    mock<BilinearInterpolationService>({}),
    mock<WaterTemperatureService>({}),
    mock<DataSource>({}),
    mock<BatchDomainService>({}),
    mock<StockMovementService>({}),
    mock<OutboxPublisher>({}),
    mock<MobileCommandReceiptService>({}),
    mock<SiteAuthorizationService>({}),
  );
}

beforeEach(() => {
  runInTenantTransaction.mockReset();
});

describe('DailyFeedingExecutionService.applyPendingDailyGrowth', () => {
  it("sums each tank's pending growth into ONE weight update on the morning biomass", async () => {
    // fed 10kg @ FCR 2.0 → 5kg; fed 6kg @ FCR 1.5 → 4kg; total 9kg on 100kg / 1000 fish.
    const pending = [execFixture('e1', 10, 2.0), execFixture('e2', 6, 1.5)];
    const tankBatch = mock<TankBatch>({
      tankId: 'tank-1',
      currentQuantity: 1000,
      currentBiomassKg: 100,
      totalBiomassKg: 100,
    });
    const { manager, update } = makeManager(pending, tankBatch);
    runInTenantTransaction.mockImplementation(
      async (_ds, _s, _t, cb: (qr: { manager: EntityManager }) => Promise<unknown>) =>
        cb({ manager }),
    );

    const result = await makeService().applyPendingDailyGrowth(TENANT);

    expect(result).toEqual({ tanksUpdated: 1, executionsRolledUp: 2 });
    // 100 + 9 = 109 kg → 109 g avg over 1000 fish.
    expect(tankBatch.currentBiomassKg).toBeCloseTo(109, 5);
    expect(tankBatch.avgWeightG).toBeCloseTo(109, 5);
    // Every processed execution stamped so growth is never applied twice.
    const [, criteria, patch] = update.mock.calls[0] as [
      unknown,
      { id: unknown },
      { growthAppliedAt: Date },
    ];
    expect(patch.growthAppliedAt).toBeInstanceOf(Date);
    void criteria;
  });

  it('does nothing when no executions are pending', async () => {
    const { manager, update } = makeManager([], null);
    runInTenantTransaction.mockImplementation(
      async (_ds, _s, _t, cb: (qr: { manager: EntityManager }) => Promise<unknown>) =>
        cb({ manager }),
    );

    const result = await makeService().applyPendingDailyGrowth(TENANT);

    expect(result).toEqual({ tanksUpdated: 0, executionsRolledUp: 0 });
    expect(update).not.toHaveBeenCalled();
  });

  it('evaluates the held-back feed transition against the rolled-up weight (DAILY)', async () => {
    const markFeedTransition = jest.fn();
    const withProgram = execFixture('e1', 10, 2.0, {
      feedingProgram: mock<DailyFeedingExecution['feedingProgram']>({ id: 'prog-1' }),
      markFeedTransition,
    });
    const tankBatch = mock<TankBatch>({
      tankId: 'tank-1',
      currentQuantity: 1000,
      currentBiomassKg: 100,
      totalBiomassKg: 100,
    });
    const { manager } = makeManager([withProgram], tankBatch);
    runInTenantTransaction.mockImplementation(
      async (_ds, _s, _t, cb: (qr: { manager: EntityManager }) => Promise<unknown>) =>
        cb({ manager }),
    );
    const service = makeService();
    const transitionSpy = jest
      .spyOn(service, 'checkAndExecuteTransitionWithManager')
      .mockResolvedValue({ newFeedId: 'feed-2', newFeedCode: 'F2' });

    await service.applyPendingDailyGrowth(TENANT);

    // Transition evaluated once, against the NEW (rolled-up) average weight:
    // 100kg + 10/2.0 = 105kg over 1000 fish → 105 g.
    expect(transitionSpy).toHaveBeenCalledTimes(1);
    expect(transitionSpy.mock.calls[0]?.[2]).toBeCloseTo(105, 5);
    expect(markFeedTransition).toHaveBeenCalledWith('feed-2', 'F2');
  });

  it('stamps zero-fed (skipped-but-completed) executions without a weight update', async () => {
    const pending = [execFixture('e1', 0, 2.0)];
    const tankBatch = mock<TankBatch>({
      tankId: 'tank-1',
      currentQuantity: 1000,
      currentBiomassKg: 100,
      totalBiomassKg: 100,
    });
    const { manager, update } = makeManager(pending, tankBatch);
    runInTenantTransaction.mockImplementation(
      async (_ds, _s, _t, cb: (qr: { manager: EntityManager }) => Promise<unknown>) =>
        cb({ manager }),
    );

    const result = await makeService().applyPendingDailyGrowth(TENANT);

    expect(result).toEqual({ tanksUpdated: 0, executionsRolledUp: 1 });
    // No growth, but still stamped so it stops being scanned.
    expect(update).toHaveBeenCalledTimes(1);
    expect(tankBatch.currentBiomassKg).toBe(100);
  });
});
