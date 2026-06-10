import {
  Module,
  Global,
  OnModuleInit,
  DynamicModule,
  Provider,
  Type,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { CommandBus } from './command/command-bus';
import { QueryBus } from './query/query-bus';
import { COMMAND_HANDLER_METADATA } from './decorators/command-handler.decorator';
import { QUERY_HANDLER_METADATA } from './decorators/query-handler.decorator';
import { ICommand, ICommandHandler } from './command/command.interface';
import { IQuery, IQueryHandler } from './query/query.interface';

/**
 * CQRS Module - Provides Command and Query buses
 * Auto-discovers and registers handlers using decorators
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [CommandBus, QueryBus],
  exports: [CommandBus, QueryBus],
})
export class CqrsModule implements OnModuleInit {
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  /**
   * Register with custom handlers
   */
  static forRoot(options?: CqrsModuleOptions): DynamicModule {
    const providers: Provider[] = [CommandBus, QueryBus];

    return {
      module: CqrsModule,
      imports: [DiscoveryModule],
      providers,
      exports: [CommandBus, QueryBus],
    };
  }

  /**
   * Register for a specific feature module
   */
  static forFeature(handlers: Type<ICommandHandler | IQueryHandler>[] = []): DynamicModule {
    return {
      module: CqrsModule,
      providers: handlers,
    };
  }

  /**
   * Auto-discover and register handlers on module init
   */
  onModuleInit(): void {
    this.registerHandlers();
  }

  /**
   * Discover and register all command and query handlers
   */
  private registerHandlers(): void {
    const providers = this.discovery.getProviders();

    for (const wrapper of providers) {
      const { instance, metatype } = wrapper;

      if (!instance || !metatype) {
        continue;
      }

      // Register command handlers.
      // Reflect.getMetadata is an `any` trust boundary — the decorator
      // wrote the payload, but a foreign decorator could collide on the
      // metadata key, so the shape is validated before registration.
      const commandMetadata: unknown = Reflect.getMetadata(
        COMMAND_HANDLER_METADATA,
        metatype,
      );

      if (hasConstructorProperty(commandMetadata, 'command')) {
        this.commandBus.register(
          commandMetadata.command as Type<ICommand>,
          metatype as Type<ICommandHandler>,
        );
      }

      // Register query handlers
      const queryMetadata: unknown = Reflect.getMetadata(
        QUERY_HANDLER_METADATA,
        metatype,
      );

      if (hasConstructorProperty(queryMetadata, 'query')) {
        this.queryBus.register(
          queryMetadata.query as Type<IQuery>,
          metatype as Type<IQueryHandler>,
        );
      }
    }
  }
}

/**
 * Narrow decorator metadata to `{ [key]: constructor }` before handler
 * registration — keeps the Reflect.getMetadata any-boundary out of the
 * bus registration call sites.
 */
function hasConstructorProperty<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, new (...args: never[]) => unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[key] === 'function'
  );
}

/**
 * CQRS Module Options
 */
export interface CqrsModuleOptions {
  /**
   * Enable command/query logging
   */
  enableLogging?: boolean;

  /**
   * Enable metrics collection
   */
  enableMetrics?: boolean;
}
