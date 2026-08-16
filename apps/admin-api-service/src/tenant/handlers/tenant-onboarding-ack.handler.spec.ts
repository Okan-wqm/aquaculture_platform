import { requireServiceNatsRuntimeProfile } from '@aquaculture/backend-common/nats';
import type { IEvent, IEventBus, IEventHandler, SubscriptionOptions } from '@platform/event-bus';
import {
  createBaseEvent,
  type TenantOnboardingAckEvent,
  type TenantOnboardingFailedEvent,
} from '@platform/event-contracts';
import type { DataSource } from 'typeorm';

import { TenantOnboardingAckHandler } from './tenant-onboarding-ack.handler';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';

describe('TenantOnboardingAckHandler', () => {
  const registeredHandlers = new Map<string, IEventHandler<IEvent>>();
  const registeredOptions = new Map<string, SubscriptionOptions | undefined>();
  const query = jest.fn().mockResolvedValue([{ disposition: 'ADMITTED' }]);

  const eventBus: Pick<IEventBus, 'subscribeWildcard'> = {
    subscribeWildcard: async <TEvent extends IEvent>(
      eventType: string,
      handler: IEventHandler<TEvent>,
      options?: SubscriptionOptions,
    ): Promise<void> => {
      registeredHandlers.set(eventType, {
        getEventType: handler.getEventType,
        handle: (event) => handler.handle(event as TEvent),
      });
      registeredOptions.set(eventType, options);
    },
  };

  const dataSource = { query } as Pick<DataSource, 'query'> as DataSource;

  beforeEach(() => {
    registeredHandlers.clear();
    registeredOptions.clear();
    query.mockClear();
    query.mockResolvedValue([{ disposition: 'ADMITTED' }]);
  });

  it('resolves the catalog handler symbol and registers its exact derived event set', async () => {
    const handler = new TenantOnboardingAckHandler(eventBus, dataSource);
    const profile = requireServiceNatsRuntimeProfile('admin-api-service');

    await handler.onModuleInit();

    expect(TenantOnboardingAckHandler.name).toBe(profile.handlerSymbol);
    expect([...registeredHandlers.keys()].sort()).toEqual(
      profile.subscriptions.map(({ eventType }) => eventType).sort(),
    );
    for (const subscription of profile.subscriptions) {
      expect(registeredOptions.get(subscription.eventType)).toEqual({
        consumerVersion: subscription.consumerVersion,
        durable: true,
      });
    }
  });

  it('validates ACK at the trust boundary and writes the monotonic conflict rule', async () => {
    const handler = new TenantOnboardingAckHandler(eventBus, dataSource);
    await handler.onModuleInit();
    const event: TenantOnboardingAckEvent = {
      ...createBaseEvent<TenantOnboardingAckEvent>('TenantOnboardingAck', TENANT_ID),
      operationId: OPERATION_ID,
      generation: 1,
      service: 'farm-service',
      acknowledgedAt: '2026-08-08T12:00:01.000Z',
    };

    await registeredHandlers.get('TenantOnboardingAck')?.handle(event);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('admin.admit_tenant_onboarding_outcome');
    expect(parameters).toEqual([
      OPERATION_ID,
      TENANT_ID,
      1,
      'farm-service',
      'ACK',
      null,
      event.acknowledgedAt,
    ]);
  });

  it('records FAILED with the event timestamp and error', async () => {
    const handler = new TenantOnboardingAckHandler(eventBus, dataSource);
    await handler.onModuleInit();
    const event: TenantOnboardingFailedEvent = {
      ...createBaseEvent<TenantOnboardingFailedEvent>('TenantOnboardingFailed', TENANT_ID),
      operationId: OPERATION_ID,
      generation: 1,
      service: 'farm-service',
      error: 'projection failed',
    };

    await registeredHandlers.get('TenantOnboardingFailed')?.handle(event);

    const [, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(parameters).toEqual([
      OPERATION_ID,
      TENANT_ID,
      1,
      'farm-service',
      'FAILED',
      'projection failed',
      event.timestamp,
    ]);
  });

  it('rejects schema-invalid and producer-forged events before persistence', async () => {
    const handler = new TenantOnboardingAckHandler(eventBus, dataSource);
    await handler.onModuleInit();
    const ackHandler = registeredHandlers.get('TenantOnboardingAck');
    if (!ackHandler) {
      throw new Error('ACK handler was not registered');
    }

    const valid: TenantOnboardingAckEvent = {
      ...createBaseEvent<TenantOnboardingAckEvent>('TenantOnboardingAck', TENANT_ID),
      operationId: OPERATION_ID,
      generation: 1,
      service: 'farm-service',
      acknowledgedAt: '2026-08-08T12:00:01.000Z',
    };
    const missingTimestamp = { ...valid, acknowledgedAt: 'not-an-iso-date' };
    const forgedProducer = { ...valid, service: 'billing-service' };

    await expect(ackHandler.handle(missingTimestamp)).rejects.toThrow('failed its governed schema');
    await expect(ackHandler.handle(forgedProducer)).rejects.toThrow(
      'does not equal its governed producer',
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a contradictory second terminal outcome after the database safety-fails it', async () => {
    const handler = new TenantOnboardingAckHandler(eventBus, dataSource);
    await handler.onModuleInit();
    query.mockResolvedValueOnce([{ disposition: 'SAFETY_FAILED' }]);
    const ackHandler = registeredHandlers.get('TenantOnboardingAck');
    if (!ackHandler) {
      throw new Error('ACK handler was not registered');
    }
    const event: TenantOnboardingAckEvent = {
      ...createBaseEvent<TenantOnboardingAckEvent>('TenantOnboardingAck', TENANT_ID),
      operationId: OPERATION_ID,
      generation: 1,
      service: 'farm-service',
      acknowledgedAt: '2026-08-08T12:00:01.000Z',
    };

    await expect(ackHandler.handle(event)).rejects.toThrow('contradicts the immutable terminal');
  });

  it('accepts canonical-identical redelivery without writing a second outcome', async () => {
    const handler = new TenantOnboardingAckHandler(eventBus, dataSource);
    await handler.onModuleInit();
    query.mockResolvedValueOnce([{ disposition: 'DUPLICATE' }]);
    const event: TenantOnboardingAckEvent = {
      ...createBaseEvent<TenantOnboardingAckEvent>('TenantOnboardingAck', TENANT_ID),
      operationId: OPERATION_ID,
      generation: 4,
      service: 'farm-service',
      acknowledgedAt: '2026-08-08T12:00:01.000Z',
    };

    await expect(registeredHandlers.get('TenantOnboardingAck')?.handle(event)).resolves.toBe(
      undefined,
    );
  });
});
