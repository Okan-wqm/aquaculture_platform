/**
 * DailyFeedingExecutionService.applyPendingDailyGrowth — DAILY-mode roll-up.
 *
 * Sums each tank's pending FCR growth (fed / clamped-FCR) and applies ONE weight
 * update to the still-morning biomass, then stamps every processed execution so
 * growth is never applied twice. runInTenantTransaction is mocked to run the
 * callback against a fake EntityManager.
 */
import { DataSource, EntityManager, Repository, ObjectLiteral } from 'typeorm';
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
import { FeedingLedgerService } from '../feeding-ledger.service';
import { BiomassGrowthApplierService } from '../../../feeding-protocol/services/biomass-growth-applier.service';
import { ProtocolRateService } from '../../../feeding-protocol/services/protocol-rate.service';
import { UnitProtocolResolverService } from '../../../feeding-protocol/services/unit-protocol-resolver.service';

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

const BATCH_ID = '22222222-2222-4222-8222-222222222222';

/**
 * A tank whose per-batch SSoT is populated. The roll-up now writes through
 * BiomassGrowthApplierService, which distributes the delta across
 * `batchDetails[]` and DERIVES the aggregates from it — so a fixture without
 * batchDetails would exercise nothing.
 */
function tankFixture(over: Partial<TankBatch> = {}): TankBatch {
  return mock<TankBatch>({
    tankId: 'tank-1',
    totalQuantity: 1000,
    currentBiomassKg: 100,
    totalBiomassKg: 100,
    avgWeightG: 100,
    primaryBatchId: BATCH_ID,
    primaryBatchNumber: 'B-1',
    batchDetails: [
      {
        batchId: BATCH_ID,
        batchNumber: 'B-1',
        quantity: 1000,
        avgWeightG: 100,
        biomassKg: 100,
        percentageOfTank: 100,
      },
    ],
    ...over,
  });
}

/** A fake manager that satisfies applyPendingDailyGrowth + the growth applier. */
function makeManager(
  pending: DailyFeedingExecution[],
  tankBatch: TankBatch | null,
): {
  manager: EntityManager;
  update: jest.Mock;
  batch: Batch;
  savedTankBatch: () => TankBatch | null;
} {
  const update = jest.fn().mockResolvedValue(undefined);
  const batch = mock<Batch>({
    id: BATCH_ID,
    tenantId: TENANT,
    stockedAt: new Date('2026-01-01T00:00:00.000Z'),
    weight: {
      initial: { avgWeight: 50, totalBiomass: 50, measuredAt: new Date(0) },
      theoretical: {
        avgWeight: 100,
        totalBiomass: 100,
        lastCalculatedAt: new Date(0),
        basedOnFCR: 0,
      },
      actual: {
        avgWeight: 0,
        totalBiomass: 0,
        lastMeasuredAt: new Date(0),
        sampleSize: 0,
        confidencePercent: 0,
      },
      variance: { weightDifference: 0, percentageDifference: 0, isSignificant: false },
    },
  });
  const findOne = jest.fn().mockImplementation((entity: unknown) => {
    if (entity === TankBatch) return Promise.resolve(tankBatch);
    return Promise.resolve(null); // no Tank projection row → P-13 metric path
  });
  const find = jest.fn().mockImplementation((entity: unknown) => {
    if (entity === Batch) return Promise.resolve([batch]);
    return Promise.resolve(pending);
  });
  const manager = mock<EntityManager>({
    find,
    findOne,
    save: jest.fn().mockImplementation(async (_e: unknown, v?: unknown) => v ?? _e),
    update,
    // Cross-unit share sums for the applier's D-1 recomputation.
    query: jest.fn().mockImplementation(async () => {
      const detail = tankBatch?.batchDetails?.[0];
      return [{ biomass: detail?.biomassKg ?? 0, quantity: detail?.quantity ?? 0 }];
    }),
  });
  return { manager, update, batch, savedTankBatch: () => tankBatch };
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
    mock<FeedingLedgerService>({}),
    // The REAL single writer: the roll-up must go through it, not around it.
    new BiomassGrowthApplierService(),
    mock<MobileCommandReceiptService>({}),
    mock<SiteAuthorizationService>({}),
    new UnitProtocolResolverService(new ProtocolRateService()),
  );
}

beforeEach(() => {
  runInTenantTransaction.mockReset();
});

describe('DailyFeedingExecutionService.applyPendingDailyGrowth', () => {
  it("sums each tank's pending growth into ONE weight update on the morning biomass", async () => {
    // fed 10kg @ FCR 2.0 → 5kg; fed 6kg @ FCR 1.5 → 4kg; total 9kg on 100kg / 1000 fish.
    const pending = [execFixture('e1', 10, 2.0), execFixture('e2', 6, 1.5)];
    const tankBatch = tankFixture();
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
    const tankBatch = tankFixture();
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
    const tankBatch = tankFixture();
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

describe('DailyFeedingExecutionService.applyPendingDailyGrowth — one writer, honest provenance (0.5)', () => {
  const runTx = (manager: EntityManager): void => {
    runInTenantTransaction.mockImplementation(
      async (_ds, _s, _t, cb: (qr: { manager: EntityManager }) => Promise<unknown>) =>
        cb({ manager }),
    );
  };

  it("stamps the day's EFFECTIVE FCR, never the 0 the old `?? 1.0` produced", async () => {
    // fed 10 @2.0 → 5 kg; fed 6 @1.5 → 4 kg. Σfed 16 / Σgrowth 9 = 1.777…
    const pending = [execFixture('e1', 10, 2.0), execFixture('e2', 6, 1.5)];
    const tankBatch = tankFixture();
    const { manager, batch } = makeManager(pending, tankBatch);
    runTx(manager);

    await makeService().applyPendingDailyGrowth(TENANT);

    // The old writer set `basedOnFCR = batch.fcr?.actual ?? 1.0`; fcr.actual is
    // 0 for every live batch and `??` does not coalesce 0, so it persisted 0 —
    // a feed conversion ratio that cannot exist.
    expect(batch.weight.theoretical.basedOnFCR).toBeCloseTo(16 / 9, 6);
    expect(batch.weight.theoretical.basedOnFCR).not.toBe(0);
    expect(batch.weight.theoretical.basedOnFCR).not.toBe(1.0);
  });

  it('tags the roll-up as an FCR PROJECTION, not a measurement', async () => {
    const tankBatch = tankFixture();
    const { manager } = makeManager([execFixture('e1', 10, 2.0)], tankBatch);
    runTx(manager);

    await makeService().applyPendingDailyGrowth(TENANT);

    expect(tankBatch.weightProvenance).toMatchObject({ source: 'fcr_projection' });
    // Feeding a tank is not weighing it.
    expect(tankBatch.lastSamplingAt).toBeUndefined();
  });

  it('keeps batchDetails[] intact and derives the aggregate from it', async () => {
    const tankBatch = tankFixture();
    const { manager } = makeManager([execFixture('e1', 10, 2.0)], tankBatch);
    runTx(manager);

    await makeService().applyPendingDailyGrowth(TENANT);

    // The deleted writer set the aggregates directly and never touched
    // batchDetails, so the per-batch SSoT silently drifted from its own total.
    const details = tankBatch.batchDetails!;
    expect(details).toHaveLength(1);
    expect(details[0]!.biomassKg).toBeCloseTo(105); // 100 + 10/2.0
    expect(details[0]!.avgWeightG).toBeCloseTo(105);
    expect(tankBatch.totalBiomassKg).toBeCloseTo(details.reduce((acc, d) => acc + d.biomassKg, 0));
    // The count is not a growth concern and must not move.
    expect(tankBatch.totalQuantity).toBe(1000);
    expect(details[0]!.quantity).toBe(1000);
  });
});
