import { Module, DynamicModule, Global, Provider, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { createDefaultRegistry } from '@platform/event-contracts';

import {
  EVENT_HANDLER_METADATA,
  EVENT_SUBSCRIPTION_METADATA,
  type EventHandlerOptions,
  type SubscribeToOptions,
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

/** Narrows a discovered provider instance to the class-level handler contract. */
function isEventHandlerInstance(instance: object): instance is IEventHandler {
  return typeof (instance as { handle?: unknown }).handle === 'function';
}

/**
 * Event Handler Registry - Auto-discovers and registers event handlers
 *
 * IMPORTANT: fail-closed — all subscription registrations are awaited.
 * If any registration fails, the entire module init fails, preventing
 * the service from booting with missing event handlers.
 *
 * # Why this module imports DiscoveryModule
 *
 * It declared `@Module({})` and injected `DiscoveryService` + `MetadataScanner`
 * in its constructor. `EventBusModule` imports `DiscoveryModule` but does not
 * re-export it, and `@Global()` publishes a module's EXPORTS, not its imports —
 * so this class could not be resolved as a module by any service, and every
 * `@SubscribeTo` in the platform went unregistered. The only thing that ever
 * exercised it was `__tests__/handler-registration.spec.ts`, which registers it
 * as a PROVIDER beside a root-imported `DiscoveryModule` and therefore proved
 * the discovery logic while hiding the wiring defect.
 *
 * Importing `DiscoveryModule` here makes the fail-closed guarantee in the
 * paragraph above real rather than aspirational: a service that imports this
 * module either binds every declared subscription or does not boot.
 */
@Global()
@Module({ imports: [DiscoveryModule] })
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
      // `wrapper.instance` is `any`; narrowing it once here keeps every use
      // below type-checked instead of propagating `any` through the loop.
      const instance: unknown = wrapper.instance;
      const metatype = wrapper.metatype;
      if (!instance || typeof instance !== 'object' || !metatype) {
        continue;
      }

      // ── Class-level @EventHandler decorator ──
      // Read through the typed accessors rather than Reflect.getMetadata, whose
      // `any` return let a misspelled option (or a dropped one — `startFrom`)
      // pass the compiler and the linter alike.
      const handlerMetadata: EventHandlerOptions | undefined = Reflect.getMetadata(
        EVENT_HANDLER_METADATA,
        metatype,
      ) as EventHandlerOptions | undefined;

      if (handlerMetadata && isEventHandlerInstance(instance)) {
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
      const prototype: object | null = Object.getPrototypeOf(instance) as object | null;
      for (const methodKey of this.metadataScanner.getAllMethodNames(prototype)) {
        const subscriptionMetadata: SubscribeToOptions | undefined = Reflect.getMetadata(
          EVENT_SUBSCRIPTION_METADATA,
          instance,
          methodKey,
        ) as SubscribeToOptions | undefined;

        const method: unknown = (instance as Record<string, unknown>)[methodKey];
        if (subscriptionMetadata && typeof method === 'function') {
          const bound = method.bind(instance) as (event: IEvent) => Promise<void>;
          const handler: IEventHandler = {
            handle: bound,
            getEventType: () => subscriptionMetadata.topic,
          };

          // IMPORTANT: fail-closed — await subscription registration so module
          // init fails if any subscription cannot be established.  Previously
          // fire-and-forget allowed services to boot with missing subscriptions.
          try {
            // `startFrom` is part of SubscribeToOptions and decides whether a
            // NEW durable consumer replays the stream from the beginning or
            // starts at the head. Dropping it silently forced every
            // subscription to the `DeliverPolicy.New` default, which is the
            // opposite of what a projection rebuilding its table asks for.
            await this.eventBus.subscribeTo(subscriptionMetadata.topic, handler, {
              groupId: subscriptionMetadata.groupId,
              durable: subscriptionMetadata.durable,
              startFrom: subscriptionMetadata.startFrom,
            });
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            this.logger.error(
              `Failed to register @SubscribeTo(${subscriptionMetadata.topic}) on ${metatype.name}.${methodKey}: ${error.message}`,
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
