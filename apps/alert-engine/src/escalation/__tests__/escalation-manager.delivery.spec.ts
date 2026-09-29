import { getRequestContext } from '@aquaculture/backend-common/logging';
import { RedisService } from '@aquaculture/backend-common/redis';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { checkAlertEscalatedEvent, type AlertEscalatedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { createRedisServiceMock } from '../../__tests__/support/redis-service.mock';
import { AlertIncident, IncidentStatus } from '../../database/entities/alert-incident.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  EscalationActionType,
  EscalationPolicy,
  EscalationRecipientRole,
  EscalationRecipientScope,
  NotificationChannel,
} from '../../database/entities/escalation-policy.entity';
import { defaultEscalationLevels } from '../default-escalation-policy';
import { EscalationManagerService } from '../escalation-manager.service';
import { EscalationPolicyService } from '../escalation-policy.service';

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
const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const INCIDENT_ID = '0b9e7c1a-1111-4d2e-9a3b-5c6d7e8f9a0b';
const SITE_ID = '11111111-1111-4111-8111-111111111111';
const POLICY_ID = '22222222-2222-4222-8222-222222222222';

function incident(): AlertIncident {
  const row = new AlertIncident();
  Object.assign(row, {
    id: INCIDENT_ID,
    tenantId: TENANT_ID,
    ruleId: null,
    signalKey: `water:equipment:${SITE_ID}`,
    siteId: SITE_ID,
    title: 'Water Quality Critical: tank T1',
    description: 'Water quality critical at tank T1: DO 2.1 below 4',
    severity: AlertSeverity.CRITICAL,
    status: IncidentStatus.NEW,
    escalationLevel: 0,
    timeline: [],
  });
  return row;
}

function policy(levels = defaultEscalationLevels()): EscalationPolicy {
  const row = new EscalationPolicy();
  Object.assign(row, {
    id: POLICY_ID,
    tenantId: TENANT_ID,
    name: 'default',
    severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
    levels,
    repeatIntervalMinutes: 30,
    maxRepeats: 0,
    isActive: true,
    isDefault: true,
    priority: 0,
  });
  return row;
}

type OutboxDouble = { enqueue: jest.Mock<Promise<void>, [AlertEscalatedEvent, unknown]> };

/** The first event the escalation enqueued (fails the test when there is none). */
function firstEnqueued(outbox: OutboxDouble): AlertEscalatedEvent {
  const call = outbox.enqueue.mock.calls[0];
  if (!call) throw new Error('no AlertEscalated was enqueued');
  return call[0];
}

async function build(): Promise<{
  service: EscalationManagerService;
  outbox: OutboxDouble;
  incidents: { findOne: jest.Mock; save: jest.Mock };
  policies: { findMatchingPolicy: jest.Mock; getPolicy: jest.Mock };
  tenantSeenByFindOne: Array<string | undefined>;
}> {
  const tenantSeenByFindOne: Array<string | undefined> = [];
  const incidents = {
    findOne: jest.fn(async () => {
      tenantSeenByFindOne.push(getRequestContext().tenantId);
      return incident();
    }),
    save: jest.fn(async (row: AlertIncident) => row),
  };
  const policies = {
    findMatchingPolicy: jest.fn(async () => policy()),
    getPolicy: jest.fn(async () => policy()),
  };
  const outbox: OutboxDouble = {
    enqueue: jest.fn<Promise<void>, [AlertEscalatedEvent, unknown]>(async () => undefined),
  };
  const txManager = { save: jest.fn(async (_entity: unknown, row: unknown) => row) };
  const dataSource = {
    transaction: (cb: (m: typeof txManager) => Promise<unknown>): Promise<unknown> => cb(txManager),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      EscalationManagerService,
      { provide: getRepositoryToken(AlertIncident), useValue: incidents },
      { provide: EscalationPolicyService, useValue: policies },
      { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      { provide: RedisService, useValue: createRedisServiceMock() },
      { provide: DataSource, useValue: dataSource },
      { provide: OutboxPublisher, useValue: outbox },
    ],
  }).compile();

  return {
    service: moduleRef.get(EscalationManagerService),
    outbox,
    incidents,
    policies,
    tenantSeenByFindOne,
  };
}

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

    await service.startEscalation(incident(), AlertSeverity.CRITICAL, `water:equipment:${SITE_ID}`);

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

    await service.startEscalation(incident(), AlertSeverity.CRITICAL);

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

    await service.startEscalation(untitled, AlertSeverity.CRITICAL);

    const event = firstEnqueued(outbox);
    expect(event.escalatedTo).toEqual([user]);
    expect(event.title).toBe(`Alert incident ${INCIDENT_ID}`);
    const wire: unknown = JSON.parse(JSON.stringify(event));
    expect(checkAlertEscalatedEvent(wire)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('throws when the first level cannot be enqueued, so the event is re-driven', async () => {
    // SCENARIO: the outbox write fails while escalating level 1.
    // EXPECTS: startEscalation rejects (it used to return a success-looking state
    //          and the incident stayed silent forever) and no escalation stays active.
    const { service, outbox } = await build();
    outbox.enqueue.mockRejectedValueOnce(new Error('outbox down'));

    await expect(service.startEscalation(incident(), AlertSeverity.CRITICAL)).rejects.toThrow(
      /Escalation level 1 failed/,
    );
    expect(await service.isEscalating(INCIDENT_ID)).toBe(false);
  });

  it('reads the incident inside its tenant context when a timer advances the ladder', async () => {
    // SCENARIO: level 1 times out; the tick runs outside any request context.
    // EXPECTS: the per-tenant incident lookup sees the incident's tenant (it used
    //          to hit the empty source schema, find nothing, and stop the ladder).
    const { service, tenantSeenByFindOne } = await build();
    await service.startEscalation(incident(), AlertSeverity.CRITICAL);

    await service.escalateToNextLevel(INCIDENT_ID);

    expect(tenantSeenByFindOne.length).toBeGreaterThan(0);
    expect(tenantSeenByFindOne.every((tenant) => tenant === TENANT_ID)).toBe(true);
  });
});
