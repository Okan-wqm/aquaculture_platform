/**
 * SensorReadingEventHandler — NATS Handler Tenant Isolation Tests
 *
 * This handler uses the AsyncLocalStorage pattern instead of explicit
 * QueryRunner SET search_path. Tests verify that:
 * - Events without tenantId are rejected (evaluateSensorReading never called)
 * - Events with invalid UUID format are rejected
 * - requestContextStorage.run() is called with the correct schemaName
 * - AlertEvaluationService.evaluateSensorReading runs inside the context
 * - Evaluation errors are caught and do not crash the handler
 *
 * @module Alert/Tests
 */
import {
  TEST_TENANT_ID,
  TEST_TENANT_SCHEMA,
  INVALID_UUIDS,
} from '../../../../../../libs/backend-common/src/database/__tests__/nats-handler-test.helpers';

// ---------------------------------------------------------------------------
// Mock requestContextStorage BEFORE importing the handler
// (jest.mock is hoisted, so the handler import below sees the mock)
//
// We provide real implementations of isValidUUID and getTenantSchemaName
// so the handler's security validation and schema derivation work as in
// production. Only requestContextStorage is mocked so we can assert on
// the context passed to .run().
// ---------------------------------------------------------------------------
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const mockRun = jest.fn().mockImplementation((_ctx: any, fn: () => any) => fn());

// The handler imports from the subpath entrypoints
// (`@aquaculture/backend-common/logging` + `/database`), so the mocks must
// target those exact specifiers — mocking the package root would not intercept
// the subpath imports and the real requestContextStorage would run instead.
jest.mock('@aquaculture/backend-common/logging', () => ({
  requestContextStorage: { run: mockRun },
  getRequestContext: jest.fn().mockReturnValue({}),
}));

jest.mock('@aquaculture/backend-common/database', () => ({
  isValidUUID: (id: string) => UUID_V4_RE.test(id),
  getTenantSchemaName: (tenantId: string) => {
    const cleanId = tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    return `tenant_${cleanId}`;
  },
}));

import { IEventBus } from '@platform/event-bus';
import { createBaseEvent, type SensorReadingEvent } from '@platform/event-contracts';

import { AlertEvaluationService } from '../../services/alert-evaluation.service';
import { SensorReadingEventHandler } from '../sensor-reading.handler';

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------
const mockEvaluationService = {
  evaluateSensorReading: jest.fn().mockResolvedValue(undefined),
};

// WHY both `subscribe` and `subscribeWildcard` — handler.onModuleInit (after
// ORPHAN-013 migration) calls `subscribeWildcard`. `subscribe` is kept on the
// mock so the legacy code path stays exercisable if a downstream test ever
// instantiates this stub through a different code path.
const mockEventBus = {
  subscribe: jest.fn().mockResolvedValue(undefined),
  subscribeWildcard: jest.fn().mockResolvedValue(undefined),
  subscribeForTenant: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(undefined),
};

function createHandler(): SensorReadingEventHandler {
  const evaluationService: Partial<AlertEvaluationService> = mockEvaluationService;
  const eventBus: Partial<IEventBus> = mockEventBus;
  return new SensorReadingEventHandler(
    evaluationService as AlertEvaluationService,
    eventBus as IEventBus,
  );
}

/**
 * A well-formed SensorReadingEvent built through `createBaseEvent`, the only
 * producer of the branded `EventId`. `eventType` is overridable because the
 * handler's catch branches on the delivery class of the event it was handed,
 * not on a compile-time constant.
 */
function sensorReadingEvent(options: { eventId: string; eventType?: string }): SensorReadingEvent {
  const base = createBaseEvent<SensorReadingEvent>('SensorReading', TEST_TENANT_ID);
  return {
    ...base,
    eventType: (options.eventType ?? 'SensorReading') as SensorReadingEvent['eventType'],
    correlationId: options.eventId,
    sensorId: 'sensor-1',
    readingTemperature: 25,
  };
}

// ===========================================================================
// Tests
// ===========================================================================
describe('SensorReadingEventHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Skip events without tenantId
  // -------------------------------------------------------------------------
  describe('tenant isolation', () => {
    it('should skip events without tenantId', async () => {
      const handler = createHandler();

      await handler.handle({
        eventId: 'evt-1',
        eventType: 'SensorReading',
        timestamp: new Date(),
        sensorId: 'sensor-1',
        readings: { temperature: 25 },
      } as any);

      expect(mockEvaluationService.evaluateSensorReading).not.toHaveBeenCalled();
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('should skip events with null tenantId', async () => {
      const handler = createHandler();

      await handler.handle({
        eventId: 'evt-2',
        eventType: 'SensorReading',
        timestamp: new Date(),
        tenantId: null,
        sensorId: 'sensor-1',
        readings: { temperature: 25 },
      } as any);

      expect(mockEvaluationService.evaluateSensorReading).not.toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // 2. Reject events with invalid UUID format
    // -----------------------------------------------------------------------
    it.each(INVALID_UUIDS)(
      'should skip events with invalid UUID: %s ("%s")',
      async (_label, invalidId) => {
        const handler = createHandler();

        await handler.handle({
          eventId: 'evt-3',
          eventType: 'SensorReading',
          timestamp: new Date(),
          tenantId: invalidId,
          sensorId: 'sensor-1',
          readings: { temperature: 25 },
        } as any);

        expect(mockEvaluationService.evaluateSensorReading).not.toHaveBeenCalled();
      },
    );
  });

  // -------------------------------------------------------------------------
  // 3. requestContextStorage.run() with correct schemaName
  // -------------------------------------------------------------------------
  describe('AsyncLocalStorage context', () => {
    it('should call requestContextStorage.run with correct schemaName', async () => {
      const handler = createHandler();

      await handler.handle({
        eventId: 'evt-4',
        eventType: 'SensorReading',
        timestamp: new Date(),
        tenantId: TEST_TENANT_ID,
        sensorId: 'sensor-1',
        readings: { temperature: 25 },
      } as any);

      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TEST_TENANT_ID,
          schemaName: TEST_TENANT_SCHEMA,
        }),
        expect.any(Function),
      );
    });

    it('should derive lowercase schema name from uppercase UUID', async () => {
      const handler = createHandler();
      const uppercaseId = TEST_TENANT_ID.toUpperCase();

      await handler.handle({
        eventId: 'evt-5',
        eventType: 'SensorReading',
        timestamp: new Date(),
        tenantId: uppercaseId,
        sensorId: 'sensor-1',
        readings: { temperature: 25 },
      } as any);

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: uppercaseId,
          schemaName: TEST_TENANT_SCHEMA, // always lowercase
        }),
        expect.any(Function),
      );
    });

    it('should pass correlationId through to the context', async () => {
      const handler = createHandler();
      const corrId = 'corr-abc-123';

      await handler.handle({
        eventId: 'evt-6',
        eventType: 'SensorReading',
        timestamp: new Date(),
        tenantId: TEST_TENANT_ID,
        correlationId: corrId,
        sensorId: 'sensor-1',
        readings: { temperature: 25 },
      } as any);

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          correlationId: corrId,
        }),
        expect.any(Function),
      );
    });
  });

  // -------------------------------------------------------------------------
  // 4. evaluateSensorReading runs inside context
  // -------------------------------------------------------------------------
  describe('evaluation execution', () => {
    it('should call alertEvaluationService.evaluateSensorReading inside context', async () => {
      const handler = createHandler();

      await handler.handle({
        eventId: 'evt-7',
        eventType: 'SensorReading',
        timestamp: new Date(),
        tenantId: TEST_TENANT_ID,
        sensorId: 'sensor-1',
        // Readings are flat event fields (mapped via the PARAMETER_BY_READING_FIELD
        // SSoT), not a nested object — the flat-event contract per ADR-006. The
        // handler's extractor rebuilds the { temperature, ph } map the evaluation
        // service receives.
        readingTemperature: 25,
        readingPh: 7.2,
        farmId: 'farm-1',
        pondId: 'pond-1',
      } as any);

      expect(mockEvaluationService.evaluateSensorReading).toHaveBeenCalledTimes(1);
      expect(mockEvaluationService.evaluateSensorReading).toHaveBeenCalledWith(
        expect.objectContaining({
          sensorId: 'sensor-1',
          tenantId: TEST_TENANT_ID,
          readings: { temperature: 25, ph: 7.2 },
          farmId: 'farm-1',
          pondId: 'pond-1',
        }),
      );
    });

    it('should call evaluateSensorReading INSIDE requestContextStorage.run callback', async () => {
      const handler = createHandler();

      // Track whether evaluateSensorReading is called during mockRun's callback
      let evaluatedInsideRun = false;
      mockRun.mockImplementation((_ctx: any, fn: () => any) => {
        mockEvaluationService.evaluateSensorReading.mockImplementation(async () => {
          evaluatedInsideRun = true;
        });
        return fn();
      });

      await handler.handle({
        eventId: 'evt-8',
        eventType: 'SensorReading',
        timestamp: new Date(),
        tenantId: TEST_TENANT_ID,
        sensorId: 'sensor-1',
        readings: { temperature: 25 },
      } as any);

      expect(evaluatedInsideRun).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Handle evaluation errors gracefully
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('logs and acks an evaluation failure — SensorReading is classified reproducible', async () => {
      const handler = createHandler();

      mockEvaluationService.evaluateSensorReading.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );

      // The delivery class decides. FARM_SIGNAL_DELIVERY_SEMANTICS classifies
      // SensorReading as reproducible precisely because rethrowing on the
      // platform's highest-volume subject would be a redelivery storm, and the
      // next reading seconds later re-evaluates every threshold rule.
      await expect(
        handler.handle(sensorReadingEvent({ eventId: 'evt-9' })),
      ).resolves.toBeUndefined();
      expect(mockEvaluationService.evaluateSensorReading).toHaveBeenCalledTimes(1);
    });

    it('logs and acks a storage-context failure for the same reason', async () => {
      const handler = createHandler();

      mockRun.mockRejectedValueOnce(new Error('AsyncLocalStorage failure'));

      await expect(
        handler.handle(sensorReadingEvent({ eventId: 'evt-10' })),
      ).resolves.toBeUndefined();
    });

    it('rethrows when the event type IS durable-delivery class', async () => {
      const handler = createHandler();

      mockEvaluationService.evaluateSensorReading.mockRejectedValueOnce(
        new Error('DB connection lost'),
      );

      // MealMissed is one_shot in the same SSoT: nothing re-derives it, so the
      // handler must NAK for redelivery rather than ack the loss. Routing a
      // one-shot type through this handler is hypothetical today — the point is
      // that the branch is taken from the classification, not hard-coded.
      await expect(
        handler.handle(sensorReadingEvent({ eventId: 'evt-11', eventType: 'MealMissed' })),
      ).rejects.toThrow('DB connection lost');
    });
  });
});
