import { DeliverPolicy } from '@nats-io/jetstream';
import { ConfigService } from '@nestjs/config';

import type { IEvent, IEventHandler } from '../../interfaces/event-bus.interface';
import { NatsEventBus } from '../nats-event-bus';

function config(): ConfigService {
  return new ConfigService({
    NATS_STREAM_NAME: 'AQUACULTURE_EVENTS',
    SERVICE_NAME: 'farm-service',
  });
}

function harness(): {
  readonly bus: NatsEventBus;
  readonly add: jest.Mock;
  readonly stop: jest.Mock;
} {
  const add = jest.fn().mockResolvedValue(undefined);
  const stop = jest.fn();
  const consumer = {
    consume: jest.fn().mockResolvedValue({ stop }),
  };
  const jetStream = {
    consumers: { get: jest.fn().mockResolvedValue(consumer) },
  };
  const jetStreamManager = {
    consumers: { add },
  };
  const bus = new NatsEventBus(config());
  Reflect.set(bus, 'jetStream', jetStream);
  Reflect.set(bus, 'jetStreamManager', jetStreamManager);
  Reflect.set(bus, 'streamReady', true);
  return { bus, add, stop };
}

function handler(): IEventHandler<IEvent> {
  return {
    getEventType: () => 'TenantErasureRequested',
    handle: jest.fn().mockResolvedValue(undefined),
  };
}

describe('NatsEventBus compliance subscription policy', () => {
  it('uses full replay and unlimited redelivery for a durable erasure request consumer', async () => {
    const { bus, add, stop } = harness();
    const eventHandler = handler();

    await bus.subscribeWildcard('TenantErasureRequested', eventHandler, {
      durable: true,
      consumerVersion: 'tenant-erasure-v2',
      startFrom: 'beginning',
      ackWait: 60,
      maxRetries: -1,
    });

    expect(add).toHaveBeenCalledWith(
      'AQUACULTURE_EVENTS',
      expect.objectContaining({
        durable_name: 'aquaculture-farm-service-events---TenantErasureRequested-tenant-erasure-v2',
        deliver_policy: DeliverPolicy.All,
        ack_wait: 60_000_000_000,
        max_deliver: -1,
        filter_subject: 'events.*.TenantErasureRequested',
      }),
    );

    await Promise.resolve();
    await bus.unsubscribeFrom('events.*.TenantErasureRequested');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy durable name when no consumer version is requested', async () => {
    const { bus, add } = harness();

    await bus.subscribeWildcard('TenantErasureRequested', handler());

    expect(add).toHaveBeenCalledWith(
      'AQUACULTURE_EVENTS',
      expect.objectContaining({
        durable_name: 'aquaculture-farm-service-events---TenantErasureRequested',
        deliver_policy: DeliverPolicy.New,
      }),
    );
    await bus.unsubscribeFrom('events.*.TenantErasureRequested');
  });

  it('rejects an unsafe consumer version before registering the subscription', async () => {
    const { bus, add } = harness();

    await expect(
      bus.subscribeWildcard('TenantErasureRequested', handler(), {
        consumerVersion: '../shared',
        startFrom: 'beginning',
      }),
    ).rejects.toThrow('consumerVersion must match');
    expect(add).not.toHaveBeenCalled();
  });
});
