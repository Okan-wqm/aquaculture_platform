import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';

import { EventHandler, SubscribeTo } from '../../decorators/event-handler.decorator';
import type {
  IEvent,
  IEventHandler,
  SubscriptionOptions,
} from '../../interfaces/event-bus.interface';
import { NatsEventBus } from '../nats-event-bus';
import { EventHandlerRegistryModule } from '../nats.module';

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
@EventHandler('events.alert.triggered')
class TestAlertHandler implements IEventHandler {
  handle(_event: IEvent): Promise<void> {
    return Promise.resolve();
  }

  getEventType(): string {
    return 'events.alert.triggered';
  }
}

@Module({
  providers: [TestSensorService, TestAlertHandler],
  exports: [TestSensorService, TestAlertHandler],
})
class TestHandlersModule {}

describe('EventHandlerRegistryModule — handler registration', () => {
  type SubscribeToCall = [string, IEventHandler, SubscriptionOptions | undefined];

  let moduleRef: TestingModule | undefined;
  const subscribeToSpy = jest.fn<Promise<void>, SubscribeToCall>();
  const subscribeSpy = jest.fn<Promise<void>, [string, IEventHandler]>();

  function findSubscription(topic: string): SubscribeToCall {
    const call = subscribeToSpy.mock.calls.find((candidate) => candidate[0] === topic);
    if (!call) {
      throw new Error(`Expected subscription for ${topic}`);
    }
    return call;
  }

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
    if (moduleRef) {
      await moduleRef.close();
    }
  });

  it('should discover all 3 @SubscribeTo decorated methods', () => {
    expect(subscribeToSpy).toHaveBeenCalledTimes(3);
  });

  it('should register the temperature handler with correct topic', () => {
    const temperatureCall = findSubscription('events.sensor.temperature');
    expect(temperatureCall[1]).toHaveProperty('handle');
    expect(temperatureCall[1]).toHaveProperty('getEventType');
    expect(temperatureCall[1].getEventType()).toBe('events.sensor.temperature');
  });

  it('should register the pH handler with groupId and durable options', () => {
    const phCall = findSubscription('events.sensor.ph');
    expect(phCall[2]).toEqual(
      expect.objectContaining({
        groupId: 'sensor-group',
        durable: true,
      }),
    );
  });

  it('should register the dissolved-oxygen handler', () => {
    const doCall = findSubscription('events.sensor.dissolved-oxygen');
    expect(doCall[1].getEventType()).toBe('events.sensor.dissolved-oxygen');
  });

  it('should NOT register the helperMethod (no decorator)', () => {
    const helperCall = subscribeToSpy.mock.calls.find(
      (call) => call[0] === 'helperMethod',
    );
    expect(helperCall).toBeUndefined();
  });

  it('should register the class-level @EventHandler decorated handler', () => {
    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    const call = subscribeSpy.mock.calls.at(0);
    if (!call) {
      throw new Error('Expected class-level event-handler subscription');
    }
    expect(call[0]).toBe('events.alert.triggered');
    expect(typeof call[1].handle).toBe('function');
  });

  it('should register exactly 4 total handlers (3 method-level + 1 class-level)', () => {
    const totalRegistered = subscribeToSpy.mock.calls.length + subscribeSpy.mock.calls.length;
    expect(totalRegistered).toBe(4);
  });

  it('should bind handler methods to the correct instance context', () => {
    const temperatureCall = findSubscription('events.sensor.temperature');
    // The handler's handle function should be a bound function (callable without `this` issues)
    expect(typeof temperatureCall[1].handle).toBe('function');
  });
});
