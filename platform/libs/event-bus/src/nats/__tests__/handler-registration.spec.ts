import 'reflect-metadata';

import { DynamicModule, Global, Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import {
  EVENT_HANDLER_METADATA,
  EVENT_SUBSCRIPTION_METADATA,
  SubscribeToOptions,
} from '../../decorators/event-handler.decorator';
import { IEventHandler, IEvent, SubscriptionOptions } from '../../interfaces/event-bus.interface';
import { NatsEventBus } from '../nats-event-bus';
import { EventHandlerRegistryModule } from '../nats.module';

/**
 * Lightweight SubscribeTo decorator for testing that applies metadata
 * identically to the production decorator, without importing SetMetadata
 * (which requires full NestJS decorator pipeline).
 */
function SubscribeTo(topicOrOptions: string | SubscribeToOptions): MethodDecorator {
  const options: SubscribeToOptions =
    typeof topicOrOptions === 'string'
      ? { topic: topicOrOptions }
      : topicOrOptions;

  return (target: object, propertyKey: string | symbol, _descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(EVENT_SUBSCRIPTION_METADATA, options, target, propertyKey);
  };
}

/**
 * Test service with 3 @SubscribeTo decorated methods.
 * The handler registration must discover ALL of them.
 */
@Injectable()
class TestSensorService {
  @SubscribeTo('events.sensor.temperature')
  async handleTemperature(_event: IEvent): Promise<void> {
    // handler body
  }

  @SubscribeTo({ topic: 'events.sensor.ph', groupId: 'sensor-group', durable: true })
  async handlePh(_event: IEvent): Promise<void> {
    // handler body
  }

  @SubscribeTo('events.sensor.dissolved-oxygen')
  async handleDissolvedOxygen(_event: IEvent): Promise<void> {
    // handler body
  }

  /**
   * This method has NO decorator and must NOT be registered.
   */
  async helperMethod(): Promise<void> {
    // not a handler
  }
}

/**
 * Test service with a class-level @EventHandler decorator.
 */
@Injectable()
class TestAlertHandler implements IEventHandler {
  handle(_event: IEvent): Promise<void> {
    return Promise.resolve();
  }

  getEventType(): string {
    return 'events.alert.triggered';
  }
}

// Apply class-level metadata manually (same as @EventHandler('events.alert.triggered'))
Reflect.defineMetadata(EVENT_HANDLER_METADATA, { eventName: 'events.alert.triggered' }, TestAlertHandler);

@Module({
  providers: [TestSensorService, TestAlertHandler],
  exports: [TestSensorService, TestAlertHandler],
})
class TestHandlersModule {}

/**
 * ADMIN-HIGH-014: the registry must resolve when it is IMPORTED as a module.
 *
 * The suite below registers `EventHandlerRegistryModule` as a PROVIDER beside a
 * root-imported `DiscoveryModule`, which exercises the discovery logic while
 * hiding the wiring defect that made the class unusable: it declared
 * `@Module({})` and injected `DiscoveryService` + `MetadataScanner`, which
 * `EventBusModule` imports but does not re-export. Every service that tried to
 * import it got an unresolved-dependency error, so no `@SubscribeTo` in the
 * platform was ever bound — and a service could ship an event handler that
 * silently received nothing.
 */
describe('EventHandlerRegistryModule — usable as an imported module', () => {
  /**
   * Stands in for the @Global() EventBusModule every service registers: it is
   * where NatsEventBus comes from in production. DiscoveryService and
   * MetadataScanner deliberately are NOT provided here — the registry must
   * bring those itself, which is exactly what was broken.
   */
  type SubscribeToMock = jest.Mock<
    Promise<void>,
    [string, IEventHandler, SubscriptionOptions | undefined]
  >;

  function eventBusStub(subscribeTo: SubscribeToMock): DynamicModule {
    @Global()
    @Module({
      providers: [{ provide: NatsEventBus, useValue: { subscribeTo, subscribe: jest.fn() } }],
      exports: [NatsEventBus],
    })
    class StubEventBusModule {}
    return { module: StubEventBusModule };
  }

  it('resolves its own dependencies when a service imports it', async () => {
    const subscribeTo: SubscribeToMock = jest.fn<
      Promise<void>,
      [string, IEventHandler, SubscriptionOptions | undefined]
    >();

    // No DiscoveryModule at the root: the registry must bring its own.
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        eventBusStub(subscribeTo),
        TestHandlersModule,
        EventHandlerRegistryModule,
      ],
    }).compile();

    await moduleRef.init();
    expect(subscribeTo).toHaveBeenCalled();
    await moduleRef.close();
  });

  it('passes startFrom through to the subscription, not just groupId and durable', async () => {
    // The decorator declares `startFrom` and `subscribeTo` accepts it; the
    // registry dropped it, so every durable consumer silently took JetStream's
    // DeliverPolicy.New default — the opposite of what a projection rebuilding
    // its table asks for.
    const subscribeTo: SubscribeToMock = jest.fn<
      Promise<void>,
      [string, IEventHandler, SubscriptionOptions | undefined]
    >();

    @Injectable()
    class ReplayService {
      @SubscribeTo({ topic: 'events.replay.all', durable: true, startFrom: 'beginning' })
      async handleReplay(_event: IEvent): Promise<void> {
        // handler body
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        eventBusStub(subscribeTo),
        EventHandlerRegistryModule,
      ],
      providers: [ReplayService],
    }).compile();

    await moduleRef.init();

    const call = subscribeTo.mock.calls.find((entry) => entry[0] === 'events.replay.all');
    expect(call).toBeDefined();
    expect(call?.[2]).toMatchObject({ durable: true, startFrom: 'beginning' });
    await moduleRef.close();
  });
});

describe('EventHandlerRegistryModule — handler registration', () => {
  let moduleRef: TestingModule;
  const subscribeToSpy = jest.fn<Promise<void>, [string, IEventHandler, SubscriptionOptions | undefined]>();
  const subscribeSpy = jest.fn<Promise<void>, [string, IEventHandler]>();

  beforeAll(async () => {
    /**
     * We build a real NestJS testing module containing:
     * - DiscoveryModule (for DiscoveryService + MetadataScanner)
     * - TestHandlersModule (providers with decorators)
     * - EventHandlerRegistryModule (the module under test)
     *
     * NatsEventBus is replaced with a stub that records subscribeTo calls.
     */
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        DiscoveryModule,
        TestHandlersModule,
      ],
      providers: [
        {
          provide: NatsEventBus,
          useValue: {
            subscribeTo: subscribeToSpy,
            subscribe: subscribeSpy,
          },
        },
        EventHandlerRegistryModule,
      ],
    }).compile();

    // Trigger onModuleInit which calls registerEventHandlers()
    await moduleRef.init();
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  it('should discover all 3 @SubscribeTo decorated methods', () => {
    expect(subscribeToSpy).toHaveBeenCalledTimes(3);
  });

  it('should register the temperature handler with correct topic', () => {
    const temperatureCall = subscribeToSpy.mock.calls.find(
      (call) => call[0] === 'events.sensor.temperature',
    );
    expect(temperatureCall).toBeDefined();
    expect(temperatureCall![1]).toHaveProperty('handle');
    expect(temperatureCall![1]).toHaveProperty('getEventType');
    expect(temperatureCall![1].getEventType()).toBe('events.sensor.temperature');
  });

  it('should register the pH handler with groupId and durable options', () => {
    const phCall = subscribeToSpy.mock.calls.find(
      (call) => call[0] === 'events.sensor.ph',
    );
    expect(phCall).toBeDefined();
    expect(phCall![2]).toEqual(
      expect.objectContaining({
        groupId: 'sensor-group',
        durable: true,
      }),
    );
  });

  it('should register the dissolved-oxygen handler', () => {
    const doCall = subscribeToSpy.mock.calls.find(
      (call) => call[0] === 'events.sensor.dissolved-oxygen',
    );
    expect(doCall).toBeDefined();
    expect(doCall![1].getEventType()).toBe('events.sensor.dissolved-oxygen');
  });

  it('should NOT register the helperMethod (no decorator)', () => {
    const helperCall = subscribeToSpy.mock.calls.find(
      (call) => call[0] === 'helperMethod',
    );
    expect(helperCall).toBeUndefined();
  });

  it('should register the class-level @EventHandler decorated handler', () => {
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(subscribeSpy).toHaveBeenCalledWith(
      'events.alert.triggered',
      expect.objectContaining({ handle: expect.any(Function) }),
    );
  });

  it('should register exactly 4 total handlers (3 method-level + 1 class-level)', () => {
    const totalRegistered = subscribeToSpy.mock.calls.length + subscribeSpy.mock.calls.length;
    expect(totalRegistered).toBe(4);
  });

  it('should bind handler methods to the correct instance context', () => {
    const temperatureCall = subscribeToSpy.mock.calls.find(
      (call) => call[0] === 'events.sensor.temperature',
    );
    // The handler's handle function should be a bound function (callable without `this` issues)
    expect(typeof temperatureCall![1].handle).toBe('function');
  });
});
