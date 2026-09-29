import {
  ALERT_TRIGGERED_EVENT_VERSION,
  createBaseEvent,
  type AlertTriggeredEvent,
} from '@platform/event-contracts';

import { NotificationChannel } from '../../entities/notification-log.entity';
import {
  NotificationRateLimiterUnavailableError,
  NotificationReceiptHeldError,
} from '../../services/notification-delivery.errors';
import { AlertTriggeredEventHandler } from '../alert-triggered.handler';
import { externalDeliveryKey, splitExternalTargets } from '../alert-triggered-targets';

/**
 * Decision 7 — a sensor rule's EXTERNAL targets. People (user ids) are paged by
 * the incident's escalation; this handler delivers only raw addresses, once per
 * incident + channel + target. London school: the dispatcher and the bus are
 * doubles.
 */
const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const INCIDENT_ID = '0b9e7c1a-1111-4d2e-9a3b-5c6d7e8f9a0b';
const PERSON = '44444444-4444-4444-8444-444444444444';
const EMAIL = 'ops@example.com';
const WEBHOOK = 'https://hooks.example.com/alarm';

function triggered(overrides: Partial<AlertTriggeredEvent> = {}): AlertTriggeredEvent {
  return {
    ...createBaseEvent<AlertTriggeredEvent>('AlertTriggered', TENANT_ID, {
      version: ALERT_TRIGGERED_EVENT_VERSION,
    }),
    alertId: '99999999-9999-4999-8999-999999999999',
    incidentId: INCIDENT_ID,
    ruleId: '88888888-8888-4888-8888-888888888888',
    ruleName: 'DO crash',
    severity: 'critical',
    message: 'Alert: DO crash - dissolved_oxygen is less than 4. Current value: 2.1',
    channels: ['email', 'webhook'],
    recipients: [PERSON, EMAIL, WEBHOOK],
    ...overrides,
  };
}

function build(): {
  handler: AlertTriggeredEventHandler;
  dispatcher: { dispatchCommandNotification: jest.Mock };
} {
  const dispatcher = {
    dispatchCommandNotification: jest.fn(async () => ({ externalId: 'x', replayed: false })),
  };
  const handler = new AlertTriggeredEventHandler(dispatcher, {
    subscribeWildcard: jest.fn(async () => undefined),
  });
  return { handler, dispatcher };
}

describe('AlertTriggeredEventHandler — external targets only (decision 7)', () => {
  it('delivers the raw e-mail and the webhook once each, and never the user id', async () => {
    // SCENARIO: the rule names a person, an outside e-mail and a webhook.
    // EXPECTS: exactly two sends — e-mail→address, webhook→URL — each keyed by the
    //          incident + channel + target; the person is left to the escalation.
    const { handler, dispatcher } = build();

    const outcome = await handler.handle(triggered());

    expect(outcome).toEqual({ kind: 'ack' });
    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledTimes(2);
    const sent = dispatcher.dispatchCommandNotification.mock.calls.map(
      ([input]) => input as { channel: string; recipient: string; requestReference: string },
    );
    expect(sent.map((s) => [s.channel, s.recipient])).toEqual([
      [NotificationChannel.EMAIL, EMAIL],
      [NotificationChannel.WEBHOOK, WEBHOOK],
    ]);
    expect(sent.some((s) => s.recipient === PERSON)).toBe(false);
    expect(sent[0]?.requestReference).toBe(
      externalDeliveryKey(INCIDENT_ID, { channel: NotificationChannel.EMAIL, address: EMAIL }),
    );
  });

  it('keys a later trigger of the same incident identically, so the receipts replay it', async () => {
    // SCENARIO: the open incident is bumped by a second reading (new alertId, new message).
    // EXPECTS: the same requestReference AND payload hash as the first — the
    //          dispatcher's receipt answers "already sent" instead of re-sending
    //          or refusing a payload-hash mismatch.
    const { handler, dispatcher } = build();

    await handler.handle(triggered());
    await handler.handle(
      triggered({ alertId: '77777777-7777-4777-8777-777777777777', message: 'Current value: 1.9' }),
    );

    const [first, second] = [
      dispatcher.dispatchCommandNotification.mock.calls[0]?.[0],
      dispatcher.dispatchCommandNotification.mock.calls[2]?.[0],
    ] as Array<{ requestReference: string; commandPayloadHash: string }>;
    expect(second?.requestReference).toBe(first?.requestReference);
    expect(second?.commandPayloadHash).toBe(first?.commandPayloadHash);
    // The receipt column is char(64): a sha256 hex, never the raw key.
    expect(first?.commandPayloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('acknowledges a rule that names only people, sending nothing (escalation pages them)', async () => {
    const { handler, dispatcher } = build();

    const outcome = await handler.handle(triggered({ recipients: [PERSON] }));

    expect(outcome).toEqual(expect.objectContaining({ kind: 'ack' }));
    expect(dispatcher.dispatchCommandNotification).not.toHaveBeenCalled();
  });

  it('exempts CRITICAL/HIGH external sends from the tenant rate limit', async () => {
    const { handler, dispatcher } = build();

    await handler.handle(triggered());

    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({ lifeSafetyAlarm: true, severity: 'critical' }),
    );
  });

  it.each([
    ['a held receipt', () => new NotificationReceiptHeldError()],
    ['an unavailable limiter', () => new NotificationRateLimiterUnavailableError('redis down')],
  ])('retries on %s, after trying every target', async (_label, failure) => {
    const { handler, dispatcher } = build();
    dispatcher.dispatchCommandNotification.mockRejectedValueOnce(failure());

    const outcome = await handler.handle(triggered());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'retry' }));
    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledTimes(2);
  });

  it('acknowledges a provider failure (the dispatcher persisted it for its own retry)', async () => {
    const { handler, dispatcher } = build();
    dispatcher.dispatchCommandNotification.mockRejectedValueOnce(new Error('SMTP 421'));

    const outcome = await handler.handle(triggered());

    expect(outcome).toEqual({ kind: 'ack' });
  });

  it('dead-letters an event that names no incident', async () => {
    const { handler, dispatcher } = build();
    const legacy: AlertTriggeredEvent = JSON.parse(
      JSON.stringify({ ...triggered(), incidentId: undefined }),
    );

    const outcome = await handler.handle(legacy);

    expect(outcome).toEqual(expect.objectContaining({ kind: 'terminate' }));
    expect(dispatcher.dispatchCommandNotification).not.toHaveBeenCalled();
  });
});

describe('splitExternalTargets', () => {
  it('pairs each address with the one channel its form names, only if the rule lists it', () => {
    // SCENARIO: a phone number with no SMS channel on the rule; an e-mail twice.
    // EXPECTS: the phone is unreachable (never SMS to an e-mail, never SMS the rule
    //          did not ask for); the e-mail goes once; the user id is counted apart.
    const split = splitExternalTargets(
      [PERSON, EMAIL, 'OPS@example.com', '+4712345678', 'not an address'],
      ['EMAIL'],
    );

    expect(split).toEqual({
      deliveries: [{ channel: NotificationChannel.EMAIL, address: EMAIL }],
      userIds: 1,
      unreachable: 2,
    });
  });
});
