/**
 * FeedCoverageAlertService (Faz 7, plan §6) — eşik/dedup pinleri:
 * ≤3 gün CRITICAL, ≤leadTime WARNING, pencere dışı incident YOK;
 * kapsama açıksız geçiş sinyali incident üretmez; dedup kimliği kapsam bazlı.
 */
import type {
  FeedStockoutForecastEvent,
  FeedTransitionUpcomingEvent,
} from '@platform/event-contracts';

import { AlertSeverity } from '../../../database/entities/alert-rule.entity';
import {
  FeedCoverageAlertService,
  stockoutSeverityFor,
} from '../feed-coverage-alert.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

function stockoutEvent(
  overrides: Partial<FeedStockoutForecastEvent> = {},
): FeedStockoutForecastEvent {
  return {
    eventType: 'FeedStockoutForecast',
    tenantId: TENANT,
    timestamp: '2026-07-16T07:00:00.000Z',
    siteScopeKey: 'site-1',
    feedId: 'feed-1',
    feedCode: 'PEL-3MM',
    daysOfCover: 2,
    stockoutDate: '2026-07-18',
    procurementLeadTimeDays: 7,
    ...overrides,
  } as FeedStockoutForecastEvent;
}

function transitionEvent(
  overrides: Partial<FeedTransitionUpcomingEvent> = {},
): FeedTransitionUpcomingEvent {
  return {
    eventType: 'FeedTransitionUpcoming',
    tenantId: TENANT,
    timestamp: '2026-07-16T07:00:00.000Z',
    siteScopeKey: 'site-1',
    unitId: 'unit-1',
    unitCode: 'T1',
    fromFeedId: 'feed-1',
    toFeedId: 'feed-2',
    estimatedDate: '2026-07-28',
    daysFromNow: 12,
    shortfallDays: 1,
    ...overrides,
  } as FeedTransitionUpcomingEvent;
}

describe('stockoutSeverityFor (eşik SAF kararı)', () => {
  it.each([
    [1, 7, AlertSeverity.CRITICAL],
    [3, 7, AlertSeverity.CRITICAL],
    [4, 7, AlertSeverity.WARNING],
    [7, 7, AlertSeverity.WARNING],
    [8, 7, null],
    [3, 2, AlertSeverity.CRITICAL], // tedarik süresi kısaysa bile ≤3 gün kritik
    [100, 7, null], // ufuk içi ama aksiyon penceresi dışı — gürültü değil
  ])('daysOfCover=%i leadTime=%i → %s', (days, lead, expected) => {
    expect(stockoutSeverityFor(days, lead)).toBe(expected);
  });
});

describe('FeedCoverageAlertService', () => {
  const save = jest.fn().mockImplementation((row: object) => ({ ...row, id: 'hist-1' }));
  const create = jest.fn().mockImplementation((row: object) => row);
  const ensureIncident = jest.fn().mockResolvedValue(undefined);
  const service = new FeedCoverageAlertService(
    mock<ConstructorParameters<typeof FeedCoverageAlertService>[0]>({
      save,
      create,
    } as Partial<ConstructorParameters<typeof FeedCoverageAlertService>[0]>),
    { ensureIncident },
  );

  beforeEach(() => {
    save.mockClear();
    create.mockClear();
    ensureIncident.mockClear();
  });

  it('penceredeki tükeniş kapsam-bazlı dedup kimliğiyle incident üretir', async () => {
    await service.recordStockoutForecast(stockoutEvent({ daysOfCover: 2 }));
    expect(ensureIncident).toHaveBeenCalledTimes(1);
    const call = ensureIncident.mock.calls[0]?.[0] as {
      ruleId: string;
      severity: AlertSeverity;
      signalLabel: string;
    };
    expect(call.ruleId).toBe('system:feed-stockout:site-1:feed-1');
    expect(call.severity).toBe(AlertSeverity.CRITICAL);
    expect(call.signalLabel).toBe('feed-stockout');
  });

  it('aksiyon penceresi dışındaki tükeniş NE history NE incident üretir', async () => {
    await service.recordStockoutForecast(
      stockoutEvent({ daysOfCover: 30, procurementLeadTimeDays: 7 }),
    );
    expect(save).not.toHaveBeenCalled();
    expect(ensureIncident).not.toHaveBeenCalled();
  });

  it('kapsama açığı taşıyan geçiş WARNING incident üretir', async () => {
    await service.recordTransitionGap(transitionEvent({ shortfallDays: 2 }));
    expect(ensureIncident).toHaveBeenCalledTimes(1);
    const call = ensureIncident.mock.calls[0]?.[0] as { ruleId: string; severity: AlertSeverity };
    expect(call.ruleId).toBe('system:feed-transition-gap:unit-1:feed-2');
    expect(call.severity).toBe(AlertSeverity.WARNING);
  });

  it('açıksız geçiş sinyali incident üretmez (bilgi — MealBoard/zaman çizelgesi işi)', async () => {
    await service.recordTransitionGap(transitionEvent({ shortfallDays: undefined }));
    await service.recordTransitionGap(transitionEvent({ shortfallDays: 0 }));
    expect(save).not.toHaveBeenCalled();
    expect(ensureIncident).not.toHaveBeenCalled();
  });
});
