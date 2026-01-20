import { Module, DynamicModule, Global, Provider } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { NatsEventBus } from './nats-event-bus';
import {
  EVENT_HANDLER_METADATA,
  EVENT_SUBSCRIPTION_METADATA,
} from '../decorators/event-handler.decorator';

/**
 * Event Bus Module configuration options
 */
export interface EventBusModuleOptions {
  /**
   * Connection URL for NATS server
   */
  url?: string;

  /**
   * Stream name for JetStream
   */
  streamName?: string;

  /**
   * Client identifier
   */
  clientId?: string;

  /**
   * Enable auto-discovery of event handlers
   */
  autoDiscovery?: boolean;
}

/**
 * Event Bus Module - Provides NATS JetStream event bus
 * Enterprise-grade event-driven architecture for microservices
 */
@Global()
@Module({})
export class EventBusModule {
  /**
   * Register the module with default configuration
   */
  static forRoot(options?: EventBusModuleOptions): DynamicModule {
    const providers: Provider[] = [
      {
        provide: 'EVENT_BUS_OPTIONS',
        useValue: options ?? {},
      },
      {
        provide: 'EVENT_BUS',
        useClass: NatsEventBus,
      },
      NatsEventBus,
    ];

    return {
      module: EventBusModule,
      imports: [ConfigModule, DiscoveryModule],
      providers,
      exports: ['EVENT_BUS', NatsEventBus],
    };
  }

  /**
   * Register the module with async configuration
   */
  static forRootAsync(options: {
    imports?: any[];
    useFactory: (
      ...args: any[]
    ) => Promise<EventBusModuleOptions> | EventBusModuleOptions;
    inject?: any[];
  }): DynamicModule {
    const providers: Provider[] = [
      {
        provide: 'EVENT_BUS_OPTIONS',
        useFactory: options.useFactory,
        inject: options.inject ?? [],
      },
      {
        provide: 'EVENT_BUS',
        useClass: NatsEventBus,
      },
      NatsEventBus,
    ];

    return {
      module: EventBusModule,
      imports: [ConfigModule, DiscoveryModule, ...(options.imports ?? [])],
      providers,
      exports: ['EVENT_BUS', NatsEventBus],
    };
  }
}

/**
 * Event Handler Registry - Auto-discovers and registers event handlers
 */
@Global()
@Module({})
export class EventHandlerRegistryModule {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly eventBus: NatsEventBus,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.registerEventHandlers();
  }

  private async registerEventHandlers(): Promise<void> {
    const providers = this.discovery.getProviders();

    for (const wrapper of providers) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) {
        continue;
      }

      // Check for class-level @EventHandler decorator
      const handlerMetadata = Reflect.getMetadata(
        EVENT_HANDLER_METADATA,
        metatype,
      );

      if (handlerMetadata && typeof instance.handle === 'function') {
        await this.eventBus.subscribe(handlerMetadata.eventName, instance);
      }

      // Check for method-level @SubscribeTo decorators
      this.metadataScanner.scanFromPrototype(
        instance,
        Object.getPrototypeOf(instance),
        (methodKey) => {
          const subscriptionMetadata = Reflect.getMetadata(
            EVENT_SUBSCRIPTION_METADATA,
            instance,
            methodKey,
          );

          if (subscriptionMetadata) {
            const handler = {
              handle: instance[methodKey].bind(instance),
              getEventType: () => subscriptionMetadata.topic,
            };

            this.eventBus.subscribeTo(subscriptionMetadata.topic, handler, {
              groupId: subscriptionMetadata.groupId,
              durable: subscriptionMetadata.durable,
            });
          }
        },
      );
    }
  }
}
