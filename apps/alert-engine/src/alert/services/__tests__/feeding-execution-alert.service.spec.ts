/**
 * FeedingExecutionAlertService (plan §6) — pinler:
 * MealUnderfed/MealMissed WARNING + ünite-bazlı dedup ruleId'si;
 * UnfedUnitDetected CRITICAL (sessiz aç kalma); FeedTypeTransitioned
 * INFO/audit satırı üretir, incident ÜRETMEZ (belgeli karar).
 */
import { createBaseEvent } from '@platform/event-contracts';
import type {
  FeedTypeTransitionedEvent,
  FeedingWindowReadinessEvent,
  FeedingWindowReadinessVerdictV1,
  MealMissedEvent,
  MealUnderfedEvent,
  UnfedUnitDetectedEvent,
} from '@platform/event-contracts';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import { FeedingExecutionAlertService } from '../feeding-execution-alert.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

function underfedEvent(overrides: Partial<MealUnderfedEvent> = {}): MealUnderfedEvent {
  return {
    eventType: 'MealUnderfed',
    tenantId: TENANT,
    timestamp: '2026-07-17T12:00:00.000Z',
    scope: 'meal',
    unitId: 'unit-1',
    unitCode: 'T1',
    dayPlanId: 'dp-1',
    mealId: 'meal-1',
    plannedKg: 10,
    actualKg: 7,
    variancePercent: -30,
    thresholdPercent: 15,
    ...overrides,
  } as MealUnderfedEvent;
}

function missedEvent(overrides: Partial<MealMissedEvent> = {}): MealMissedEvent {
  return {
    eventType: 'MealMissed',
    tenantId: TENANT,
    timestamp: '2026-07-17T05:30:00.000Z',
    unitId: 'unit-1',
    unitCode: 'T1',
    mealId: 'meal-1',
    dayPlanId: 'dp-1',
    scheduledAt: '2026-07-16T08:00:00.000Z',
    ...overrides,
  } as MealMissedEvent;
}

function unfedEvent(overrides: Partial<UnfedUnitDetectedEvent> = {}): UnfedUnitDetectedEvent {
  return {
    eventType: 'UnfedUnitDetected',
    tenantId: TENANT,
    timestamp: '2026-07-17T06:00:00.000Z',
    unitId: 'unit-1',
    unitCode: 'T1',
    siteId: 'site-1',
    reason: 'no_assignment',
    fishCount: 1200,
    biomassKg: 340,
    ...overrides,
  } as UnfedUnitDetectedEvent;
}

function transitionedEvent(
  overrides: Partial<FeedTypeTransitionedEvent> = {},
): FeedTypeTransitionedEvent {
  return {
    eventType: 'FeedTypeTransitioned',
    tenantId: TENANT,
    timestamp: '2026-07-17T08:05:00.000Z',
    unitId: 'unit-1',
    unitCode: 'T1',
    assignmentId: 'as-1',
    fromFeedId: 'feed-1',
    toFeedId: 'feed-2',
    toFeedCode: 'PEL-4MM',
    bandIndex: 2,
    avgWeightG: 180,
    automatic: true,
    ...overrides,
  } as FeedTypeTransitionedEvent;
}

function readinessEvent(): FeedingWindowReadinessEvent {
  return {
    ...createBaseEvent<FeedingWindowReadinessEvent>('FeedingWindowReadiness', TENANT),
    timestamp: '2026-07-17T07:45:00.000Z',
    schemaVersion: 'feeding-window-readiness/v1',
    sourceWindowEventId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    windowStart: '2026-07-17T07:45:00.000Z',
    windowEnd: '2026-07-17T08:45:00.000Z',
    evaluatedAt: '2026-07-17T07:45:00.000Z',
    batchIndex: 0,
    batchCount: 1,
    verdicts: [],
  };
}

function readinessVerdict(
  status: FeedingWindowReadinessVerdictV1['status'],
): FeedingWindowReadinessVerdictV1 {
  return {
    unitId: 'unit-1',
    unitCode: 'T1',
    mealId: 'meal-1',
    dayPlanId: 'dp-1',
    scheduledAt: '2026-07-17T08:00:00.000Z',
    status,
    minDissolvedOxygen: 6,
  };
}

describe('FeedingExecutionAlertService', () => {
  const save = jest.fn().mockImplementation((row: object) => ({ ...row, id: 'hist-1' }));
  const create = jest.fn().mockImplementation((row: object) => row);
  const ensureIncident = jest.fn().mockResolvedValue(undefined);
  const service = new FeedingExecutionAlertService(
    mock<ConstructorParameters<typeof FeedingExecutionAlertService>[0]>({
      save,
      create,
    } as Partial<ConstructorParameters<typeof FeedingExecutionAlertService>[0]>),
    { ensureIncident },
  );

  beforeEach(() => {
    save.mockClear();
    create.mockClear();
    ensureIncident.mockClear();
  });

  it('MealUnderfed → WARNING incident, ünite-bazlı dedup ruleId', async () => {
    await service.recordMealUnderfed(underfedEvent());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'system:meal-underfed:unit-1',
        severity: AlertSeverity.WARNING,
        tenantId: TENANT,
      }),
    );
    expect(ensureIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'system:meal-underfed:unit-1',
        severity: AlertSeverity.WARNING,
        signalLabel: 'meal-underfed',
      }),
    );
  });

  it('gün-seviyesi az-atım (scope=day, D-16) AYNI ünite incident kimliğini besler', async () => {
    await service.recordMealUnderfed(underfedEvent({ scope: 'day', mealId: undefined }));
    expect(ensureIncident).toHaveBeenCalledWith(
      expect.objectContaining({ ruleId: 'system:meal-underfed:unit-1' }),
    );
    const historyRow = create.mock.calls[0][0] as {
      triggeringData: { scope: string; mealId: string | null };
    };
    expect(historyRow.triggeringData.scope).toBe('day');
    expect(historyRow.triggeringData.mealId).toBeNull();
  });

  it('MealMissed → WARNING incident', async () => {
    await service.recordMealMissed(missedEvent());
    expect(ensureIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'system:meal-missed:unit-1',
        severity: AlertSeverity.WARNING,
        signalLabel: 'meal-missed',
      }),
    );
  });

  it('UnfedUnitDetected → CRITICAL incident (sessiz aç kalma, D-5)', async () => {
    await service.recordUnfedUnit(unfedEvent());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'system:unfed-unit:unit-1',
        severity: AlertSeverity.CRITICAL,
      }),
    );
    expect(ensureIncident).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'system:unfed-unit:unit-1',
        severity: AlertSeverity.CRITICAL,
        signalLabel: 'unfed-unit',
      }),
    );
  });

  it.each(['no_assignment', 'assignment_paused', 'draft_protocol'] as const)(
    'UnfedUnitDetected %s nedeni triggeringData ile taşınır',
    async (reason) => {
      await service.recordUnfedUnit(unfedEvent({ reason }));
      const historyRow = create.mock.calls[0][0] as {
        triggeringData: { reason: string };
      };
      expect(historyRow.triggeringData.reason).toBe(reason);
    },
  );

  it('FeedTypeTransitioned → INFO audit satırı, incident YOK (plan §6)', async () => {
    await service.recordFeedTransitioned(transitionedEvent());
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleId: 'system:feed-transition:unit-1',
        severity: AlertSeverity.INFO,
      }),
    );
    expect(ensureIncident).not.toHaveBeenCalled();
  });

  it.each(['low_oxygen', 'no_reading', 'not_instrumented'] as const)(
    'FeedingWindowReadiness %s → WARNING incident with one unit authority',
    async (status) => {
      await service.recordFeedingWindowReadiness(readinessEvent(), readinessVerdict(status));
      expect(ensureIncident).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleId: 'system:feeding-window-oxygen:unit-1',
          severity: AlertSeverity.WARNING,
          signalLabel: 'feeding-window-oxygen',
        }),
      );
    },
  );

  it('does not create an incident for an explicit ready verdict', async () => {
    await service.recordFeedingWindowReadiness(readinessEvent(), readinessVerdict('ready'));
    expect(create).not.toHaveBeenCalled();
    expect(ensureIncident).not.toHaveBeenCalled();
  });
});
