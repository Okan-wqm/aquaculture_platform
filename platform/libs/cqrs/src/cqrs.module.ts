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
import { ICommandHandler } from './command/command.interface';
import { IQueryHandler } from './query/query.interface';

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

      // Register command handlers
      const commandMetadata = Reflect.getMetadata(
        COMMAND_HANDLER_METADATA,
        metatype,
      );

      if (commandMetadata) {
        this.commandBus.registerByName(
          commandMetadata.commandName,
          metatype as Type<ICommandHandler>,
        );
      }

      // Register query handlers
      const queryMetadata = Reflect.getMetadata(
        QUERY_HANDLER_METADATA,
        metatype,
      );

      if (queryMetadata) {
        this.queryBus.registerByName(
          queryMetadata.queryName,
          metatype as Type<IQueryHandler>,
        );
      }
    }
  }
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
