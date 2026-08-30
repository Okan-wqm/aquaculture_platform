/**
 * FeedingDailySummaryEventHandler (K-8c) — pinler: tenant fail-closed;
 * alıcılar cihaz-token dizininden; push deterministik deliveryId ile
 * makbuz-idempotent; replay'de in-app yazılmaz; push hatası in-app'i düşürmez.
 */
import type { FeedingDailySummaryEvent } from '@platform/event-contracts';

import { FeedingDailySummaryEventHandler } from './feeding-daily-summary.handler';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

function summaryEvent(overrides: Partial<FeedingDailySummaryEvent> = {}): FeedingDailySummaryEvent {
  return {
    eventType: 'FeedingDailySummary',
    tenantId: TENANT,
    timestamp: '2026-07-17T20:00:00.000Z',
    planDate: '2026-07-17',
    unitsPlanned: 10,
    unitsCompleted: 8,
    unitsSkipped: 1,
    plannedTotalKg: 120,
    actualTotalKg: 110.4,
    underfedUnitCount: 1,
    missedMealCount: 2,
    ...overrides,
  } as FeedingDailySummaryEvent;
}

interface HarnessOpts {
  recipients?: Array<{ userId: string; token: string }>;
  pushResult?: { replayed: boolean };
  pushError?: Error;
}

function makeHandler(opts: HarnessOpts = {}) {
  const dispatchCommandNotification = jest.fn();
  if (opts.pushError) {
    dispatchCommandNotification.mockRejectedValue(opts.pushError);
  } else {
    dispatchCommandNotification.mockResolvedValue(opts.pushResult ?? { replayed: false });
  }
  const createNotification = jest.fn().mockResolvedValue(undefined);
  const getRawMany = jest
    .fn()
    .mockResolvedValue(opts.recipients ?? [{ userId: 'user-1', token: 'tok-1' }]);
  const qb = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    getRawMany,
  };
  const deviceTokenRepository = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
  const subscribeWildcard = jest.fn().mockResolvedValue(undefined);

  const handler = new FeedingDailySummaryEventHandler(
    mock<ConstructorParameters<typeof FeedingDailySummaryEventHandler>[0]>({
      dispatchCommandNotification,
    } as Partial<ConstructorParameters<typeof FeedingDailySummaryEventHandler>[0]>),
    { createNotification },
    mock<ConstructorParameters<typeof FeedingDailySummaryEventHandler>[2]>({
      createQueryBuilder: deviceTokenRepository.createQueryBuilder,
    } as Partial<ConstructorParameters<typeof FeedingDailySummaryEventHandler>[2]>),
    { subscribeWildcard },
  );

  return { handler, dispatchCommandNotification, createNotification, subscribeWildcard };
}

describe('FeedingDailySummaryEventHandler', () => {
  it('geçersiz tenantId fail-closed atlanır (cihaz sorgusu bile yapılmaz)', async () => {
    const { handler, dispatchCommandNotification, createNotification } = makeHandler();
    await handler.handle(summaryEvent({ tenantId: 'not-a-uuid' }));
    expect(dispatchCommandNotification).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('kullanıcı başına push (deterministik deliveryId) + in-app yazar', async () => {
    const { handler, dispatchCommandNotification, createNotification } = makeHandler({
      recipients: [
        { userId: 'user-1', token: 'tok-1' },
        { userId: 'user-2', token: 'tok-2' },
      ],
    });
    await handler.handle(summaryEvent());

    expect(dispatchCommandNotification).toHaveBeenCalledTimes(2);
    expect(dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        recipient: 'tok-1',
        deliveryId: `feeding-summary:${TENANT}:2026-07-17:user-1`,
        pushData: { userId: 'user-1' },
      }),
    );
    expect(createNotification).toHaveBeenCalledTimes(2);
    const [, , title, body] = createNotification.mock.calls[0];
    expect(title).toContain('2026-07-17');
    expect(body).toContain('8/10');
    expect(body).toContain('az beslendi');
    expect(body).toContain('kaçırıldı');
  });

  it('replay edilen makbuz için in-app satırı YENİDEN yazılmaz (idempotent yeniden teslim)', async () => {
    const { handler, createNotification } = makeHandler({ pushResult: { replayed: true } });
    await handler.handle(summaryEvent());
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('push hatası in-app yazımını düşürmez (retry makinesi push tarafını devralır)', async () => {
    const { handler, createNotification } = makeHandler({ pushError: new Error('FCM down') });
    await handler.handle(summaryEvent());
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('alıcısı olmayan tenant sessizce atlanır', async () => {
    const { handler, dispatchCommandNotification, createNotification } = makeHandler({
      recipients: [],
    });
    await handler.handle(summaryEvent());
    expect(dispatchCommandNotification).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });
});
