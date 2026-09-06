/**
 * WaterQualityCriticalEventHandler — NATS handler tenant-isolation specs
 * (FARM-MEDIUM-118).
 *
 * Verifies the consumer contract mirrored from MortalityAlertEventHandler:
 * - onModuleInit subscribes via the cross-tenant wildcard
 * - events with missing/invalid tenantId are rejected before any write
 * - the per-tenant AsyncLocalStorage context carries the derived schemaName
 * - service errors are RETHROWN: `WaterQualityCritical` is a one-shot signal
 *   (W7 / FARM-MEDIUM-260), so the message must reach the platform dead-letter stream (AQUACULTURE_DLQ)
 *   rather than being dropped
 */

// Mock the logging subpath BEFORE importing the handler so the context spy is
// in place; the database subpath (isValidUUID/getTenantSchemaName) stays REAL
// so the security validation + schema derivation behave as in production.
const mockRun = jest.fn((_context: unknown, fn: () => Promise<void>): Promise<void> => fn());

jest.mock('@aquaculture/backend-common/logging', () => ({
  requestContextStorage: { run: mockRun },
}));

import { createBaseEvent } from '@platform/event-contracts';
import type { WaterQualityCriticalEvent } from '@platform/event-contracts';
import type { IEventBus } from '@platform/event-bus';

import { WaterQualityCriticalEventHandler } from '../water-quality-critical.handler';
import { WaterQualityCriticalAlertService } from '../../services/water-quality-critical-alert.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function makeEvent(tenantId: string): WaterQualityCriticalEvent {
  return {
    ...createBaseEvent<WaterQualityCriticalEvent>('WaterQualityCritical', tenantId),
    tenantId,
    eventType: 'WaterQualityCritical',
    measurementId: 'meas-1',
    equipmentId: null,
    tankId: 'tank-1',
    criticalParametersJson: '[]',
    criticalParameterCount: 1,
    measuredAt: '2026-06-10T08:00:00.000Z',
  };
}

type ServiceDouble = jest.Mocked<
  Pick<WaterQualityCriticalAlertService, 'recordCriticalWaterQuality'>
>;
type EventBusDouble = jest.Mocked<Pick<IEventBus, 'subscribeWildcard'>>;

function makeHandler(): {
  handler: WaterQualityCriticalEventHandler;
  service: ServiceDouble;
  eventBus: EventBusDouble;
} {
  const service: ServiceDouble = {
    recordCriticalWaterQuality: jest.fn().mockResolvedValue(undefined),
  };
  const eventBus: EventBusDouble = {
    subscribeWildcard: jest.fn().mockResolvedValue(undefined),
  };
  // The handler's constructor params are narrowed to Pick<…>, so the doubles
  // slot in with NO cast.
  const handler = new WaterQualityCriticalEventHandler(service, eventBus);
  return { handler, service, eventBus };
}

describe('WaterQualityCriticalEventHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('subscribes to the cross-tenant wildcard on module init', async () => {
    const { handler, eventBus } = makeHandler();

    await handler.onModuleInit();

    expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('WaterQualityCritical', handler);
    expect(handler.getEventType()).toBe('WaterQualityCritical');
  });

  it('rejects an event with an invalid tenantId before any write', async () => {
    const { handler, service } = makeHandler();

    await handler.handle(makeEvent('tenant_1; DROP SCHEMA public'));

    expect(service.recordCriticalWaterQuality).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs the service inside the derived per-tenant schema context', async () => {
    const { handler, service } = makeHandler();
    const event = makeEvent(TENANT_ID);

    await handler.handle(event);

    expect(mockRun).toHaveBeenCalledTimes(1);
    const context = mockRun.mock.calls[0]?.[0] as {
      tenantId: string;
      schemaName: string;
    };
    expect(context.tenantId).toBe(TENANT_ID);
    expect(context.schemaName).toBe(`tenant_${TENANT_ID.replace(/-/g, '').substring(0, 16)}`);
    expect(service.recordCriticalWaterQuality).toHaveBeenCalledWith(event);
  });

  /**
   * W7 / FARM-MEDIUM-260 + PLAT-HIGH-902 — the OPPOSITE of the behaviour this
   * spec used to pin, expressed as a value rather than a throw.
   *
   * `WaterQualityCritical` is classified `one_shot`: farm emits it per critical
   * measurement, at write time, and no sweep re-raises it. Swallowing a handler
   * error therefore deleted a life-safety signal outright. The handler now
   * returns a `retry` outcome, so the bus NAKs, backs off, and shelves the
   * message in the platform dead-letter stream when the budget is spent — the
   * same delivery the rethrow bought, minus the ambiguity of an exception that
   * could also mean "the handler itself is broken".
   */
  it('reports a service failure as a retry outcome so the one-shot signal reaches the dead-letter shelf', async () => {
    const { handler, service } = makeHandler();
    service.recordCriticalWaterQuality.mockRejectedValueOnce(new Error('db down'));

    await expect(handler.handle(makeEvent(TENANT_ID))).resolves.toEqual(
      expect.objectContaining({ kind: 'retry' }),
    );
  });
});
