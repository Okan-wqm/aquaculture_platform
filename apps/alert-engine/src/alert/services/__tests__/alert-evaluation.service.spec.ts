import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import type { BaseEvent } from '@platform/event-contracts';
import { AlertEvaluationService, SensorReadingData } from '../alert-evaluation.service';
import {
  AlertRule,
  AlertOperator,
  AlertSeverity,
} from '../../../database/entities/alert-rule.entity';
import { AlertHistory } from '../../entities/alert-history.entity';
import { AlertIncident, IncidentStatus } from '../../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../../escalation/escalation-manager.service';
import { RedisService } from '@aquaculture/backend-common/redis';

/**
 * ALERT-CRITICAL-001 coverage.
 *
 * These tests assert that AlertTriggered / AlertResolved commit via the
 * transactional outbox on the SAME EntityManager as the state write, and that
 * a failed enqueue propagates so the transaction rolls back (an un-notified
 * incident must never commit).
 *
 * Cast-free mocking only: OutboxPublisher / DataSource are supplied through
 * Nest `useValue` (untyped), entity stubs are typed `Partial<Entity>`, and the
 * transaction-mock callback is typed structurally against EntityManager.
 */

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

/** A transaction mock whose callback receives the shared mock manager. */
function createMockManager(): { save: jest.Mock; findOne: jest.Mock } {
  return {
    save: jest.fn().mockImplementation((_entity: unknown, row: unknown) => row),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

describe('AlertEvaluationService — transactional outbox (ALERT-CRITICAL-001)', () => {
  let service: AlertEvaluationService;
  let manager: ReturnType<typeof createMockManager>;
  let outbox: { enqueue: jest.Mock };
  let escalationManager: { startEscalation: jest.Mock };
  let incidentFind: jest.Mock;

  const rule: Partial<AlertRule> = {
    id: 'rule-1',
    name: 'DO Crash',
    tenantId: TENANT_ID,
    cooldownMinutes: 0,
    notificationChannels: ['email'],
    recipients: ['operator@example.com'],
  };

  const reading: SensorReadingData = {
    sensorId: 'sensor-1',
    tenantId: TENANT_ID,
    sourceEventId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    farmId: 'farm-1',
    pondId: 'pond-1',
    readings: { dissolved_oxygen: 2 },
    timestamp: new Date('2026-06-24T00:00:00.000Z'),
  };

  const triggeringRule: Partial<AlertRule> = {
    ...rule,
    conditions: [
      {
        parameter: 'dissolved_oxygen',
        operator: AlertOperator.LT,
        threshold: 4,
        severity: AlertSeverity.CRITICAL,
      },
    ],
    sensorId: undefined,
    farmId: undefined,
    pondId: undefined,
    isActive: true,
  };

  async function buildService(
    overrides: {
      outboxOverride?: { enqueue: jest.Mock };
    } = {},
  ): Promise<void> {
    manager = createMockManager();
    outbox = overrides.outboxOverride ?? {
      enqueue: jest.fn().mockResolvedValue(undefined),
    };
    escalationManager = { startEscalation: jest.fn().mockResolvedValue(null) };
    incidentFind = jest.fn().mockResolvedValue([]);

    // Structural typing of the transaction callback against the mock manager
    // shape — cast-free. `useValue` is untyped so this literal is accepted by
    // Nest without asserting DataSource compatibility.
    const mockDataSource = {
      transaction: (cb: (m: typeof manager) => Promise<unknown>): Promise<unknown> => cb(manager),
    };

    const ruleQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([triggeringRule]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AlertEvaluationService,
        {
          provide: getRepositoryToken(AlertRule),
          useValue: { createQueryBuilder: jest.fn().mockReturnValue(ruleQueryBuilder) },
        },
        {
          provide: getRepositoryToken(AlertHistory),
          useValue: {
            create: jest.fn().mockImplementation((row: Partial<AlertHistory>) => ({
              ...row,
              id: 'history-1',
            })),
          },
        },
        {
          provide: getRepositoryToken(AlertIncident),
          useValue: {
            create: jest.fn().mockImplementation((row: Partial<AlertIncident>) => {
              const incident: Partial<AlertIncident> = {
                ...row,
                id: 'incident-1',
                addTimelineEvent: jest.fn(),
                recordOccurrence: jest.fn(),
              };
              return incident;
            }),
            find: incidentFind,
          },
        },
        { provide: DataSource, useValue: mockDataSource },
        { provide: OutboxPublisher, useValue: outbox },
        {
          provide: RedisService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            setNx: jest.fn().mockResolvedValue(true),
            deletePattern: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: EscalationManagerService, useValue: escalationManager },
      ],
    }).compile();

    service = module.get<AlertEvaluationService>(AlertEvaluationService);
  }

  describe('AlertTriggered', () => {
    it('enqueues AlertTriggered on the transaction manager (not an event bus)', async () => {
      await buildService();

      await service.evaluateSensorReading(reading);

      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      const [, passedManager] = outbox.enqueue.mock.calls[0] as [BaseEvent, EntityManager];
      // Enqueued on the SAME manager the state writes used.
      expect(passedManager).toBe(manager);
      // History + incident saved on the same manager → atomic.
      expect(manager.save).toHaveBeenCalledWith(AlertHistory, expect.anything());
      expect(manager.save).toHaveBeenCalledWith(AlertIncident, expect.anything());
    });

    it('keeps the existing flat fields and version 2 on the built event', async () => {
      await buildService();

      await service.evaluateSensorReading(reading);

      const [event] = outbox.enqueue.mock.calls[0] as [Record<string, unknown>];
      expect(event['eventType']).toBe('AlertTriggered');
      expect(event['version']).toBe(2);
      expect(event['alertId']).toBe('history-1');
      expect(event['ruleId']).toBe('rule-1');
      expect(event['ruleName']).toBe('DO Crash');
      expect(event['severity']).toBe('critical');
      expect(event['channels']).toEqual(['email']);
      expect(event['recipients']).toEqual(['operator@example.com']);
      expect(event['triggerSensorId']).toBe('sensor-1');
      expect(event['triggerParameter']).toBe('dissolved_oxygen');
      expect(event['triggerValue']).toBe(2);
      expect(event['triggerThreshold']).toBe(4);
    });

    it('starts escalation only after the trigger has committed', async () => {
      await buildService();

      await service.evaluateSensorReading(reading);

      expect(escalationManager.startEscalation).toHaveBeenCalledTimes(1);
    });

    it('rolls back the trigger when the outbox enqueue rejects', async () => {
      const failing = {
        enqueue: jest.fn().mockRejectedValue(new Error('NATS outbox down')),
      };
      await buildService({ outboxOverride: failing });

      // The swallowing try/catch around the publish was removed; the failure
      // propagates so the dataSource.transaction rolls back. Task 1.5: the
      // service now RETHROWS so the NATS handler NAKs for redelivery —
      // deterministic child ids + the (rule_id, source_event_id) unique key
      // make that redelivery idempotent.
      await expect(service.evaluateSensorReading(reading)).rejects.toThrow('NATS outbox down');

      expect(failing.enqueue).toHaveBeenCalledTimes(1);
      // Escalation must NOT start because the transaction did not commit.
      expect(escalationManager.startEscalation).not.toHaveBeenCalled();
    });

    it('records the source event id on the alert history row (Task 1.5)', async () => {
      await buildService();

      await service.evaluateSensorReading({
        ...reading,
        sourceEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });

      expect(manager.save).toHaveBeenCalledWith(
        AlertHistory,
        expect.objectContaining({
          sourceEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      );
    });

    it('suppresses a duplicate (rule_id, source_event_id) idempotently — no re-fire, no event', async () => {
      await buildService();
      manager.save.mockRejectedValueOnce(
        Object.assign(
          new Error(
            'duplicate key value violates unique constraint "uq_alert_history_rule_source_event"',
          ),
          { code: '23505' },
        ),
      );

      await expect(
        service.evaluateSensorReading({
          ...reading,
          sourceEventId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      ).resolves.toBeUndefined();

      expect(outbox.enqueue).not.toHaveBeenCalled();
      expect(escalationManager.startEscalation).not.toHaveBeenCalled();
    });
  });

  describe('AlertResolved (auto-resolve)', () => {
    const activeIncident: Partial<AlertIncident> = {
      id: 'incident-9',
      tenantId: TENANT_ID,
      sensorId: 'sensor-1',
      severity: AlertSeverity.LOW,
      status: IncidentStatus.NEW,
      addTimelineEvent: jest.fn(),
    };

    const normalReading: SensorReadingData = {
      sensorId: 'sensor-1',
      tenantId: TENANT_ID,
      sourceEventId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      readings: { dissolved_oxygen: 8 },
      timestamp: new Date('2026-06-24T01:00:00.000Z'),
    };

    it('enqueues AlertResolved on the transaction manager when readings normalise', async () => {
      await buildService();
      // No conditions match (DO is healthy) → query builder still returns a
      // rule, but its condition will not trigger; force the auto-resolve path
      // by returning an active low-severity incident.
      incidentFind.mockResolvedValue([activeIncident]);

      await service.evaluateSensorReading(normalReading);

      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      const [event, passedManager] = outbox.enqueue.mock.calls[0] as [
        Record<string, unknown>,
        EntityManager,
      ];
      expect(passedManager).toBe(manager);
      expect(manager.save).toHaveBeenCalledWith(AlertIncident, activeIncident);
      expect(event['eventType']).toBe('AlertResolved');
      expect(event['alertId']).toBe('incident-9');
      expect(event['resolvedBy']).toBe('SYSTEM_AUTO_RESOLVE');
      expect(event['autoResolved']).toBe(true);
      expect(event['resolution']).toBe('Sensor readings returned to normal range');
    });
  });
});
