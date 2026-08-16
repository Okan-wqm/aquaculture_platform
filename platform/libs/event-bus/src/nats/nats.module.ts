import {
  DynamicModule,
  Global,
  InjectionToken,
  Logger,
  Module,
  OptionalFactoryDependency,
  Provider,
  Type,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { createDefaultRegistry } from '@platform/event-contracts';

import {
  getEventHandlerMetadata,
  getSubscriptionMetadata,
} from '../decorators/event-handler.decorator';
import type { IEvent, IEventHandler } from '../interfaces/event-bus.interface';

import { NatsEventBus } from './nats-event-bus';
import { NatsRequestReply } from './nats-request-reply';

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

  /**
   * When true, NATS broker availability is a hard startup dependency.
   * Module init will throw if the broker is unreachable, preventing the
   * service from booting in a degraded state.
   *
   * When false (default), non-production environments will start without
   * a broker and attempt background reconnection.
   *
   * Production environments ALWAYS fail closed regardless of this flag.
   *
   * @default false
   */
  required?: boolean;
}

/**
 * Typed async bootstrap contract for the transport module.
 *
 * Factory argument types are carried from the caller instead of widening the
 * dependency injection boundary to `any[]`. This keeps Nest's dynamic module
 * surface explicit while preserving ordinary token-based injection.
 */
export interface EventBusModuleAsyncOptions<
  TFactoryArgs extends unknown[] = unknown[],
> {
  imports?: Array<Type | DynamicModule | Promise<DynamicModule>>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (
    ...args: TFactoryArgs
  ) => Promise<EventBusModuleOptions> | EventBusModuleOptions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isEventHandler(value: unknown): value is IEventHandler {
  return (
    isRecord(value) &&
    typeof value['handle'] === 'function' &&
    typeof value['getEventType'] === 'function'
  );
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
        provide: 'EVENT_UPCASTER_REGISTRY',
        useFactory: () => createDefaultRegistry(),
      },
      NatsEventBus,
      {
        provide: 'EVENT_BUS',
        useExisting: NatsEventBus,
      },
      // ADR-031: NatsRequestReply depends on NatsEventBus for the
      // raw connection so ONE mTLS handshake covers every caller.
      NatsRequestReply,
    ];

    return {
      module: EventBusModule,
      imports: [ConfigModule, DiscoveryModule],
      providers,
      exports: [
        'EVENT_BUS',
        'EVENT_UPCASTER_REGISTRY',
        NatsEventBus,
        NatsRequestReply,
      ],
    };
  }

  /**
   * Register the module with async configuration
   */
  static forRootAsync<TFactoryArgs extends unknown[] = unknown[]>(
    options: EventBusModuleAsyncOptions<TFactoryArgs>,
  ): DynamicModule {
    const providers: Provider[] = [
      {
        provide: 'EVENT_BUS_OPTIONS',
        useFactory: (...args: TFactoryArgs) => options.useFactory(...args),
        inject: options.inject ?? [],
      },
      {
        provide: 'EVENT_UPCASTER_REGISTRY',
        useFactory: () => createDefaultRegistry(),
      },
      NatsEventBus,
      {
        provide: 'EVENT_BUS',
        useExisting: NatsEventBus,
      },
      // ADR-031 — see forRoot for the shared-connection rationale.
      NatsRequestReply,
    ];

    return {
      module: EventBusModule,
      imports: [ConfigModule, DiscoveryModule, ...(options.imports ?? [])],
      providers,
      exports: [
        'EVENT_BUS',
        'EVENT_UPCASTER_REGISTRY',
        NatsEventBus,
        NatsRequestReply,
      ],
    };
  }
}

/**
 * Event Handler Registry - Auto-discovers and registers event handlers
 *
 * IMPORTANT: fail-closed — all subscription registrations are awaited.
 * If any registration fails, the entire module init fails, preventing
 * the service from booting with missing event handlers.
 */
@Global()
@Module({})
export class EventHandlerRegistryModule {
  private readonly logger = new Logger(EventHandlerRegistryModule.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
    private readonly eventBus: NatsEventBus,
  ) {}

  /** @throws {Error} If any subscription registration fails */
  async onModuleInit(): Promise<void> {
    await this.registerEventHandlers();
  }

  /**
   * Register all discovered event handlers.
   *
   * IMPORTANT: fail-closed — every subscription is awaited.  Errors are
   * collected across all providers so that the boot log shows ALL failures,
   * not just the first one.  After the loop a single combined error is thrown
   * to prevent the service from starting with partial subscriptions.
   *
   * @throws {Error} Aggregated error listing every failed subscription
   */
  private async registerEventHandlers(): Promise<void> {
    const providers = this.discovery.getProviders();
    const failures: Array<{ subject: string; error: Error }> = [];

    for (const wrapper of providers) {
      const instance: unknown = wrapper.instance;
      if (!isRecord(instance)) {
        continue;
      }

      // ── Class-level @EventHandler decorator ──
      const handlerMetadata = getEventHandlerMetadata(instance);

      if (handlerMetadata && isEventHandler(instance)) {
        try {
          await this.eventBus.subscribe(handlerMetadata.eventName, instance);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.logger.error(
            `Failed to register class-level handler for ${handlerMetadata.eventName}: ${error.message}`,
          );
          failures.push({ subject: handlerMetadata.eventName, error });
        }
      }

      // ── Method-level @SubscribeTo decorators ──
      const prototype: unknown = Object.getPrototypeOf(instance);
      if (!isRecord(prototype)) {
        continue;
      }

      for (const methodKey of this.metadataScanner.getAllMethodNames(prototype)) {
        const subscriptionMetadata = getSubscriptionMetadata(instance, methodKey);
        const method = instance[methodKey];

        if (subscriptionMetadata && typeof method === 'function') {
          const handler: IEventHandler = {
            handle: async (event: IEvent): Promise<void> => {
              const result: unknown = Reflect.apply(method, instance, [event]);
              await Promise.resolve(result);
            },
            getEventType: () => subscriptionMetadata.topic,
          };

          // IMPORTANT: fail-closed — await subscription registration so module
          // init fails if any subscription cannot be established.  Previously
          // fire-and-forget allowed services to boot with missing subscriptions.
          try {
            await this.eventBus.subscribeTo(subscriptionMetadata.topic, handler, {
              groupId: subscriptionMetadata.groupId,
              durable: subscriptionMetadata.durable,
            });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger.error(
              `Failed to register @SubscribeTo(${subscriptionMetadata.topic}) on ${instance.constructor.name}.${methodKey}: ${error.message}`,
            );
            failures.push({ subject: subscriptionMetadata.topic, error });
          }
        }
      }
    }

    // IMPORTANT: fail-closed — surface ALL registration failures as a single
    // boot-time error so operators see the complete list of broken subscriptions.
    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  - ${f.subject}: ${f.error.message}`)
        .join('\n');
      throw new Error(
        `EventHandlerRegistryModule failed to register ${failures.length} subscription(s):\n${summary}`,
      );
    }
  }
}
