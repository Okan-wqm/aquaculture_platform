/**
 * FeedingCompletedListener unit specs
 *
 * Proves the feed-reminder-tenant fix: handleFeedingReminder now forwards the
 * reminder's tenantId into the `notification.send` fan-out, instead of the old
 * hardcoded `tenantId: undefined`. Without a tenantId the reminder cannot be
 * routed to the correct tenant (the canonical NotificationSendCommandBase
 * requires it). The new `tenantId` field on FeedingReminderEventPayload makes
 * `tenantId: undefined` a compile error — these specs guard the runtime value.
 *
 * London-school: the only collaborator is EventEmitter2. We use a REAL
 * EventEmitter2 and jest.spyOn its `emit`, so the listener receives a genuine
 * EventEmitter2 with no type cast (no `as` hackery on added lines).
 */
import { EventEmitter2 } from '@nestjs/event-emitter';

import { FeedingReminderEventPayload } from '../../event-types';
import { FeedingCompletedListener } from '../feeding-completed.listener';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

/** Captured `notification.send` payloads carry at least a tenantId + type. */
interface NotificationSendPayload {
  tenantId?: string;
  type?: string;
  title?: string;
  message?: string;
}

function makeListener(): {
  listener: FeedingCompletedListener;
  emitSpy: jest.SpyInstance;
} {
  const emitter = new EventEmitter2();
  // Capture emits without re-dispatching them (no registered handlers anyway).
  const emitSpy = jest.spyOn(emitter, 'emit').mockReturnValue(true);
  const listener = new FeedingCompletedListener(emitter);
  return { listener, emitSpy };
}

function notificationSends(emitSpy: jest.SpyInstance): NotificationSendPayload[] {
  return emitSpy.mock.calls
    .filter((call) => call[0] === 'notification.send')
    .map((call) => call[1] as NotificationSendPayload);
}

function makeReminder(
  overrides: Partial<FeedingReminderEventPayload> = {},
): FeedingReminderEventPayload {
  return {
    tenantId: TENANT_ID,
    batchId: '22222222-2222-4222-8222-222222222222',
    batchNumber: 'B-001',
    tankId: '33333333-3333-4333-8333-333333333333',
    tankCode: 'T-01',
    feedId: '44444444-4444-4444-8444-444444444444',
    feedName: 'Starter 2mm',
    scheduledTime: new Date('2026-06-16T08:00:00.000Z'),
    quantity: 12.5,
    unit: 'kg',
    reminderTime: new Date('2026-06-16T07:45:00.000Z'),
    ...overrides,
  };
}

describe('FeedingCompletedListener.handleFeedingReminder (feed-reminder-tenant)', () => {
  it('forwards the reminder tenantId into the notification.send fan-out', async () => {
    const { listener, emitSpy } = makeListener();

    await listener.handleFeedingReminder(makeReminder());

    const sends = notificationSends(emitSpy);
    expect(sends).toHaveLength(1);
    const [send] = sends;
    expect(send?.tenantId).toBe(TENANT_ID);
    expect(send?.type).toBe('feeding_reminder');
  });

  it('never emits a notification with an undefined tenantId', async () => {
    const { listener, emitSpy } = makeListener();

    await listener.handleFeedingReminder(
      makeReminder({ tenantId: '99999999-9999-4999-8999-999999999999' }),
    );

    for (const send of notificationSends(emitSpy)) {
      // The exact regression: the consumer used to hardcode tenantId: undefined.
      expect(send.tenantId).toBeDefined();
      expect(send.tenantId).toBe('99999999-9999-4999-8999-999999999999');
    }
  });

  // FU-4 (folded into FARM-HIGH-066): the producer's `...feeding` spread left
  // quantity/unit/scheduledTime undefined (UpcomingFeeding field-name divergence)
  // so the message rendered "Feed undefinedundefined …". The typed emit fixed the
  // mapping; tank is now optional and rendered only when present.
  it('renders quantity + unit + feed in the message with no undefined fields, omitting an absent tank', async () => {
    const { listener, emitSpy } = makeListener();

    await listener.handleFeedingReminder(
      makeReminder({ tankId: undefined, tankCode: undefined }),
    );

    const [send] = notificationSends(emitSpy);
    expect(send?.message).toContain('12.5kg of Starter 2mm');
    expect(send?.message).not.toContain('undefined');
    expect(send?.message).not.toContain('in tank');
  });

  it('includes the tank in the message when tankCode is present', async () => {
    const { listener, emitSpy } = makeListener();

    await listener.handleFeedingReminder(makeReminder({ tankCode: 'T-09' }));

    const [send] = notificationSends(emitSpy);
    expect(send?.message).toContain('in tank T-09');
    expect(send?.message).not.toContain('undefined');
  });
});
