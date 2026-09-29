import { getRequestContext } from '@aquaculture/backend-common/logging';
import { RedisService } from '@aquaculture/backend-common/redis';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { AlertEscalatedEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { DataSource } from 'typeorm';

import { AlertAuditService } from '../../audit/alert-audit.service';
import { AlertIncident, IncidentStatus } from '../../database/entities/alert-incident.entity';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { EscalationPolicy } from '../../database/entities/escalation-policy.entity';
import { defaultEscalationLevels } from '../../escalation/default-escalation-policy';
import { EscalationManagerService } from '../../escalation/escalation-manager.service';
import { EscalationPolicyService } from '../../escalation/escalation-policy.service';
import { createRedisServiceMock, type RedisServiceMock } from './redis-service.mock';

/**
 * London-school harness for EscalationManagerService: the policy lookup, the
 * incident repository, Redis, the outbox and the level CLAIM (the conditional
 * UPDATE's query-builder chain) are doubles; the real planner, builder and
 * suppression rules run.
 */
export const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
export const INCIDENT_ID = '0b9e7c1a-1111-4d2e-9a3b-5c6d7e8f9a0b';
export const SITE_ID = '11111111-1111-4111-8111-111111111111';
export const POLICY_ID = '22222222-2222-4222-8222-222222222222';

export function incident(overrides: Partial<AlertIncident> = {}): AlertIncident {
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
    ...overrides,
  });
  return row;
}

export function policy(
  levels = defaultEscalationLevels(),
  overrides: Partial<EscalationPolicy> = {},
): EscalationPolicy {
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
    ...overrides,
  });
  return row;
}

export type OutboxDouble = { enqueue: jest.Mock<Promise<void>, [AlertEscalatedEvent, unknown]> };

/** The first event the escalation enqueued (fails the test when there is none). */
export function firstEnqueued(outbox: OutboxDouble): AlertEscalatedEvent {
  const call = outbox.enqueue.mock.calls[0];
  if (!call) throw new Error('no AlertEscalated was enqueued');
  return call[0];
}

export interface EscalationHarness {
  service: EscalationManagerService;
  outbox: OutboxDouble;
  incidents: { findOne: jest.Mock; save: jest.Mock };
  policies: { findMatchingPolicy: jest.Mock; getPolicy: jest.Mock };
  redis: RedisServiceMock;
  /** The level claim's `execute` — resolve `{ affected: 0 }` to lose the claim. */
  claimExecute: jest.Mock;
  audit: { log: jest.Mock };
  emitter: { emit: jest.Mock };
  tenantSeenByFindOne: Array<string | undefined>;
}

export async function buildEscalationHarness(): Promise<EscalationHarness> {
  const tenantSeenByFindOne: Array<string | undefined> = [];
  const incidents = {
    findOne: jest.fn(async () => {
      tenantSeenByFindOne.push(getRequestContext().tenantId);
      return incident();
    }),
    save: jest.fn(async (row: AlertIncident) => row),
  };
  const policies = {
    findMatchingPolicy: jest.fn(async (): Promise<EscalationPolicy | null> => policy()),
    getPolicy: jest.fn(async () => policy()),
  };
  const outbox: OutboxDouble = {
    enqueue: jest.fn<Promise<void>, [AlertEscalatedEvent, unknown]>(async () => undefined),
  };
  const claim: Record<string, jest.Mock> = {};
  for (const step of ['update', 'set', 'where', 'andWhere', 'setParameter', 'returning']) {
    claim[step] = jest.fn(() => claim);
  }
  const claimExecute = jest.fn(async () => ({ affected: 1, raw: [] }));
  claim['execute'] = claimExecute;
  const txManager = { createQueryBuilder: jest.fn(() => claim) };
  const dataSource = {
    transaction: (cb: (m: typeof txManager) => Promise<unknown>): Promise<unknown> => cb(txManager),
  };
  const redis = createRedisServiceMock();
  const audit = { log: jest.fn() };
  const emitter = { emit: jest.fn() };

  const moduleRef = await Test.createTestingModule({
    providers: [
      EscalationManagerService,
      { provide: getRepositoryToken(AlertIncident), useValue: incidents },
      { provide: EscalationPolicyService, useValue: policies },
      { provide: EventEmitter2, useValue: emitter },
      { provide: RedisService, useValue: redis },
      { provide: DataSource, useValue: dataSource },
      { provide: OutboxPublisher, useValue: outbox },
      { provide: AlertAuditService, useValue: audit },
    ],
  }).compile();

  return {
    service: moduleRef.get(EscalationManagerService),
    outbox,
    incidents,
    policies,
    redis,
    claimExecute,
    audit,
    emitter,
    tenantSeenByFindOne,
  };
}
