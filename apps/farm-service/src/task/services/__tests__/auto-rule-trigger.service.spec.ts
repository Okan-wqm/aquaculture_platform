/**
 * AutoRuleTriggerService — tenant boundaries (FARM-HIGH-481)
 *
 * The service runs OUTSIDE HTTP request context (NATS handler + hourly job):
 * no AsyncLocalStorage, no TenantSchemaMiddleware. `auto_rules` and `tasks` are
 * under FORCE row-level security, so every database operation must go through
 * the tenant boundary (`runInTenantRead` / `runInTenantTransaction` / the
 * tenant-bound fan-out). A runner with only a `search_path` reads zero rows —
 * no AutoRule ever fired. These specs pin WHICH boundary carries WHICH tenant;
 * that the boundary really admits the rows is proven on real Postgres by
 * `task-crons.rls.postgres.spec.ts`.
 *
 * Paths tested:
 * - Events without tenantId / with a malformed one never reach the database
 * - The rule lookup is a read for the EVENT's tenant
 * - Each rule runs in its own transaction for ITS tenant; a failing rule does
 *   not stop its siblings; TaskCreated is published only after the commit
 * - processScheduleRules finds due rules per tenant, then runs each in its own
 *   tenant transaction
 *
 * @module Task/Tests
 */

// ---------------------------------------------------------------------------
// Mock entity modules BEFORE any imports that transitively reference them.
// This prevents ts-jest from compiling the entity files (which have
// strictPropertyInitialization issues with TypeORM decorators).
// ---------------------------------------------------------------------------
jest.mock('../../entities/auto-rule.entity', () => {
  const AutoRuleTrigger = {
    STOCK_LOW: 'STOCK_LOW',
    MAINTENANCE_DUE: 'MAINTENANCE_DUE',
    WATER_PARAM_ALERT: 'WATER_PARAM_ALERT',
    EXPIRY_NEAR: 'EXPIRY_NEAR',
    SCHEDULE: 'SCHEDULE',
    LICENSE_EXPIRY: 'LICENSE_EXPIRY',
  };

  // Minimal class stub — only needs to be a valid constructor for TypeORM
  class AutoRule {}

  return { AutoRule, AutoRuleTrigger };
});

jest.mock('../../entities/task.entity', () => {
  const TaskStatus = {
    PENDING: 'PENDING',
    IN_PROGRESS: 'IN_PROGRESS',
    COMPLETED: 'COMPLETED',
    CANCELLED: 'CANCELLED',
  };

  class Task {}

  return { Task, TaskStatus };
});

// Mock @platform/event-contracts (used by createBaseEvent)
jest.mock('@platform/event-contracts', () => ({
  createBaseEvent: jest.fn().mockImplementation((type: string, tenantId: string) => ({
    eventId: 'mock-event-id',
    eventType: type,
    timestamp: new Date(),
    tenantId,
  })),
}));

// Mock @platform/event-bus — the bus itself is mocked away, but the delivery
// outcome contract the service returns is the real one (PLAT-HIGH-902).
jest.mock('@platform/event-bus', () => ({
  NatsEventBus: jest.fn(),
  IEventHandler: jest.fn(),
  HandlerOutcome: jest.requireActual<{ HandlerOutcome: unknown }>(
    '../../../../../../platform/libs/event-bus/src/interfaces/handler-outcome',
  ).HandlerOutcome,
}));

jest.mock('@aquaculture/backend-common/database', () => ({
  ...jest.requireActual<Record<string, unknown>>('@aquaculture/backend-common/database'),
  runInTenantRead: jest.fn(),
  runInTenantTransaction: jest.fn(),
  forEachVerifiedTenantSchema: jest.fn(),
}));

import {
  forEachVerifiedTenantSchema,
  runInTenantRead,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';
import { createScheduledJobTestExecutor } from '@aquaculture/backend-common/scheduling/testing';
import { stub } from '@aquaculture/testing';
import type { NatsEventBus } from '@platform/event-bus';
import type { DataSource, EntityManager, QueryRunner, Repository } from 'typeorm';

import type { AutoRule } from '../../entities/auto-rule.entity';
import type { Task } from '../../entities/task.entity';
import { AutoRuleTriggerService } from '../auto-rule-trigger.service';

const scheduledJobs = createScheduledJobTestExecutor();

const TENANT_A = '4b529829-ea79-48da-982c-cd6fbec8ffb7';
const TENANT_B = '8f1d2c3b-5a6e-4f70-9b8c-1d2e3f4a5b6c';
const INVALID_TENANT_IDS = ['not-a-uuid', '', '1234', "'; DROP SCHEMA public; --", 'tenant_abc'];

const readMock = jest.mocked(runInTenantRead);
const transactionMock = jest.mocked(runInTenantTransaction);
const fanOutMock = jest.mocked(forEachVerifiedTenantSchema);

/** An AutoRule as the boundary returns it: only what the service reads and writes. */
const rule = (over: Partial<AutoRule> = {}): AutoRule =>
  stub<AutoRule>({
    id: 'rule-1',
    tenantId: TENANT_A,
    name: 'Low stock',
    taskTitle: 'Reorder {item}',
    triggerCondition: '24',
    lastTriggered: undefined,
    triggerCount: 0,
    assignTo: 'user-1',
    ...over,
  });

const mockEventBus = {
  subscribe: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(undefined),
};

function createService() {
  const service = new AutoRuleTriggerService(
    stub<Repository<AutoRule>>({}),
    stub<Repository<Task>>({}),
    stub<DataSource>({}),
    scheduledJobs.executor,
    stub<NatsEventBus>({ subscribe: mockEventBus.subscribe, publish: mockEventBus.publish }),
  );
  // The queryRunner the boundary hands the work: a manager that creates and saves.
  const manager = {
    find: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockImplementation((_entity: unknown, data: unknown) => data),
    save: jest
      .fn()
      .mockImplementation((_entity: unknown, data: Record<string, unknown>) =>
        Promise.resolve({ id: 'task-1', ...data, dueDate: new Date('2026-10-27T00:00:00Z') }),
      ),
  };
  const queryRunner = stub<QueryRunner>({ manager: stub<EntityManager>(manager) });
  return { service, manager, queryRunner };
}

describe('AutoRuleTriggerService', () => {
  beforeEach(() => {
    // Only the boundaries are reset: the entity and event-contract mocks above keep their implementations.
    for (const mock of [readMock, transactionMock, fanOutMock, mockEventBus.publish])
      mock.mockReset();
    mockEventBus.publish.mockResolvedValue(undefined);
  });

  describe('handleEvent — what never reaches the database', () => {
    it.each([
      ['no tenantId', {}],
      ['a null tenantId', { tenantId: null }],
      ['an undefined tenantId', { tenantId: undefined }],
    ])('terminates an event with %s', async (_name, event) => {
      const { service } = createService();

      const outcome = await service.handleEvent('inventory.lowStock', event);

      expect(outcome.kind).toBe('terminate');
      expect(readMock).not.toHaveBeenCalled();
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it.each(INVALID_TENANT_IDS)(
      'terminates an event with the malformed tenantId %p',
      async (id) => {
        const { service } = createService();

        const outcome = await service.handleEvent('inventory.lowStock', { tenantId: id });

        expect(outcome.kind).toBe('terminate');
        expect(readMock).not.toHaveBeenCalled();
      },
    );

    it('acknowledges an event name no rule listens for, without touching the database', async () => {
      const { service } = createService();

      const outcome = await service.handleEvent('unknown.event.type', { tenantId: TENANT_A });

      expect(outcome.kind).toBe('ack');
      expect(readMock).not.toHaveBeenCalled();
    });
  });

  describe('handleEvent — the lookup and the execution', () => {
    it("looks the rules up as a read for the EVENT's tenant in the farm source schema", async () => {
      const { service, queryRunner, manager } = createService();
      readMock.mockImplementation((_ds, _schema, _tenant, work) => work(queryRunner));

      await service.handleEvent('inventory.lowStock', { tenantId: TENANT_A });

      expect(readMock).toHaveBeenCalledTimes(1);
      expect(readMock.mock.calls[0]?.[1]).toBe('farm');
      expect(readMock.mock.calls[0]?.[2]).toBe(TENANT_A);
      expect(manager.find).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT_A,
            trigger: 'STOCK_LOW',
            isActive: true,
          }),
        }),
      );
    });

    it('acknowledges when no rule matches and opens no transaction', async () => {
      const { service } = createService();
      readMock.mockResolvedValue([]);

      const outcome = await service.handleEvent('inventory.lowStock', { tenantId: TENANT_A });

      expect(outcome.kind).toBe('ack');
      expect(transactionMock).not.toHaveBeenCalled();
    });

    it("runs EACH matching rule in its own transaction for the RULE's tenant", async () => {
      const { service, queryRunner } = createService();
      readMock.mockResolvedValue([rule({ id: 'r1' }), rule({ id: 'r2', tenantId: TENANT_B })]);
      transactionMock.mockImplementation((_ds, _schema, _tenant, work) => work(queryRunner));

      const outcome = await service.handleEvent('inventory.lowStock', {
        tenantId: TENANT_A,
        item: 'feed',
      });

      expect(outcome.kind).toBe('ack');
      expect(transactionMock).toHaveBeenCalledTimes(2);
      expect(transactionMock.mock.calls.map((call) => [call[1], call[2]])).toEqual([
        ['farm', TENANT_A],
        ['farm', TENANT_B],
      ]);
    });

    it('creates the task from the event (placeholders filled) and bumps the rule in the same transaction', async () => {
      const { service, queryRunner, manager } = createService();
      const matching = rule({ id: 'r1' });
      readMock.mockResolvedValue([matching]);
      transactionMock.mockImplementation((_ds, _schema, _tenant, work) => work(queryRunner));

      await service.handleEvent('inventory.lowStock', { tenantId: TENANT_A, item: 'feed' });

      expect(manager.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          tenantId: TENANT_A,
          title: 'Reorder feed',
          isAutoGenerated: true,
        }),
      );
      expect(manager.save).toHaveBeenCalledTimes(2); // the task, then the rule's stats
      expect(matching.triggerCount).toBe(1);
      expect(matching.lastTriggered).toBeInstanceOf(Date);
    });

    it('publishes TaskCreated only AFTER the transaction committed', async () => {
      const { service, queryRunner } = createService();
      readMock.mockResolvedValue([rule()]);
      const order: string[] = [];
      transactionMock.mockImplementation(async (_ds, _schema, _tenant, work) => {
        const result = await work(queryRunner);
        order.push('commit');
        return result;
      });
      mockEventBus.publish.mockImplementation(() => {
        order.push('publish');
        return Promise.resolve();
      });

      await service.handleEvent('inventory.lowStock', { tenantId: TENANT_A, item: 'feed' });

      expect(order).toEqual(['commit', 'publish']);
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'TaskCreated', tenantId: TENANT_A }),
      );
    });

    it('a failing rule leaves nothing published, does not stop its siblings, and the trigger is still acknowledged', async () => {
      const { service, queryRunner } = createService();
      readMock.mockResolvedValue([rule({ id: 'bad' }), rule({ id: 'good' })]);
      let call = 0;
      transactionMock.mockImplementation((_ds, _schema, _tenant, work) => {
        call += 1;
        return call === 1 ? Promise.reject(new Error('rule 1 exploded')) : work(queryRunner);
      });

      const outcome = await service.handleEvent('inventory.lowStock', {
        tenantId: TENANT_A,
        item: 'feed',
      });

      expect(outcome.kind).toBe('ack');
      expect(transactionMock).toHaveBeenCalledTimes(2);
      expect(mockEventBus.publish).toHaveBeenCalledTimes(1); // the good rule only
    });

    it('asks for a redelivery when the rule lookup itself fails', async () => {
      const { service } = createService();
      readMock.mockRejectedValue(new Error('connection reset'));

      const outcome = await service.handleEvent('inventory.lowStock', { tenantId: TENANT_A });

      expect(outcome.kind).toBe('retry');
      expect(transactionMock).not.toHaveBeenCalled();
    });
  });

  describe('processScheduleRules', () => {
    /** Run the fan-out handler once per supplied tenant, with the rules that tenant holds. */
    function fanOutWith(perTenant: Record<string, AutoRule[]>, failing: string[] = []): void {
      fanOutMock.mockImplementation(async (_ds, handler) => {
        const results = [];
        for (const [tenantId, rules] of Object.entries(perTenant)) {
          const schemaName = `tenant_${tenantId.replace(/-/g, '').slice(0, 16)}`;
          if (failing.includes(tenantId)) {
            results.push({
              schemaName,
              tenantId,
              outcome: 'error' as const,
              error: new Error('lookup failed'),
            });
            continue;
          }
          await handler({
            schemaName,
            tenantId,
            queryRunner: stub<QueryRunner>({
              manager: stub<EntityManager>({ find: jest.fn().mockResolvedValue(rules) }),
            }),
            signal: new AbortController().signal,
          });
          results.push({ schemaName, tenantId, outcome: 'ok' as const });
        }
        return results;
      });
    }

    it('finds the due rules on the tenant-bound fan-out, then runs each in ITS tenant transaction', async () => {
      const { service, queryRunner } = createService();
      fanOutWith({
        [TENANT_A]: [rule({ id: 'a1' })],
        [TENANT_B]: [rule({ id: 'b1', tenantId: TENANT_B })],
      });
      transactionMock.mockImplementation((_ds, _schema, _tenant, work) => work(queryRunner));

      await service.processScheduleRules();

      expect(fanOutMock).toHaveBeenCalledTimes(1);
      expect(transactionMock.mock.calls.map((call) => call[2])).toEqual([TENANT_A, TENANT_B]);
    });

    it('skips a rule with an invalid interval and one still inside its interval', async () => {
      const { service, queryRunner } = createService();
      fanOutWith({
        [TENANT_A]: [
          rule({ id: 'bad-interval', triggerCondition: 'soon' }),
          rule({ id: 'zero', triggerCondition: '0' }),
          rule({ id: 'recent', lastTriggered: new Date(Date.now() - 60 * 60 * 1000) }),
          rule({ id: 'due', lastTriggered: new Date(Date.now() - 30 * 60 * 60 * 1000) }),
        ],
      });
      transactionMock.mockImplementation((_ds, _schema, _tenant, work) => work(queryRunner));

      await service.processScheduleRules();

      expect(transactionMock).toHaveBeenCalledTimes(1);
    });

    it("reports a tenant whose lookup failed and still runs the other tenants' rules", async () => {
      const { service, queryRunner } = createService();
      fanOutWith({ [TENANT_A]: [rule()], [TENANT_B]: [] }, [TENANT_A]);
      transactionMock.mockImplementation((_ds, _schema, _tenant, work) => work(queryRunner));
      const logged = jest.spyOn(service['logger'], 'error').mockImplementation();

      await service.processScheduleRules();

      expect(logged).toHaveBeenCalledWith(expect.stringContaining('lookup failed'));
      expect(transactionMock).not.toHaveBeenCalled(); // tenant A failed, tenant B had nothing
    });

    it('one failing rule does not stop the next', async () => {
      const { service, queryRunner } = createService();
      fanOutWith({ [TENANT_A]: [rule({ id: 'bad' }), rule({ id: 'good' })] });
      let call = 0;
      transactionMock.mockImplementation((_ds, _schema, _tenant, work) => {
        call += 1;
        return call === 1 ? Promise.reject(new Error('boom')) : work(queryRunner);
      });

      await expect(service.processScheduleRules()).resolves.toBeUndefined();

      expect(transactionMock).toHaveBeenCalledTimes(2);
    });

    it('does nothing when no tenant has a due rule', async () => {
      const { service } = createService();
      fanOutWith({ [TENANT_A]: [] });

      await service.processScheduleRules();

      expect(transactionMock).not.toHaveBeenCalled();
    });
  });
});
