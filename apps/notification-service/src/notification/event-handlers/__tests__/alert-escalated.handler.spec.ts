import * as client from 'prom-client';
import { LIFE_SAFETY_ALARM_DEGRADED_METRIC } from '@aquaculture/backend-common/metrics';
import {
  ALERT_ESCALATED_EVENT_VERSION,
  createBaseEvent,
  type AlertEscalatedEvent,
} from '@platform/event-contracts';

import { NotificationChannel, NotificationLog } from '../../entities/notification-log.entity';
import { NotificationRateLimitedError } from '../../services/notification-rate-limited.error';
import {
  NotificationRateLimiterUnavailableError,
  NotificationReceiptHeldError,
} from '../../services/notification-delivery.errors';
import { UserContactLookupError } from '../../services/user-contact-directory.service';
import { AlertEscalatedEventHandler } from '../alert-escalated.handler';

/**
 * ALERT-CRITICAL-004 — the last mile of the alarm path. London school: the
 * dispatcher, the in-app writer, the contact directory and the bus are doubles;
 * what is pinned is who gets asked for what, and when a failure re-drives.
 */
const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const INCIDENT_ID = '0b9e7c1a-1111-4d2e-9a3b-5c6d7e8f9a0b';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const MANAGER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';

function escalated(overrides: Partial<AlertEscalatedEvent> = {}): AlertEscalatedEvent {
  return {
    ...createBaseEvent<AlertEscalatedEvent>('AlertEscalated', TENANT_ID, {
      aggregateId: INCIDENT_ID,
      aggregateType: 'AlertIncident',
      version: ALERT_ESCALATED_EVENT_VERSION,
    }),
    alertId: INCIDENT_ID,
    escalationLevel: 1,
    escalatedTo: [],
    reason: '[Escalation Level 1] Water Quality Critical: tank T1 - Action required',
    ruleId: null,
    signalKey: `water:equipment:${SITE_ID}`,
    title: 'Water Quality Critical: tank T1',
    description: 'Water quality critical at tank T1: DO 2.1mg/L below 4mg/L',
    severity: 'critical',
    channels: ['push', 'email'],
    tenantWideRecipientRoles: ['TENANT_ADMIN'],
    siteRecipientRoles: ['MODULE_MANAGER'],
    siteId: SITE_ID,
    ...overrides,
  };
}

function build(recipients: string[] = [MANAGER, ADMIN]): {
  handler: AlertEscalatedEventHandler;
  dispatcher: { dispatchCommandNotification: jest.Mock };
  inApp: { createNotification: jest.Mock };
  contacts: { alertRecipients: jest.Mock; latestPushToken: jest.Mock; email: jest.Mock };
} {
  const dispatcher = {
    dispatchCommandNotification: jest.fn(async () => ({ externalId: 'x', replayed: false })),
  };
  const inApp = { createNotification: jest.fn(async () => new NotificationLog()) };
  const contacts = {
    alertRecipients: jest.fn(async () => ({ userIds: recipients, truncated: false })),
    latestPushToken: jest.fn(async (_tenant: string, userId: string) => `token-${userId}`),
    email: jest.fn(async (_tenant: string, userId: string) => `${userId.slice(0, 4)}@farm.test`),
  };
  const eventBus = { subscribeWildcard: jest.fn(async () => undefined) };
  const handler = new AlertEscalatedEventHandler(dispatcher, inApp, contacts, eventBus);
  return { handler, dispatcher, inApp, contacts };
}

/** The notification-service count of one life-safety degradation reason. */
async function degraded(reason: string): Promise<number> {
  const metric = client.register.getSingleMetric(LIFE_SAFETY_ALARM_DEGRADED_METRIC);
  if (!metric) return 0;
  const { values } = await metric.get();
  return values
    .filter(
      (value) =>
        value.labels['service'] === 'notification-service' && value.labels['reason'] === reason,
    )
    .reduce((sum, value) => sum + value.value, 0);
}

describe('AlertEscalatedEventHandler', () => {
  it('asks auth for the policy targets exactly as the event names them', async () => {
    // SCENARIO: default policy — site managers at the incident's site + tenant admins,
    //           plus one explicitly named user.
    // EXPECTS: one expansion call carrying the roles, the site and the named id.
    const { handler, contacts } = build();

    const outcome = await handler.handle(escalated({ escalatedTo: [MANAGER] }));

    expect(outcome).toEqual(expect.objectContaining({ kind: 'ack' }));
    expect(contacts.alertRecipients).toHaveBeenCalledWith(TENANT_ID, {
      tenantWideRoles: ['TENANT_ADMIN'],
      siteRoles: ['MODULE_MANAGER'],
      siteId: SITE_ID,
      userIds: [MANAGER],
    });
  });

  it('writes an in-app alarm for every recipient and sends push + e-mail with severity', async () => {
    // SCENARIO: two recipients, both with a device and an address.
    // EXPECTS: 2 in-app rows (the floor channel) and 4 receipt-keyed sends, each
    //          carrying the alarm's severity and a per-(event,user,channel) id.
    const { handler, inApp, dispatcher } = build();
    const event = escalated();

    await handler.handle(event);

    expect(inApp.createNotification).toHaveBeenCalledTimes(2);
    expect(inApp.createNotification).toHaveBeenCalledWith(
      TENANT_ID,
      MANAGER,
      '[KRİTİK] Water Quality Critical: tank T1',
      event.description,
      expect.objectContaining({ type: 'AlertEscalated', alertId: INCIDENT_ID, siteId: SITE_ID }),
      { deliveryId: `alert-escalated:${event.eventId}:${MANAGER}` },
    );
    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledTimes(4);
    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: NotificationChannel.PUSH,
        recipient: `token-${MANAGER}`,
        recipientLogRef: `userId:${MANAGER}`,
        deliveryId: `alert-escalated:${event.eventId}:${MANAGER}:push`,
        severity: 'critical',
        pushData: expect.objectContaining({ type: 'ALERT_ESCALATED', userId: MANAGER }),
      }),
    );
    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: NotificationChannel.EMAIL,
        recipient: `${ADMIN.slice(0, 4)}@farm.test`,
        deliveryId: `alert-escalated:${event.eventId}:${ADMIN}:email`,
      }),
    );
  });

  it('skips push for a user with no registered device without failing the alarm', async () => {
    // SCENARIO: the recipient has no AquaMobil device.
    // EXPECTS: in-app + e-mail still go out; the event is acknowledged.
    const { handler, contacts, dispatcher } = build([MANAGER]);
    contacts.latestPushToken.mockResolvedValue(null);

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'ack' }));
    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({ channel: NotificationChannel.EMAIL }),
    );
  });

  it('dead-letters a malformed event at the trust boundary', async () => {
    // SCENARIO: an AlertEscalated missing the delivery fields (pre-contract shape).
    // EXPECTS: terminate with a reason; nobody is asked, nothing is sent.
    const { handler, contacts } = build();
    // A wire payload is untyped JSON; `sms` is not a deliverable alarm channel.
    const legacy: AlertEscalatedEvent = JSON.parse(
      JSON.stringify({ ...escalated(), channels: ['sms'] }),
    );

    const outcome = await handler.handle(legacy);

    expect(outcome).toEqual(expect.objectContaining({ kind: 'terminate' }));
    expect(contacts.alertRecipients).not.toHaveBeenCalled();
  });

  it.each([
    ['a recipient id that is not a user id', ['not-a-uuid']],
    ['a repeated recipient id', [MANAGER, MANAGER]],
  ])('dead-letters an event naming %s (the producer must drop it)', async (_label, escalatedTo) => {
    // SCENARIO: a producer ships an explicit recipient list outside the contract.
    // EXPECTS: refused at the boundary — alert-engine's builder is what guarantees
    //          only distinct user ids are ever sent (escalation builder spec).
    const { handler, contacts } = build();
    const drifted: AlertEscalatedEvent = JSON.parse(
      JSON.stringify({ ...escalated(), escalatedTo }),
    );

    const outcome = await handler.handle(drifted);

    expect(outcome).toEqual(expect.objectContaining({ kind: 'terminate' }));
    expect(contacts.alertRecipients).not.toHaveBeenCalled();
  });

  it('retries when the recipient expansion fails transiently', async () => {
    // SCENARIO: auth-service is briefly unavailable.
    // EXPECTS: retry — an alarm is one-shot, nothing re-raises it.
    const { handler, contacts } = build();
    contacts.alertRecipients.mockRejectedValue(new UserContactLookupError('HTTP 503', 'transient'));

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'retry' }));
  });

  it('retries when an e-mail lookup failed transiently, without re-sending what landed', async () => {
    // SCENARIO: the push went out, the address lookup hit a 503.
    // EXPECTS: retry; the redelivery is safe because every send is receipt-keyed.
    const { handler, contacts } = build([MANAGER]);
    contacts.email.mockRejectedValue(new UserContactLookupError('HTTP 503', 'transient'));

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'retry' }));
  });

  it('retries when the tenant rate limit refused a channel send', async () => {
    // SCENARIO: a burst of alarms exhausts the tenant's per-minute send budget, so
    //           the dispatcher refuses the e-mail without writing a notification row.
    // EXPECTS: retry — no scheduler will pick the refused send up; the redelivery
    //          re-claims its FAILED receipt once the window has passed.
    const { handler, dispatcher } = build([MANAGER]);
    dispatcher.dispatchCommandNotification
      .mockResolvedValueOnce({ externalId: 'push-1', replayed: false })
      .mockRejectedValueOnce(new NotificationRateLimitedError());

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'retry' }));
  });

  it('acknowledges when a provider failed, leaving the retry to the dispatcher scheduler', async () => {
    // SCENARIO: the e-mail provider rejected the send; the dispatcher persisted a
    //           FAILED notification row that its retry scheduler owns.
    // EXPECTS: ack — re-driving the event as well would send the e-mail twice.
    const { handler, dispatcher } = build([MANAGER]);
    dispatcher.dispatchCommandNotification
      .mockResolvedValueOnce({ externalId: 'push-1', replayed: false })
      .mockRejectedValueOnce(new Error('SMTP 421'));

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'ack' }));
  });

  it('acknowledges a WARNING alarm whose targets resolve to nobody, reporting it loudly', async () => {
    // SCENARIO: no active user holds the targeted roles of a non-life-safety alarm.
    // EXPECTS: ack with a reason; nothing sent; no tenant-admin fallback query.
    const { handler, dispatcher, inApp, contacts } = build([]);

    const outcome = await handler.handle(escalated({ severity: 'warning' }));

    expect(outcome).toEqual(expect.objectContaining({ kind: 'ack' }));
    expect(contacts.alertRecipients).toHaveBeenCalledTimes(1);
    expect(inApp.createNotification).not.toHaveBeenCalled();
    expect(dispatcher.dispatchCommandNotification).not.toHaveBeenCalled();
  });

  it("pages every active tenant admin when a CRITICAL alarm's targets resolve to nobody (V-S1a-5)", async () => {
    // SCENARIO: nobody holds the site/tenant roles the policy names.
    // EXPECTS: a second expansion for TENANT_ADMIN tenant-wide; the admin is paged;
    //          the degradation is counted (alertable).
    const { handler, contacts, inApp } = build();
    contacts.alertRecipients
      .mockResolvedValueOnce({ userIds: [], truncated: false })
      .mockResolvedValueOnce({ userIds: [ADMIN], truncated: false });
    const before = await degraded('widened_to_tenant_admins');

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'ack' }));
    expect(contacts.alertRecipients).toHaveBeenLastCalledWith(TENANT_ID, {
      tenantWideRoles: ['TENANT_ADMIN'],
      siteRoles: [],
      siteId: null,
      userIds: [],
    });
    expect(inApp.createNotification).toHaveBeenCalledWith(
      TENANT_ID,
      ADMIN,
      expect.any(String),
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
    );
    expect(await degraded('widened_to_tenant_admins')).toBe(before + 1);
  });

  it('dead-letters (never acks) a CRITICAL alarm nobody at all can receive (V-S1a-5)', async () => {
    // SCENARIO: not even a tenant admin is active.
    // EXPECTS: terminate — the page lands on the dead-letter stream and the
    //          no_recipients degradation is counted.
    const { handler, dispatcher } = build([]);
    const before = await degraded('no_recipients');

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'terminate' }));
    expect(dispatcher.dispatchCommandNotification).not.toHaveBeenCalled();
    expect(await degraded('no_recipients')).toBe(before + 1);
  });

  it('exempts CRITICAL/HIGH pages from the tenant rate limit, not WARNING ones (V-S1a-3)', async () => {
    const critical = build([MANAGER]);
    await critical.handler.handle(escalated());
    expect(critical.dispatcher.dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({ lifeSafetyAlarm: true }),
    );

    const warning = build([MANAGER]);
    await warning.handler.handle(escalated({ severity: 'warning' }));
    expect(warning.dispatcher.dispatchCommandNotification).toHaveBeenCalledWith(
      expect.objectContaining({ lifeSafetyAlarm: false }),
    );
  });

  it.each([
    ['a receipt still held by a crashed send', () => new NotificationReceiptHeldError()],
    [
      'a rate limiter that is down',
      () => new NotificationRateLimiterUnavailableError('redis down'),
    ],
  ])('retries (never dead-letters) on %s (V-S1a-6)', async (_label, failure) => {
    const { handler, dispatcher } = build([MANAGER]);
    dispatcher.dispatchCommandNotification.mockRejectedValue(failure());

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'retry' }));
  });

  it('dead-letters the legacy (pre-delivery) AlertEscalated shape the terminal upcaster marks', async () => {
    const { handler, contacts } = build();
    const legacy: AlertEscalatedEvent = JSON.parse(
      JSON.stringify({
        ...escalated(),
        __legacyShape: 'AlertEscalated<=v2 carries no delivery fields',
      }),
    );

    const outcome = await handler.handle(legacy);

    expect(outcome).toEqual(
      expect.objectContaining({ kind: 'terminate', reason: expect.stringContaining('legacy') }),
    );
    expect(contacts.alertRecipients).not.toHaveBeenCalled();
  });

  it('retries when every in-app write failed', async () => {
    // SCENARIO: the notification database rejects the floor channel for everyone.
    // EXPECTS: retry — the alarm must land somewhere a person can see it.
    const { handler, inApp } = build();
    inApp.createNotification.mockRejectedValue(new Error('db down'));

    const outcome = await handler.handle(escalated());

    expect(outcome).toEqual(expect.objectContaining({ kind: 'retry' }));
  });
});
