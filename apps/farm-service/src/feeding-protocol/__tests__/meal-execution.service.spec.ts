/**
 * MealExecutionService (Faz 5 — plan §2 akışı).
 *
 * Pinler: legacy (envelope'suz) mod REDDedilir (C-17); replay saklı sonucu
 * HİÇBİR kilit almadan döner; döküm kümülatif eklenir ve ledger'a öğün
 * bağlarıyla (mealId/pourIndex) gider (D-8/P-05); finalize varyansı hesaplar,
 * per_meal büyümeyi actualKg/beklenenFCR ile uygular ve kalan öğünleri AYNI
 * tx'te recalc eder; az-atım eşiği aşımı MealUnderfed üretir (P-21); site
 * yetkisi yazma içinde fail-closed doğrulanır (SEC-HIGH-051); skipMeal
 * scheduled dışını reddeder ve MealSkipped yazar.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  MobileCommandReceiptService,
  type MobileCommandReceiptState,
} from '@aquaculture/backend-common/mobile-command';
import { SiteAuthorizationService } from '@aquaculture/backend-common/security';
import { Role } from '@aquaculture/backend-common/decorators';

import { MealExecutionService, type MealCaller } from '../services/meal-execution.service';
import {
  BiomassGrowthApplierService,
  type LockedUnit,
} from '../services/biomass-growth-applier.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { FeedingLedgerService } from '../../feeding/services/feeding-ledger.service';
import { BatchDomainService } from '../../batch/services/batch-domain.service';
import { BatchLifecyclePolicyService } from '../../batch/services/batch-lifecycle-policy.service';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { FeedingDayPlan, FeedingDayPlanStatus } from '../entities/feeding-day-plan.entity';
import {
  FeedingProtocolV2,
  ProtocolFcrSource,
  FcrResolvedSource,
} from '../entities/feeding-protocol-v2.entity';
import { Feed } from '../../feed/entities/feed.entity';
import { FeedingRecord } from '../../feeding/entities/feeding-record.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { FeedAllocationService } from '../../storage/services/feed-allocation.service';
import { Batch, BatchStatus } from '../../batch/entities/batch.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';

jest.mock('@aquaculture/backend-common/database', () => ({
  // Barrel'ın kalanı (DecimalTransformer vb.) entity yüklemeleri için GERÇEK
  // kalır; yalnız transaction sınırı test manager'ına yönlendirilir.
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: jest.fn(
    async (
      _ds: unknown,
      _schema: string,
      _tenantId: string,
      cb: (qr: unknown) => Promise<unknown>,
    ) => cb({ manager: globalThis.__mealExecManager }),
  ),
}));

jest.mock('../../batch/utils/tank-lookup.util', () => ({
  resolveTankSiteId: jest.fn(async () => 'site-1'),
}));

declare global {
  var __mealExecManager: EntityManager;
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const UNIT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEAL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PLAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const BATCH = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

const CALLER: MealCaller = { sub: 'user-1', roles: [Role.MODULE_MANAGER], assignedSiteIds: [] };

const ENVELOPE = {
  clientCommandId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  payloadHash: 'hash',
  operationType: 'recordMealFeeding',
};

interface HarnessOpts {
  receiptMode?: MobileCommandReceiptState;
  meal?: Partial<FeedingMeal>;
  openMealsAfter?: number;
  growthMode?: 'per_meal' | 'daily';
  feedingRecord?: Partial<FeedingRecord> | null;
}

function makeHarness(opts: HarnessOpts = {}) {
  const meal = mock<FeedingMeal>({
    id: MEAL,
    tenantId: TENANT,
    dayPlanId: PLAN,
    unitId: UNIT,
    siteId: 'site-1',
    mealIndex: 0,
    plannedKg: 10,
    actualKg: 0,
    pours: [],
    status: FeedingMealStatus.SCHEDULED,
    feedId: 'feed-1',
    ...opts.meal,
  });
  const dayPlan = mock<FeedingDayPlan>({
    id: PLAN,
    tenantId: TENANT,
    protocolId: 'protocol-1',
    unitId: UNIT,
    unitCode: 'T-01',
    status: FeedingDayPlanStatus.PLANNED,
    // FARM-CRITICAL-244: mod PLANIN kolonudur; protokol ayarı sonradan
    // değişse bile bu plan üretildiği semantikle işlenir.
    growthApplicationMode: opts.growthMode ?? 'per_meal',
    snapshot: {
      avgWeightG: 100,
      fishCount: 1000,
      biomassKg: 100,
      waterTempC: null,
      temperatureSource: 'none',
      usingDefaultTemperature: true,
      bandIndex: 0,
      feed: { id: 'feed-1', code: 'FA', name: 'Feed A' },
      baseRatePercent: 3,
      tempMultiplier: 1,
      effectiveRatePercent: 3,
      expectedFcr: 1.25,
      fcrResolvedSource: FcrResolvedSource.OVERRIDE,
    },
  });
  const protocol = mock<FeedingProtocolV2>({
    id: 'protocol-1',
    settings: {
      autoTransition: true,
      transitionBufferG: 5,
      growthApplicationMode: opts.growthMode ?? 'per_meal',
      underfeedAlertThresholdPercent: 15,
      fcrSource: ProtocolFcrSource.BAND,
    },
    bands: [],
    defaultMealSchedule: { mealsPerDay: 1, entries: [] },
  });
  const batch = mock<Batch>({
    id: BATCH,
    isActive: true,
    status: BatchStatus.ACTIVE,
    currentQuantity: 1000,
  });
  const lockedUnit: LockedUnit = {
    tankBatch: mock<TankBatch>({ tankId: UNIT, primaryBatchId: BATCH }),
    batches: new Map([[BATCH, batch]]),
    details: [],
  };

  const saved: unknown[] = [];
  const enqueued: Array<{ eventType: string }> = [];

  const feedingRecord =
    opts.feedingRecord === null
      ? null
      : mock<FeedingRecord>({
          id: 'rec-1',
          tenantId: TENANT,
          batchId: BATCH,
          feedId: 'feed-1',
          mealId: MEAL,
          pourIndex: 0,
          actualAmount: 4,
          feedCost: 8,
          calculateVariance: jest.fn(),
          ...(opts.feedingRecord ?? {}),
        });
  const findOne = jest.fn();
  findOne.mockImplementation(async (entity: unknown) => {
    if (entity === FeedingMeal) return meal;
    if (entity === FeedingDayPlan) return dayPlan;
    if (entity === FeedingProtocolV2) return protocol;
    if (entity === Feed) return mock<Feed>({ id: 'feed-1', pricePerKg: 2 });
    if (entity === FeedingRecord) return feedingRecord;
    return null;
  });
  /** settleDayPlanStatus'un hedeflenmiş update'leri (M-1). */
  const updates: Array<{ criteria: unknown; patch: unknown }> = [];
  const save = jest.fn();
  save.mockImplementation(async (entity: unknown) => {
    saved.push(entity);
    return entity;
  });
  const count = jest.fn();
  count.mockImplementation(async () => opts.openMealsAfter ?? 1);
  const managerQuery = jest.fn();
  managerQuery.mockImplementation(async () => [{ fromLocationId: 'loc-1', lotNumber: 'LOT-A' }]);

  const update = jest.fn();
  update.mockImplementation(async (_entity: unknown, criteria: unknown, patch: unknown) => {
    updates.push({ criteria, patch });
    return { affected: 1 };
  });

  const manager = mock<EntityManager>({ findOne, save, count, query: managerQuery, update });
  globalThis.__mealExecManager = manager;

  // Servis üyeleri tipli — double'lar ANOTASYONSUZ jest.fn() (Mock<any>) ile
  // yapısal atanabilir kalır; davranış mockImplementation ile verilir.
  const receiptBegin = jest.fn();
  receiptBegin.mockImplementation(
    async () => opts.receiptMode ?? { mode: 'started', receiptId: 'r-1' },
  );
  const receiptComplete = jest.fn();
  receiptComplete.mockResolvedValue(undefined);
  const receiptService = mock<MobileCommandReceiptService>({
    begin: receiptBegin,
    complete: receiptComplete,
  });
  const siteAuth = mock<SiteAuthorizationService>({ assertSiteAssignment: jest.fn() });
  const lockUnitForGrowth = jest.fn();
  lockUnitForGrowth.mockImplementation(async () => lockedUnit);
  const applyGrowth = jest.fn();
  applyGrowth.mockResolvedValue(undefined);
  const growthApplier = mock<BiomassGrowthApplierService>({ lockUnitForGrowth, applyGrowth });
  const recalcForUnit = jest.fn();
  recalcForUnit.mockResolvedValue(null);
  const recalcService = mock<DayPlanRecalcService>({ recalcForUnit });
  const recordFeed = jest.fn();
  recordFeed.mockImplementation(async () => mock({ id: 'rec-1' }));
  // Düzeltmenin stok ayağı ledger'da TEK uygulama (FARM-MEDIUM-253/254):
  // hareket-tabanlı ön koşul + LIFO iade orada pinlenir; burada çağrı
  // sözleşmesi doğrulanır.
  const applyStockCorrection = jest.fn();
  applyStockCorrection.mockResolvedValue(undefined);
  const feedingLedger = mock<FeedingLedgerService>({ recordFeed, applyStockCorrection });
  const feedHasStoragePresence = jest.fn();
  feedHasStoragePresence.mockResolvedValue(true);
  const resolveFeedDeductionLocation = jest.fn();
  resolveFeedDeductionLocation.mockImplementation(async () => ({
    storageLocationId: 'loc-1',
    lotNumber: 'LOT-A',
    usedSiteFallback: false,
  }));
  const recordMovement = jest.fn();
  recordMovement.mockImplementation(async () => ({
    saved: mock({ id: 'mv-1' }),
    currentTotal: 0,
    idempotentHit: false,
    lowStock: null,
    warnings: [],
  }));
  const stockMovementService = mock<StockMovementService>({
    feedHasStoragePresence,
    resolveFeedDeductionLocation,
    recordMovement,
  });
  const batchDomainService = new BatchDomainService(new BatchLifecyclePolicyService());
  const outbox = mock<OutboxPublisher>({
    enqueue: jest.fn(async (event: { eventType: string }) => {
      enqueued.push(event);
      return undefined as never;
    }),
  });

  // FARM-CRITICAL-245 tahsis motoru — harness tek dilim döner.
  const allocateForDeduction = jest.fn();
  allocateForDeduction.mockImplementation(
    async (_m: unknown, _t: unknown, args: { quantityKg: number }) => ({
      slices: [{ storageLocationId: 'loc-1', lotNumber: 'LOT-A', quantityKg: args.quantityKg }],
      usedSiteFallback: false,
      poolTotalKg: args.quantityKg,
    }),
  );
  const feedAllocation = mock<FeedAllocationService>({ allocateForDeduction });

  const service = new MealExecutionService(
    mock<DataSource>({}),
    receiptService,
    siteAuth,
    growthApplier,
    recalcService,
    feedingLedger,
    batchDomainService,
    stockMovementService,
    feedAllocation,
    outbox,
  );

  return {
    service,
    meal,
    dayPlan,
    findOne,
    growthApplier,
    recalcService,
    feedingLedger,
    siteAuth,
    receiptComplete,
    enqueued,
    recordMovement,
    applyStockCorrection,
    feedingRecord,
    lockedUnit,
    updates,
    saved,
  };
}

const baseParams = (over: Record<string, unknown> = {}) => ({
  tenantId: TENANT,
  userId: 'user-1',
  caller: CALLER,
  mealId: MEAL,
  pourKg: 4,
  finalize: false,
  envelope: ENVELOPE,
  ...over,
});

describe('MealExecutionService.recordMealFeeding', () => {
  it('rejects the legacy (no-envelope) mode fail-closed (C-17)', async () => {
    const harness = makeHarness({ receiptMode: { mode: 'legacy' } });
    await expect(
      harness.service.recordMealFeeding(baseParams({ envelope: undefined })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(harness.findOne).not.toHaveBeenCalled(); // hiçbir kilit alınmadı
  });

  it('returns the stored result on replay WITHOUT acquiring any lock', async () => {
    const stored = { id: MEAL, status: 'fed', actualKg: 10, varianceKg: 0, variancePercent: 0 };
    const harness = makeHarness({
      receiptMode: {
        mode: 'replay',
        responseType: 'FeedingMeal',
        responseId: MEAL,
        responsePayload: stored,
      },
    });
    const result = await harness.service.recordMealFeeding(baseParams());
    expect(result).toEqual(stored);
    expect(harness.findOne).not.toHaveBeenCalled();
    expect(harness.feedingLedger.recordFeed).not.toHaveBeenCalled();
  });

  it('appends a pour cumulatively and routes it through the ledger with meal linkage (D-8/P-05)', async () => {
    const harness = makeHarness({
      meal: { actualKg: 3, pours: [{ pourIndex: 0, kg: 3, at: 'x', by: 'u' }] },
    });
    const result = await harness.service.recordMealFeeding(baseParams());

    expect(result.status).toBe(FeedingMealStatus.PARTIALLY_FED);
    expect(result.actualKg).toBeCloseTo(7); // 3 + 4 kümülatif
    expect(harness.meal.pours).toHaveLength(2);
    const ledgerCall = (harness.feedingLedger.recordFeed as jest.Mock).mock.calls[0];
    expect(ledgerCall[5]).toMatchObject({
      mealId: MEAL,
      pourIndex: 1,
      dayPlanId: PLAN,
      siteId: 'site-1',
    });
    expect(harness.enqueued.map((event) => event.eventType)).toContain('MealFed');
    expect(harness.siteAuth.assertSiteAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site-1' }),
    );
    // finalize edilmedi → growth/recalc yok, varyans yok.
    expect(harness.growthApplier.applyGrowth).not.toHaveBeenCalled();
    expect(result.varianceKg).toBeNull();
  });

  it('finalize computes variance, applies per-meal growth (actual/FCR) and recalcs remaining meals', async () => {
    const harness = makeHarness({ meal: { actualKg: 6 }, openMealsAfter: 2 });
    const result = await harness.service.recordMealFeeding(baseParams({ finalize: true }));

    expect(result.status).toBe(FeedingMealStatus.FED);
    expect(result.actualKg).toBeCloseTo(10); // 6 + 4
    expect(result.varianceKg).toBeCloseTo(0);
    // growthKg = 10 / 1.25 = 8 (snapshot'taki OVERRIDE'lı FCR aynen)
    const growthCall = (harness.growthApplier.applyGrowth as jest.Mock).mock.calls[0];
    expect(growthCall[3]).toBeCloseTo(8);
    expect(growthCall[4]).toBe(1.25);
    expect(harness.recalcService.recalcForUnit).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      UNIT,
      'meal_growth',
    );
    expect(harness.dayPlan.status).toBe(FeedingDayPlanStatus.IN_PROGRESS);
    expect(harness.receiptComplete).toHaveBeenCalled();
  });

  it('emits MealUnderfed(scope=meal) when the finalize variance crosses the threshold (P-21)', async () => {
    // planned 10, actual 4 → -%60 < -%15 eşiği
    const harness = makeHarness({ openMealsAfter: 0 });
    await harness.service.recordMealFeeding(baseParams({ finalize: true }));

    const types = harness.enqueued.map((event) => event.eventType);
    expect(types).toContain('MealUnderfed');
    expect(harness.dayPlan.status).toBe(FeedingDayPlanStatus.COMPLETED); // açık öğün kalmadı
  });

  it('defers growth to the rollup in daily mode (no applyGrowth at finalize)', async () => {
    const harness = makeHarness({ growthMode: 'daily', meal: { actualKg: 6 } });
    await harness.service.recordMealFeeding(baseParams({ finalize: true }));
    expect(harness.growthApplier.applyGrowth).not.toHaveBeenCalled();
    expect(harness.recalcService.recalcForUnit).not.toHaveBeenCalled();
  });

  it('rejects pours on a closed meal (only scheduled/partially_fed are feedable)', async () => {
    const harness = makeHarness({ meal: { status: FeedingMealStatus.FED } });
    await expect(harness.service.recordMealFeeding(baseParams())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(harness.feedingLedger.recordFeed).not.toHaveBeenCalled();
  });
});

describe('MealExecutionService.correctMealPour', () => {
  // Her test TAZE pours dizisi alır — paylaşılan referans testler arası
  // mutasyon kirliliği yaratır (kümülatif düzeltme sayaçları).
  const fedMeal = () => ({
    status: FeedingMealStatus.FED,
    actualKg: 4,
    plannedKg: 10,
    pours: [{ pourIndex: 0, kg: 4, at: '2026-07-20T08:00:00Z', by: 'user-1' }],
  });

  const correctionParams = (correctedKg: number) => ({
    tenantId: TENANT,
    userId: 'user-2',
    caller: CALLER,
    mealId: MEAL,
    pourIndex: 0,
    correctedKg,
  });

  it('upward correction: extra OUT movement + record/meal/batch deltas + growth delta + event (C-11)', async () => {
    const harness = makeHarness({ meal: fedMeal() });
    const result = await harness.service.correctMealPour(correctionParams(6));

    // Öğün + pour denetim izi
    expect(result.actualKg).toBeCloseTo(6);
    const pour = harness.meal.pours![0]!;
    expect(pour.kg).toBe(6);
    expect(pour.originalKg).toBe(4);
    expect(pour.correctedBy).toBe('user-2');
    expect(pour.corrections).toBe(1);
    // Finalize edilmiş öğünde varyans yeniden hesaplanır (6 - 10 = -4)
    expect(result.varianceKg).toBeCloseTo(-4);
    // Ledger kaydı + batch delta'ları
    expect(harness.feedingRecord!.actualAmount).toBe(6);
    expect(harness.feedingRecord!.feedCost).toBeCloseTo(12); // 2/kg × 6
    // Stok ayağı ledger'ın TEK düzeltme motoruna delege edilir: pozitif delta
    // (çok-lotlu tahsis) + bu revizyonun idempotency anahtarı.
    expect(harness.applyStockCorrection).toHaveBeenCalledTimes(1);
    const correction = harness.applyStockCorrection.mock.calls[0]![3] as Record<string, unknown>;
    expect(correction['deltaKg']).toBeCloseTo(2);
    expect(correction['deductionKeyBase']).toBe(`meal-deduct-${MEAL}-0`);
    expect(correction['correctionKey']).toBe(`meal-correct-${MEAL}-0-1`);
    // Growth delta = +2 / 1.25 = 1.6 ve recalc pour_correction gerekçesiyle
    const growthCall = (harness.growthApplier.applyGrowth as jest.Mock).mock.calls[0]!;
    expect(growthCall[3]).toBeCloseTo(1.6);
    expect(harness.recalcService.recalcForUnit).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      UNIT,
      'pour_correction',
    );
    expect(harness.enqueued.map((event) => event.eventType)).toContain('FeedingRecordUpdated');
  });

  it("downward correction: negatif delta ledger'ın LIFO iade motoruna gider", async () => {
    const harness = makeHarness({ meal: fedMeal() });
    const result = await harness.service.correctMealPour(correctionParams(3));

    expect(result.actualKg).toBeCloseTo(3);
    // Negatif delta ledger'a iletilir; iade hedefi (LIFO, çekilen lotlar) orada
    // çözülür — FARM-MEDIUM-254 pinleri ledger spec'indedir.
    expect(harness.applyStockCorrection).toHaveBeenCalledTimes(1);
    const correction = harness.applyStockCorrection.mock.calls[0]![3] as Record<string, unknown>;
    expect(correction['deltaKg']).toBeCloseTo(-1);
    expect(correction['deductionKeyBase']).toBe(`meal-deduct-${MEAL}-0`);
    // Growth delta NEGATİF: -1 / 1.25 = -0.8 (büyüme geri alınır)
    const growthCall = (harness.growthApplier.applyGrowth as jest.Mock).mock.calls[0]!;
    expect(growthCall[3]).toBeCloseTo(-0.8);
  });

  it('no-op when the corrected amount equals the pour (no movement, no event)', async () => {
    const harness = makeHarness({ meal: fedMeal() });
    await harness.service.correctMealPour(correctionParams(4));
    expect(harness.recordMovement).not.toHaveBeenCalled();
    expect(harness.enqueued).toHaveLength(0);
  });

  it('fails closed when the pour has no ledger record (P-05 divergence surfaces loudly)', async () => {
    const harness = makeHarness({ meal: fedMeal(), feedingRecord: null });
    await expect(harness.service.correctMealPour(correctionParams(6))).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('MealExecutionService.skipMeal', () => {
  it('skips a scheduled meal with a durable MealSkipped event', async () => {
    const harness = makeHarness({ openMealsAfter: 0 });
    const result = await harness.service.skipMeal({
      tenantId: TENANT,
      userId: 'user-1',
      caller: CALLER,
      mealId: MEAL,
      reason: 'balık iştahsız',
    });
    expect(result.status).toBe(FeedingMealStatus.SKIPPED);
    expect(harness.enqueued.map((event) => event.eventType)).toContain('MealSkipped');
  });

  it('rejects skipping a non-scheduled meal', async () => {
    const harness = makeHarness({ meal: { status: FeedingMealStatus.PARTIALLY_FED } });
    await expect(
      harness.service.skipMeal({
        tenantId: TENANT,
        userId: 'user-1',
        caller: CALLER,
        mealId: MEAL,
        reason: 'x',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('acquires locks in the canonical DayPlan → Meal order (K-1 — no AB-BA with record/correct)', async () => {
    const harness = makeHarness({ openMealsAfter: 0 });
    await harness.service.skipMeal({
      tenantId: TENANT,
      userId: 'user-1',
      caller: CALLER,
      mealId: MEAL,
      reason: 'balık iştahsız',
    });
    const lockedEntities = harness.findOne.mock.calls
      .filter(
        ([, options]) =>
          (options as { lock?: { mode?: string } })?.lock?.mode === 'pessimistic_write',
      )
      .map(([entity]) => entity);
    expect(lockedEntities).toEqual([FeedingDayPlan, FeedingMeal]);
    // Ön-okuma kilitsizdir: ilk FeedingMeal findOne'ı lock seçeneği taşımaz.
    const firstMealCall = harness.findOne.mock.calls.find(([entity]) => entity === FeedingMeal);
    expect((firstMealCall?.[1] as { lock?: unknown })?.lock).toBeUndefined();
  });
});
