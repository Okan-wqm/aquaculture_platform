/**
 * HarvestRegulatoryRecordedEventHandler unit specs
 *
 * Proves the notification-service REAL consumer for the farm-raised
 * `HarvestRegulatoryRecorded` follow-up (dead-listeners produce-side cure,
 * blocker 4): the event creates an in-app traceability confirmation for the
 * operator who performed the harvest, instead of a dead in-process emit.
 */
import { createBaseEvent } from '@platform/event-contracts';
import type { IEventBus } from '@platform/event-bus';
import type { HarvestRegulatoryRecordedEvent } from '@platform/event-contracts';

import { InAppNotificationService } from '../../services/in-app.service';
import { HarvestRegulatoryRecordedEventHandler } from '../harvest-regulatory.handler';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const BATCH_ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR = 'operator-1';

type InAppDouble = jest.Mocked<Pick<InAppNotificationService, 'createNotification'>>;
type BusDouble = jest.Mocked<Pick<IEventBus, 'subscribeWildcard'>>;

function makeEvent(
  overrides: Partial<HarvestRegulatoryRecordedEvent> = {},
): HarvestRegulatoryRecordedEvent {
  return {
    ...createBaseEvent<HarvestRegulatoryRecordedEvent>('HarvestRegulatoryRecorded', TENANT_ID, {
      aggregateId: BATCH_ID,
      aggregateType: 'Batch',
    }),
    eventType: 'HarvestRegulatoryRecorded',
    batchId: BATCH_ID,
    harvestedQuantity: 200,
    totalWeight: 90,
    averageWeight: 450,
    harvestedAt: '2026-06-10T08:00:00.000Z',
    harvestedBy: OPERATOR,
    isFinal: false,
    ...overrides,
  };
}

function makeHandler(): {
  handler: HarvestRegulatoryRecordedEventHandler;
  inApp: InAppDouble;
  bus: BusDouble;
} {
  const inApp: InAppDouble = {
    createNotification: jest.fn().mockResolvedValue({ id: 'log-1' }),
  };
  const bus: BusDouble = { subscribeWildcard: jest.fn().mockResolvedValue(undefined) };
  // The handler's deps are narrowed to the exact methods used, so the doubles
  // slot in with NO cast.
  const handler = new HarvestRegulatoryRecordedEventHandler(inApp, bus);
  return { handler, inApp, bus };
}

describe('HarvestRegulatoryRecordedEventHandler', () => {
  it('subscribes to the HarvestRegulatoryRecorded subject on init', async () => {
    const { handler, bus } = makeHandler();
    await handler.onModuleInit();
    expect(bus.subscribeWildcard).toHaveBeenCalledWith('HarvestRegulatoryRecorded', handler);
    expect(handler.getEventType()).toBe('HarvestRegulatoryRecorded');
  });

  it('creates an in-app traceability notification for the harvesting operator', async () => {
    const { handler, inApp } = makeHandler();

    await handler.handle(makeEvent({ isFinal: true }));

    expect(inApp.createNotification).toHaveBeenCalledTimes(1);
    const [tenantId, userId, title, , data] = inApp.createNotification.mock.calls[0] ?? [];
    expect(tenantId).toBe(TENANT_ID);
    expect(userId).toBe(OPERATOR);
    expect(title).toContain('final');
    expect(data).toMatchObject({
      type: 'HarvestRegulatoryRecorded',
      batchId: BATCH_ID,
      isFinal: true,
    });
  });

  it('rejects an event with an invalid tenantId without notifying', async () => {
    const { handler, inApp } = makeHandler();
    await handler.handle(makeEvent({ tenantId: 'not-a-uuid' }));
    expect(inApp.createNotification).not.toHaveBeenCalled();
  });

  it('skips when there is no harvestedBy recipient', async () => {
    const { handler, inApp } = makeHandler();
    await handler.handle(makeEvent({ harvestedBy: undefined }));
    expect(inApp.createNotification).not.toHaveBeenCalled();
  });

  it('reports a downstream failure as a retry outcome (the bus owns redelivery and dead-lettering)', async () => {
    const { handler, inApp } = makeHandler();
    inApp.createNotification.mockRejectedValueOnce(new Error('db down'));
    await expect(handler.handle(makeEvent())).resolves.toEqual(
      expect.objectContaining({ kind: 'retry' }),
    );
  });
});
