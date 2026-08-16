/**
 * DayPlanOperationExecutor (K-9) — operatör plan aksiyonları.
 *
 * Pinlenen sözleşme:
 *  - regenerateDayPlan: aktif plan VARSA 'manual_regenerate' gerekçeli recalc
 *    (yeni plan üretilmez); plan YOKSA 06:00 üreticisiyle aynı compute/persist
 *    yolu; aktif atama yoksa NotFound; ACTIVE olmayan protokolde BadRequest.
 *  - transitionUnitFeed: hedef yem protokol bandlarından biri OLMAK ZORUNDA
 *    (fail-closed); atama currentFeed/band + kalan öğünler güncellenir;
 *    FeedTypeTransitioned(automatic:false) AYNI manager'la outbox'a yazılır.
 */
const managerQuery = jest.fn();

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual('@aquaculture/backend-common/database'),
  runInTenantTransaction: (
    ds: unknown,
    schema: string,
    tenantId: string,
    cb: (qr: { manager: unknown }) => Promise<unknown>,
  ) => cb({ manager: currentManager }),
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { TenantMutationSession } from '@aquaculture/backend-common/database';
import { OutboxPublisher } from '@platform/outbox';

import { DayPlanOperationExecutor } from '../executors/day-plan-operation.executor';
import type { FeedingOperationSession } from '../feeding-operation-session';
import { MealPlanGeneratorService } from '../services/meal-plan-generator.service';
import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { WaterTemperatureService } from '../../water-quality/services/water-temperature.service';
import {
  FeedingProtocolV2,
  FeedingProtocolStatus,
  ProtocolFcrSource,
} from '../entities/feeding-protocol-v2.entity';
import {
  ProtocolAssignment,
  ProtocolAssignmentStatus,
  FeedingUnitType,
} from '../entities/protocol-assignment.entity';
import { FeedingDayPlan } from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { TankBatch } from '../../batch/entities/tank-batch.entity';
import { RecordingFeedingAggregateMutationPort } from '../../__tests__/support/durable-mutation-test-authority';
import {
  createProtocolResolutionTestAuthority,
  feedingProtocolTestMutationInstant,
} from '../../__tests__/support/feeding-protocol-test-authority';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const UNIT = '77777777-7777-4777-8777-777777777777';
const SITE = '88888888-8888-4888-8888-888888888888';
const SESSION = Object.freeze({}) as FeedingOperationSession;
const MUTATION_SESSION = Object.freeze({}) as TenantMutationSession;
const MUTATION_INSTANT = feedingProtocolTestMutationInstant('2026-07-20T12:00:00.000Z');

jest.mock('../feeding-operation-session', () => ({
  feedingOperationObservedAt: jest.fn(() => new Date('2026-07-20T12:00:00.000Z')),
  readFeedingOperationSession: jest.fn(() => ({
    manager: currentManager,
    mutationSession: MUTATION_SESSION,
    mutationInstant: MUTATION_INSTANT,
    tenantId: TENANT,
    operationId: '99999999-9999-4999-8999-999999999999',
    generation: 1,
    attempt: 1,
    localDate: '2026-07-20',
    timezone: 'UTC',
    siteId: SITE,
    unitId: UNIT,
  })),
}));

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

// runInTenantTransaction mock'u bu değişkendeki manager'ı callback'e verir.
let currentManager: Record<string, jest.Mock>;

const PROTOCOL = mock<FeedingProtocolV2>({
  id: 'proto-1',
  tenantId: TENANT,
  status: FeedingProtocolStatus.ACTIVE,
  bands: [
    {
      minWeightG: 0,
      maxWeightG: 200,
      feedId: 'feed-s1',
      feedCode: 'S1',
      feedName: 'Starter',
      feedingRatePercent: 3,
      expectedFcr: 1.1,
    },
    {
      minWeightG: 200,
      maxWeightG: 1000000,
      feedId: 'feed-g4',
      feedCode: 'G4',
      feedName: 'Grower',
      feedingRatePercent: 2,
      expectedFcr: 1.3,
    },
  ],
  settings: {
    autoTransition: true,
    transitionBufferG: 10,
    growthApplicationMode: 'per_meal',
    underfeedAlertThresholdPercent: 15,
    fcrSource: ProtocolFcrSource.BAND,
  },
});

function makeAssignment(): ProtocolAssignment {
  return mock<ProtocolAssignment>({
    id: 'assign-1',
    tenantId: TENANT,
    unitId: UNIT,
    unitType: FeedingUnitType.TANK,
    unitName: 'Tank 1',
    unitCode: 'T-1',
    siteId: SITE,
    protocolId: 'proto-1',
    status: ProtocolAssignmentStatus.ACTIVE,
    currentFeedId: 'feed-s1',
    currentBandIndex: 0,
    totalTransitions: 1,
    overrides: {},
    suspensions: [],
  });
}

interface Fixture {
  assignment?: ProtocolAssignment | null;
  dayPlan?: Partial<FeedingDayPlan> | null;
  meals?: Array<Partial<FeedingMeal>>;
  protocol?: FeedingProtocolV2 | null;
  tankBatch?: Partial<TankBatch> | null;
}

function buildHarness(fixture: Fixture): {
  service: DayPlanOperationExecutor;
  computeDayPlan: jest.Mock;
  persistDayPlan: jest.Mock;
  recalcForUnit: jest.Mock;
  enqueue: jest.Mock;
  feedingMutations: RecordingFeedingAggregateMutationPort;
} {
  const assignment = fixture.assignment === undefined ? makeAssignment() : fixture.assignment;
  const dayPlan = fixture.dayPlan ?? null;
  const meals = fixture.meals ?? [];
  const protocol = fixture.protocol === undefined ? PROTOCOL : fixture.protocol;
  const tankBatch =
    fixture.tankBatch === undefined
      ? { tankId: UNIT, totalQuantity: 1000, totalBiomassKg: 100, avgWeightG: 100 }
      : fixture.tankBatch;

  const qbFor = (entity: unknown): Record<string, jest.Mock> => {
    const chain: Record<string, jest.Mock> = {
      setLock: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      orderBy: jest.fn(),
      getOne: jest.fn(),
      getMany: jest.fn(),
    };
    for (const key of ['setLock', 'where', 'andWhere', 'orderBy']) {
      chain[key]!.mockReturnValue(chain);
    }
    if (entity === FeedingDayPlan) chain['getOne']!.mockResolvedValue(dayPlan);
    if (entity === ProtocolAssignment) chain['getOne']!.mockResolvedValue(assignment);
    if (entity === FeedingMeal) chain['getMany']!.mockResolvedValue(meals);
    return chain;
  };

  const managerFindOne = jest.fn();
  managerFindOne.mockImplementation(async (entity: unknown): Promise<unknown> => {
    if (entity === FeedingProtocolV2) return protocol;
    if (entity === TankBatch) return tankBatch;
    return null;
  });
  const managerFind = jest.fn().mockResolvedValue([]);
  const managerSave = jest.fn().mockImplementation(async (entity: unknown) => entity);
  const managerCreateQueryBuilder = jest.fn();
  managerCreateQueryBuilder.mockImplementation((entity: unknown) => qbFor(entity));
  managerQuery.mockImplementation(async (sql: string): Promise<unknown[]> => {
    if (String(sql).includes('"sites"')) return [{ timezone: 'UTC' }];
    return [];
  });

  currentManager = {
    query: managerQuery,
    findOne: managerFindOne,
    find: managerFind,
    save: managerSave,
    createQueryBuilder: managerCreateQueryBuilder,
  };

  const computeDayPlan = jest.fn();
  computeDayPlan.mockReturnValue({
    snapshot: {},
    plannedTotalKg: 2,
    status: 'planned',
    meals: [{}, {}],
  });
  const persistDayPlan = jest.fn();
  persistDayPlan.mockResolvedValue('dp-new');
  const recalcForUnit = jest.fn();
  recalcForUnit.mockResolvedValue({ dayPlanId: 'dp-1', outcome: 'repriced' });
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const getEffectiveTemperature = jest.fn();
  getEffectiveTemperature.mockResolvedValue({ celsius: null, source: 'none' });

  const feedingMutations = new RecordingFeedingAggregateMutationPort({ save: managerSave });
  const service = new DayPlanOperationExecutor(
    feedingMutations,
    mock<MealPlanGeneratorService>({ computeDayPlan, persistDayPlan }),
    mock<DayPlanRecalcService>({ recalcForUnit }),
    createProtocolResolutionTestAuthority(),
    mock<WaterTemperatureService>({ getEffectiveTemperature }),
    mock<OutboxPublisher>({ enqueue }),
  );
  return { service, computeDayPlan, persistDayPlan, recalcForUnit, enqueue, feedingMutations };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('DayPlanOperationExecutor.regenerateDayPlan (K-9)', () => {
  it("aktif plan varken 'manual_regenerate' gerekçeli recalc — yeni plan üretilmez", async () => {
    const { service, recalcForUnit, persistDayPlan, computeDayPlan } = buildHarness({
      dayPlan: { id: 'dp-1' },
    });

    const result = await service.executeRegenerateOperation(SESSION, {
      jobId: 'manual.day-plan.regenerate',
      tenantId: TENANT,
      actorId: USER,
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      unitId: UNIT,
    });

    expect(result).toEqual({ outcome: 'recalculated', dayPlanId: 'dp-1' });
    expect(recalcForUnit).toHaveBeenCalledWith(
      expect.anything(),
      MUTATION_SESSION,
      TENANT,
      UNIT,
      'manual_regenerate',
      { mutationInstant: MUTATION_INSTANT },
    );
    expect(computeDayPlan).not.toHaveBeenCalled();
    expect(persistDayPlan).not.toHaveBeenCalled();
  });

  it('bugün plan yoksa şimdi üretir (06:00 üreticisiyle aynı compute/persist yolu)', async () => {
    const { service, recalcForUnit, computeDayPlan, persistDayPlan } = buildHarness({
      dayPlan: null,
    });

    const result = await service.executeRegenerateOperation(SESSION, {
      jobId: 'manual.day-plan.regenerate',
      tenantId: TENANT,
      actorId: USER,
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      unitId: UNIT,
    });

    expect(result).toEqual({ outcome: 'generated', dayPlanId: 'dp-new' });
    expect(recalcForUnit).not.toHaveBeenCalled();
    expect(computeDayPlan).toHaveBeenCalledTimes(1);
    expect(persistDayPlan).toHaveBeenCalledTimes(1);
    expect(persistDayPlan.mock.calls[0]![1]).toBe(MUTATION_SESSION);
    const context = persistDayPlan.mock.calls[0]![2] as Record<string, unknown>;
    expect(context['unitId']).toBe(UNIT);
    expect(context['assignmentId']).toBe('assign-1');
  });

  it('aktif atama yoksa NotFound (fail-closed)', async () => {
    const { service } = buildHarness({ assignment: null });

    await expect(
      service.executeRegenerateOperation(SESSION, {
        jobId: 'manual.day-plan.regenerate',
        tenantId: TENANT,
        actorId: USER,
        requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        unitId: UNIT,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ACTIVE olmayan protokolde plan üretmeyi reddeder', async () => {
    const draft = mock<FeedingProtocolV2>({ ...PROTOCOL, status: FeedingProtocolStatus.DRAFT });
    const { service, persistDayPlan } = buildHarness({ dayPlan: null, protocol: draft });

    await expect(
      service.executeRegenerateOperation(SESSION, {
        jobId: 'manual.day-plan.regenerate',
        tenantId: TENANT,
        actorId: USER,
        requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        unitId: UNIT,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(persistDayPlan).not.toHaveBeenCalled();
  });
});

describe('DayPlanOperationExecutor.transitionUnitFeed (K-9)', () => {
  it('band yemine manuel geçiş: atama + kalan öğünler + automatic:false event', async () => {
    const meal = mock<FeedingMeal>({
      id: 'meal-1',
      feedId: 'feed-s1',
      status: FeedingMealStatus.SCHEDULED,
    });
    const assignment = makeAssignment();
    const { service, enqueue, feedingMutations } = buildHarness({
      assignment,
      dayPlan: { id: 'dp-1' },
      meals: [meal],
    });

    const result = await service.executeTransitionOperation(SESSION, {
      jobId: 'manual.feed.transition',
      tenantId: TENANT,
      actorId: USER,
      requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      unitId: UNIT,
      toFeedId: 'feed-g4',
    });

    expect(result).toEqual({ outcome: 'transitioned', dayPlanId: 'dp-1' });
    expect(assignment.currentFeedId).toBe('feed-g4');
    expect(assignment.currentBandIndex).toBe(1);
    expect(assignment.totalTransitions).toBe(2);
    expect(meal.feedId).toBe('feed-g4');
    expect(feedingMutations.commitProtocolAssignmentTransition).toHaveBeenCalledWith(
      MUTATION_SESSION,
      { intent: 'feed_transitioned', aggregate: assignment },
    );
    expect(feedingMutations.commitMealTransition).toHaveBeenCalledWith(MUTATION_SESSION, {
      intent: 'recalculated',
      aggregate: meal,
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    const event = enqueue.mock.calls[0]![0] as Record<string, unknown>;
    expect(event['eventType']).toBe('FeedTypeTransitioned');
    expect(event['automatic']).toBe(false);
    expect(event['fromFeedId']).toBe('feed-s1');
    expect(event['toFeedId']).toBe('feed-g4');
    expect(event['toFeedCode']).toBe('G4');
    expect(event['bandIndex']).toBe(1);
  });

  it('band dışı yeme geçişi fail-closed reddedilir — atama ve event dokunulmaz', async () => {
    const assignment = makeAssignment();
    const { service, enqueue, feedingMutations } = buildHarness({
      assignment,
      dayPlan: { id: 'dp-1' },
    });

    await expect(
      service.executeTransitionOperation(SESSION, {
        jobId: 'manual.feed.transition',
        tenantId: TENANT,
        actorId: USER,
        requestId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        unitId: UNIT,
        toFeedId: 'feed-baska',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(assignment.currentFeedId).toBe('feed-s1');
    expect(feedingMutations.commitProtocolAssignmentTransition).not.toHaveBeenCalled();
    expect(feedingMutations.commitMealTransition).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
