/**
 * AutoRuleTriggerService — NATS Handler Tenant Isolation Tests
 *
 * Verifies tenant isolation in NATS event handlers that run OUTSIDE
 * HTTP request context (no AsyncLocalStorage, no TenantSchemaMiddleware).
 *
 * Critical security paths tested:
 * - Events without tenantId are silently dropped (logged as warning)
 * - Events with invalid UUID format are rejected (logged as error)
 * - Schema name is correctly derived from UUID (16 hex chars)
 * - QueryRunner lifecycle: connect -> SET search_path -> work -> RESET -> release
 * - processScheduleRules iterates all tenant schemas independently
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

import {
  createMockDataSourceWithQueryRunner,
  TEST_TENANT_ID,
  TEST_TENANT_SCHEMA,
  INVALID_UUIDS,
  expectQueryRunnerCleanedUp,
  expectSearchPathSet,
} from '../../../../../../libs/backend-common/src/database/__tests__/nats-handler-test.helpers';
import { AutoRuleTriggerService } from '../auto-rule-trigger.service';

// ---------------------------------------------------------------------------
// Mock NatsEventBus (provided via @Inject('EVENT_BUS'))
// ---------------------------------------------------------------------------
const mockEventBus = {
  subscribe: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(undefined),
};

/**
 * Factory: creates a fresh service instance with fully-mocked dependencies.
 */
function createService() {
  const { mockDataSource, mockQueryRunner, mockManager } = createMockDataSourceWithQueryRunner();

  const mockAutoRuleRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue({ id: 'rule-1' }),
    create: jest.fn().mockImplementation((data: any) => data),
  } as any;

  const mockTaskRepo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue({ id: 'task-1' }),
    create: jest.fn().mockImplementation((data: any) => data),
  } as any;

  const service = new AutoRuleTriggerService(
    mockAutoRuleRepo,
    mockTaskRepo,
    mockDataSource as any,
    mockEventBus as any,
  );

  return {
    service,
    mockDataSource,
    mockQueryRunner,
    mockManager,
    mockAutoRuleRepo,
    mockTaskRepo,
  };
}

// ===========================================================================
// Tests
// ===========================================================================
describe('AutoRuleTriggerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Reject events without tenantId
  // -------------------------------------------------------------------------
  describe('handleEvent — tenant isolation', () => {
    it('should reject events without tenantId', async () => {
      const { service, mockDataSource } = createService();

      await service.handleEvent('inventory.lowStock', {});

      // No DB interaction should occur
      expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('should reject events with null tenantId', async () => {
      const { service, mockDataSource } = createService();

      await service.handleEvent('inventory.lowStock', { tenantId: null });

      expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    it('should reject events with undefined tenantId', async () => {
      const { service, mockDataSource } = createService();

      await service.handleEvent('inventory.lowStock', {
        tenantId: undefined,
      });

      expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 2. Reject events with invalid UUID format
    // -----------------------------------------------------------------------
    it.each(INVALID_UUIDS)(
      'should reject events with invalid UUID: %s ("%s")',
      async (_label, invalidId) => {
        const { service, mockDataSource } = createService();

        await service.handleEvent('inventory.lowStock', {
          tenantId: invalidId,
        });

        // Invalid UUID should be caught before QueryRunner creation
        expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
      },
    );
  });

  // -------------------------------------------------------------------------
  // 3. Correct 16-char schema name derivation
  // -------------------------------------------------------------------------
  describe('handleEvent — schema name derivation', () => {
    it('should compute correct 16-char schema name', async () => {
      const { service, mockQueryRunner } = createService();

      await service.handleEvent('inventory.lowStock', {
        tenantId: TEST_TENANT_ID,
      });

      // Verify SET search_path uses the correct schema:
      //   "4b529829-ea79-48da-982c-cd6fbec8ffb7"
      //   -> remove dashes -> "4b529829ea7948da982ccd6fbec8ffb7"
      //   -> first 16 chars -> "4b529829ea7948da"
      //   -> "tenant_4b529829ea7948da"
      expectSearchPathSet(mockQueryRunner, TEST_TENANT_SCHEMA, 'farm');
    });

    it('should handle uppercase UUID and produce lowercase schema name', async () => {
      const { service, mockQueryRunner } = createService();

      await service.handleEvent('inventory.lowStock', {
        tenantId: TEST_TENANT_ID.toUpperCase(),
      });

      // Schema name must always be lowercase
      expectSearchPathSet(mockQueryRunner, TEST_TENANT_SCHEMA, 'farm');
    });

    it('should produce schema name of exactly 23 chars (tenant_ + 16 hex)', async () => {
      const { service, mockQueryRunner } = createService();

      await service.handleEvent('inventory.lowStock', {
        tenantId: TEST_TENANT_ID,
      });

      const setCall = mockQueryRunner.query.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('SET'),
      );
      expect(setCall).toBeDefined();

      // Extract schema name from SET search_path TO "tenant_xxx", farm, public
      const match = (setCall![0] as string).match(/"(tenant_[0-9a-f]+)"/);
      expect(match).not.toBeNull();
      expect(match![1]).toHaveLength(23); // 'tenant_' (7) + 16 hex chars
    });
  });

  // -------------------------------------------------------------------------
  // 4. SET search_path before querying auto_rules
  // -------------------------------------------------------------------------
  describe('handleEvent — search_path ordering', () => {
    it('should SET search_path before querying auto_rules', async () => {
      const { service, mockQueryRunner, mockManager } = createService();

      // Track call order
      const callOrder: string[] = [];
      mockQueryRunner.query.mockImplementation(async (sql: string) => {
        callOrder.push(`query:${sql.substring(0, 20)}`);
        return [];
      });
      mockManager.find.mockImplementation(async () => {
        callOrder.push('manager.find');
        return [];
      });

      await service.handleEvent('inventory.lowStock', {
        tenantId: TEST_TENANT_ID,
      });

      // SET search_path must come before manager.find
      const setPathIndex = callOrder.findIndex((c) => c.startsWith('query:SET search_path'));
      const findIndex = callOrder.findIndex((c) => c === 'manager.find');

      expect(setPathIndex).toBeGreaterThanOrEqual(0);
      expect(findIndex).toBeGreaterThanOrEqual(0);
      expect(setPathIndex).toBeLessThan(findIndex);
    });
  });

  // -------------------------------------------------------------------------
  // 5. RESET search_path and release QueryRunner on success
  // -------------------------------------------------------------------------
  describe('handleEvent — QueryRunner lifecycle (success)', () => {
    it('should RESET search_path and release QueryRunner on success', async () => {
      const { service, mockQueryRunner } = createService();

      await service.handleEvent('inventory.lowStock', {
        tenantId: TEST_TENANT_ID,
      });

      expect(mockQueryRunner.connect).toHaveBeenCalled();
      expectQueryRunnerCleanedUp(mockQueryRunner);
    });

    it('should call connect before SET search_path', async () => {
      const { service, mockQueryRunner } = createService();

      const callOrder: string[] = [];
      mockQueryRunner.connect.mockImplementation(async () => {
        callOrder.push('connect');
      });
      mockQueryRunner.query.mockImplementation(async () => {
        callOrder.push('query');
        return [];
      });

      await service.handleEvent('inventory.lowStock', {
        tenantId: TEST_TENANT_ID,
      });

      expect(callOrder[0]).toBe('connect');
    });
  });

  // -------------------------------------------------------------------------
  // 6. RESET search_path and release QueryRunner on error
  // -------------------------------------------------------------------------
  describe('handleEvent — QueryRunner lifecycle (error)', () => {
    it('should RESET search_path and release QueryRunner on error', async () => {
      const { service, mockQueryRunner, mockManager } = createService();

      // Force manager.find to throw
      mockManager.find.mockRejectedValueOnce(new Error('DB connection lost'));

      await service.handleEvent('inventory.lowStock', {
        tenantId: TEST_TENANT_ID,
      });

      // Despite the error, cleanup MUST happen
      expectQueryRunnerCleanedUp(mockQueryRunner);
    });

    it('should release QueryRunner even if RESET search_path fails', async () => {
      const { service, mockQueryRunner } = createService();

      // Make RESET search_path itself throw
      mockQueryRunner.query.mockImplementation(async (sql: string) => {
        if (sql === 'RESET search_path') {
          throw new Error('RESET failed');
        }
        return [];
      });

      await service.handleEvent('inventory.lowStock', {
        tenantId: TEST_TENANT_ID,
      });

      // release() should still be called even if RESET throws
      expect(mockQueryRunner.release).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 7. processScheduleRules should iterate all tenant schemas
  // -------------------------------------------------------------------------
  describe('processScheduleRules', () => {
    it('should iterate all tenant schemas', async () => {
      const { service, mockDataSource, mockManager } = createService();

      // Mock getTenantSchemas() — returns list from information_schema
      mockDataSource.query.mockResolvedValueOnce([
        { schema_name: 'tenant_aaaa111122223333' },
        { schema_name: 'tenant_bbbb444455556666' },
      ]);

      // No active schedule rules for any schema
      mockManager.find.mockResolvedValue([]);

      await service.processScheduleRules();

      // Should create a QueryRunner for each tenant schema
      expect(mockDataSource.createQueryRunner).toHaveBeenCalledTimes(2);
    });

    it('should SET search_path for each tenant schema independently', async () => {
      const { service, mockDataSource } = createService();

      const schema1 = 'tenant_aaaa111122223333';
      const schema2 = 'tenant_bbbb444455556666';

      mockDataSource.query.mockResolvedValueOnce([
        { schema_name: schema1 },
        { schema_name: schema2 },
      ]);

      // Create separate QueryRunners for each call
      const qr1 = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([]),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
          find: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          save: jest.fn(),
        },
      };
      const qr2 = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([]),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
          find: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          save: jest.fn(),
        },
      };

      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qr1 as any)
        .mockReturnValueOnce(qr2 as any);

      await service.processScheduleRules();

      // Verify each schema got its own SET search_path
      expect(qr1.query).toHaveBeenCalledWith(`SET search_path TO "${schema1}", farm, public`);
      expect(qr2.query).toHaveBeenCalledWith(`SET search_path TO "${schema2}", farm, public`);
    });

    it('should release all QueryRunners even if one schema fails', async () => {
      const { service, mockDataSource } = createService();

      mockDataSource.query.mockResolvedValueOnce([
        { schema_name: 'tenant_aaaa111122223333' },
        { schema_name: 'tenant_bbbb444455556666' },
      ]);

      // First QR: SET search_path succeeds but find throws
      const qr1 = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([]),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
          find: jest.fn().mockRejectedValue(new Error('Schema does not exist')),
          create: jest.fn(),
          save: jest.fn(),
        },
      };
      // Second QR: works normally
      const qr2 = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([]),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
          find: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          save: jest.fn(),
        },
      };

      mockDataSource.createQueryRunner
        .mockReturnValueOnce(qr1 as any)
        .mockReturnValueOnce(qr2 as any);

      await service.processScheduleRules();

      // Both QueryRunners must be released
      expect(qr1.release).toHaveBeenCalled();
      expect(qr2.release).toHaveBeenCalled();
    });

    it('should handle empty tenant schemas list gracefully', async () => {
      const { service, mockDataSource } = createService();

      mockDataSource.query.mockResolvedValueOnce([]);

      await service.processScheduleRules();

      // No QueryRunners should be created
      expect(mockDataSource.createQueryRunner).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Edge: unknown event types are silently ignored
  // -------------------------------------------------------------------------
  describe('handleEvent — unknown event types', () => {
    it('should ignore events with unknown event names', async () => {
      const { service, mockQueryRunner } = createService();

      await service.handleEvent('unknown.event.type', {
        tenantId: TEST_TENANT_ID,
      });

      // Unknown event type has no TRIGGER_EVENT_MAP entry, so nothing happens
      // The service checks the trigger map and returns early when no match.
      expect(mockQueryRunner.manager.find).not.toHaveBeenCalled();
    });
  });
});
