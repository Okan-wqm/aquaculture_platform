import { checkAlertEscalatedEvent } from '@platform/event-contracts';

import {
  INCIDENT_ID,
  SITE_ID,
  TENANT_ID,
  buildEscalationHarness,
  firstEnqueued,
  incident,
  policy,
} from '../../__tests__/support/escalation-manager.harness';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  EscalationActionType,
  EscalationRecipientRole,
  EscalationRecipientScope,
  NotificationChannel,
} from '../../database/entities/escalation-policy.entity';
import type { EscalationStart } from '../escalation-manager.service';

/**
 * ALERT-CRITICAL-004 — the escalation ladder actually reaches delivery.
 *
 * Pins the three behaviours the farm-signal delivery path depends on:
 *   - AlertEscalated carries what notification-service needs (roles, site,
 *     deliverable channels, text) and passes the shared trust-boundary schema;
 *   - a failed first level throws instead of being swallowed, so the consumer
 *     re-drives the event;
 *   - timer-driven escalation reads the incident inside its tenant context.
 */
function critical(matchKey?: string): EscalationStart {
  return { severity: AlertSeverity.CRITICAL, ...(matchKey ? { matchKey } : {}) };
}

const build = buildEscalationHarness;

describe('EscalationManagerService — farm-signal delivery (ALERT-CRITICAL-004)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('hands notification-service a contract-valid AlertEscalated with roles, site and channels', async () => {
    // SCENARIO: a CRITICAL water incident escalates through the seeded default policy.
    // EXPECTS: one AlertEscalated naming site managers at the incident's site and
    //          every tenant admin, push+email, the signal key — and it passes the
    //          very schema notification-service enforces at its boundary.
    const { service, outbox } = await build();

    await service.startEscalation(incident(), critical(`water:equipment:${SITE_ID}`));

    expect(outbox.enqueue).toHaveBeenCalledTimes(1);
    const event = firstEnqueued(outbox);
    expect(event).toMatchObject({
      eventType: 'AlertEscalated',
      alertId: INCIDENT_ID,
      escalationLevel: 1,
      ruleId: null,
      signalKey: `water:equipment:${SITE_ID}`,
      severity: 'critical',
      channels: ['push', 'email'],
      siteRecipientRoles: ['MODULE_MANAGER'],
      tenantWideRecipientRoles: ['TENANT_ADMIN'],
      siteId: SITE_ID,
      escalatedTo: [],
    });
    const wire: unknown = JSON.parse(JSON.stringify(event));
    expect(checkAlertEscalatedEvent(wire)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('drops channels with no delivery path instead of shipping them', async () => {
    // SCENARIO: a tenant-edited level lists SMS and Slack next to e-mail.
    // EXPECTS: only e-mail rides the event; nobody receives a channel no one serves.
    const { service, outbox, policies } = await build();
    policies.findMatchingPolicy.mockResolvedValue(
      policy([
        {
          level: 1,
          name: 'ops',
          timeoutMinutes: 10,
          notifyUserIds: [],
          notifyRoles: [
            { role: EscalationRecipientRole.TENANT_ADMIN, scope: EscalationRecipientScope.TENANT },
          ],
          channels: [NotificationChannel.SMS, NotificationChannel.SLACK, NotificationChannel.EMAIL],
          action: EscalationActionType.NOTIFY,
        },
      ]),
    );

    await service.startEscalation(incident(), critical());

    expect(firstEnqueued(outbox).channels).toEqual(['email']);
  });

  it('keeps free-text recipient ids and a blank title out of the event, so it stays deliverable', async () => {
    // SCENARIO: a tenant-edited level names a real user, the same user twice and an
    //           e-mail typed where a user id belongs; the incident title is blank.
    // EXPECTS: escalatedTo carries the one real user id; the e-mail is dropped
    //          (never shipped — it would dead-letter the whole page); the title
    //          falls back to the incident id; the event passes the boundary schema.
    const { service, outbox, policies } = await build();
    const user = '33333333-3333-4333-8333-333333333333';
    policies.findMatchingPolicy.mockResolvedValue(
      policy([
        {
          level: 1,
          name: 'ops',
          timeoutMinutes: 10,
          notifyUserIds: [user, user, 'night.shift@farm.example'],
          channels: [NotificationChannel.PUSH],
          action: EscalationActionType.NOTIFY,
        },
      ]),
    );
    const untitled = incident();
    untitled.title = '   ';

    await service.startEscalation(untitled, critical());

    const event = firstEnqueued(outbox);
    expect(event.escalatedTo).toEqual([user]);
    expect(event.title).toBe(`Alert incident ${INCIDENT_ID}`);
    const wire: unknown = JSON.parse(JSON.stringify(event));
    expect(checkAlertEscalatedEvent(wire)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('throws when the first level cannot be enqueued, so the event is re-driven', async () => {
    // SCENARIO: the outbox write fails while escalating level 1.
    // EXPECTS: startEscalation rejects (it used to return a success-looking state
    //          and the incident stayed silent forever); the claim rolled back with
    //          the enqueue, so the redelivery claims level 1 again.
    const { service, outbox } = await build();
    outbox.enqueue.mockRejectedValueOnce(new Error('outbox down'));

    await expect(service.startEscalation(incident(), critical())).rejects.toThrow(/outbox down/);
  });

  it('reads the incident inside its tenant context when a timer advances the ladder', async () => {
    // SCENARIO: level 1 times out; the tick runs outside any request context.
    // EXPECTS: the per-tenant incident lookup sees the incident's tenant (it used
    //          to hit the empty source schema, find nothing, and stop the ladder).
    const { service, tenantSeenByFindOne } = await build();
    await service.startEscalation(incident(), critical());

    await service.escalateToNextLevel(INCIDENT_ID);

    expect(tenantSeenByFindOne.length).toBeGreaterThan(0);
    expect(tenantSeenByFindOne.every((tenant) => tenant === TENANT_ID)).toBe(true);
  });
});
