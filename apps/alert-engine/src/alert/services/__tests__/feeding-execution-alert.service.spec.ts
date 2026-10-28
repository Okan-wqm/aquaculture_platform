/**
 * FeedingExecutionAlertService (plan §6) — pinler:
 * MealUnderfed/MealMissed WARNING + ünite-bazlı dedup ruleId'si, tek atomik
 * `raise` (alarm + incident) ve MealUnderfed için ÜNİTE-GÜN başına tek alarm;
 * UnfedUnitDetected CRITICAL (sessiz aç kalma); FeedTypeTransitioned
 * INFO/audit satırı üretir, incident ÜRETMEZ (belgeli karar).
 */
import type {
  FeedTypeTransitionedEvent,
  FeedingWindowReadinessEvent,
  MealMissedEvent,
  MealUnderfedEvent,
  UnfedUnitDetectedEvent,
} from '@platform/event-contracts';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import { OWNER_MODULE } from '@aquaculture/shared-contracts';
import { FeedingExecutionAlertService } from '../feeding-execution-alert.service';
import { stub } from '@aquaculture/testing';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RaisedSignal {
  ruleId: string;
  tenantId: string;
  dedupeKey: string;
  severity: AlertSeverity;
  signalLabel: string;
  history: {
    ruleName: string;
    severity: AlertSeverity;
    module: string;
    siteId: string | null;
    triggeringData: { scope?: string; mealId?: string | null };
  };
}

describe('FeedingExecutionAlertService', () => {
  const save = jest.fn().mockImplementation((row: object) => ({ ...row, id: 'hist-1' }));
  const create = jest.fn().mockImplementation((row: object) => row);
  const ensureIncident = jest.fn().mockResolvedValue(undefined);
  const raise = jest.fn().mockResolvedValue('raised');
  const service = new FeedingExecutionAlertService(
    stub<ConstructorParameters<typeof FeedingExecutionAlertService>[0]>({
      save,
      create,
    } as Partial<ConstructorParameters<typeof FeedingExecutionAlertService>[0]>),
    { ensureIncident, raise },
  );

  const raised = (index: number): RaisedSignal => raise.mock.calls[index][0] as RaisedSignal;

  beforeEach(() => {
    save.mockClear();
    create.mockClear();
    ensureIncident.mockClear();
    raise.mockClear();
    raise.mockResolvedValue('raised');
  });

  it('MealUnderfed → WARNING alarm + incident in ONE atomic raise, ünite-bazlı dedup ruleId', async () => {
    await service.recordMealUnderfed(underfedEvent());

    expect(raise).toHaveBeenCalledTimes(1);
    expect(raised(0)).toEqual(
      expect.objectContaining({
        ruleId: 'system:meal-underfed:unit-1',
        severity: AlertSeverity.WARNING,
        signalLabel: 'meal-underfed',
        tenantId: TENANT,
      }),
    );
    expect(raised(0).history).toEqual(
      expect.objectContaining({ ruleName: 'Meal Underfed', severity: AlertSeverity.WARNING }),
    );
    // The alarm row and the incident are written ONLY through the atomic path:
    // the service no longer saves history on its own before opening the incident.
    expect(save).not.toHaveBeenCalled();
    expect(ensureIncident).not.toHaveBeenCalled();
  });

  it('gün-seviyesi az-atım (scope=day, D-16) AYNI ünite incident kimliğini besler', async () => {
    await service.recordMealUnderfed(underfedEvent({ scope: 'day', mealId: undefined }));

    expect(raised(0).ruleId).toBe('system:meal-underfed:unit-1');
    expect(raised(0).history.triggeringData.scope).toBe('day');
    expect(raised(0).history.triggeringData.mealId).toBeNull();
  });

  describe('MealUnderfed fires once per unit per day', () => {
    it('an underfed meal and the day total of the SAME day plan share one key (the second is a duplicate)', async () => {
      await service.recordMealUnderfed(underfedEvent({ scope: 'meal' }));
      await service.recordMealUnderfed(underfedEvent({ scope: 'day', mealId: undefined }));

      expect(raised(0).dedupeKey).toMatch(UUID);
      expect(raised(1).dedupeKey).toBe(raised(0).dedupeKey);
    });

    it('a redelivery of the very same event derives the very same key', async () => {
      await service.recordMealUnderfed(underfedEvent());
      await service.recordMealUnderfed(underfedEvent());

      expect(raised(1).dedupeKey).toBe(raised(0).dedupeKey);
    });

    it('the next day (another day plan) derives a NEW key: the day is evaluated afresh', async () => {
      await service.recordMealUnderfed(underfedEvent({ dayPlanId: 'dp-1' }));
      await service.recordMealUnderfed(underfedEvent({ dayPlanId: 'dp-2' }));

      expect(raised(1).dedupeKey).not.toBe(raised(0).dedupeKey);
    });

    it('another unit, or another tenant, never shares a key', async () => {
      await service.recordMealUnderfed(underfedEvent());
      await service.recordMealUnderfed(underfedEvent({ unitId: 'unit-2' }));
      await service.recordMealUnderfed(
        underfedEvent({ tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      );

      const keys = new Set([raised(0), raised(1), raised(2)].map((signal) => signal.dedupeKey));
      expect(keys.size).toBe(3);
    });

    it('a duplicate is acknowledged, not an error', async () => {
      raise.mockResolvedValue('duplicate');

      await expect(service.recordMealUnderfed(underfedEvent())).resolves.toBeUndefined();
    });

    it('a failure is NOT swallowed: the handler decides between retry and dead-letter', async () => {
      raise.mockRejectedValue(new Error('connection reset'));

      await expect(service.recordMealUnderfed(underfedEvent())).rejects.toThrow('connection reset');
    });
  });

  it('MealMissed → WARNING incident, once per missed meal', async () => {
    await service.recordMealMissed(missedEvent());
    await service.recordMealMissed(missedEvent());
    await service.recordMealMissed(missedEvent({ mealId: 'meal-2' }));

    expect(raised(0)).toEqual(
      expect.objectContaining({
        ruleId: 'system:meal-missed:unit-1',
        severity: AlertSeverity.WARNING,
        signalLabel: 'meal-missed',
      }),
    );
    expect(raised(0).dedupeKey).toMatch(UUID);
    expect(raised(1).dedupeKey).toBe(raised(0).dedupeKey);
    expect(raised(2).dedupeKey).not.toBe(raised(0).dedupeKey);
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
    expect(raise).not.toHaveBeenCalled();
  });

  it('records each signal on its site, the oxygen guard as the sensor module’s (ALERT-MEDIUM-010)', async () => {
    const siteId = '77777777-7777-4777-8777-777777777777';
    await service.recordMealUnderfed(underfedEvent({ siteId })); // raise #0
    await service.recordMealMissed(missedEvent({ siteId })); // raise #1
    await service.recordUnfedUnit(unfedEvent({ siteId })); // create #0
    await service.recordFeedTransitioned(transitionedEvent({ siteId })); // create #1
    await service.recordFeedingWindowReadiness(
      stub<FeedingWindowReadinessEvent>({
        eventType: 'FeedingWindowReadiness',
        tenantId: TENANT,
        timestamp: '2026-07-17T07:45:00.000Z',
        unitId: 'unit-1',
        unitCode: 'T1',
        mealId: 'meal-1',
        dayPlanId: 'dp-1',
        scheduledAt: '2026-07-17T08:00:00.000Z',
        status: 'no_reading',
        minDissolvedOxygen: 6,
        siteId,
      }),
    ); // create #2
    // A signal minted before events carried a site.
    await service.recordMealMissed(missedEvent({ mealId: 'meal-9' })); // raise #2

    const createdRow = (index: number): { module: string; siteId: string | null } => {
      const row: { module: string; siteId: string | null } | undefined =
        create.mock.calls[index]?.[0];
      if (!row) throw new Error(`no history row #${index} was created`);
      return row;
    };
    const origin = (row: { module: string; siteId: string | null }): [string, string | null] => [
      row.module,
      row.siteId,
    ];
    expect([
      origin(raised(0).history),
      origin(raised(1).history),
      origin(createdRow(0)),
      origin(createdRow(1)),
      origin(createdRow(2)),
      origin(raised(2).history),
    ]).toEqual([
      [OWNER_MODULE.FARM, siteId],
      [OWNER_MODULE.FARM, siteId],
      [OWNER_MODULE.FARM, siteId],
      [OWNER_MODULE.FARM, siteId],
      [OWNER_MODULE.SENSOR, siteId],
      [OWNER_MODULE.FARM, null],
    ]);
  });
});
