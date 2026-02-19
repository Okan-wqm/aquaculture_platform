import { Module, DynamicModule, Global, Provider, Type, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import { RedisService, RedisModuleOptions } from './redis.service';

export const REDIS_OPTIONS = 'REDIS_OPTIONS';

/**
 * Async options for Redis module configuration
 * Note: useFactory uses 'never[]' with spread to allow typed parameters at call sites
 * while maintaining compatibility with NestJS dependency injection
 */
export interface RedisModuleAsyncOptions {
  imports?: Array<Type | DynamicModule | Promise<DynamicModule>>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => Promise<RedisModuleOptions> | RedisModuleOptions;
}

/**
 * Redis Module
 * Provides Redis connection for the platform
 */
@Global()
@Module({})
export class RedisModule {
  static forRoot(options: RedisModuleOptions): DynamicModule {
    const optionsProvider: Provider = {
      provide: REDIS_OPTIONS,
      useValue: options,
    };

    const redisServiceProvider: Provider = {
      provide: RedisService,
      inject: [REDIS_OPTIONS],
      useFactory: (opts: RedisModuleOptions) => new RedisService(opts),
    };

    return {
      module: RedisModule,
      providers: [optionsProvider, redisServiceProvider],
      exports: [RedisService, REDIS_OPTIONS],
    };
  }

  static forRootAsync(options: RedisModuleAsyncOptions): DynamicModule {
    const redisServiceProvider: Provider = {
      provide: RedisService,
      inject: options.inject || [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useFactory: async (...args: any[]) => {
        const redisOptions = await options.useFactory(...args);
        return new RedisService(redisOptions);
      },
    };

    return {
      module: RedisModule,
      imports: options.imports || [],
      providers: [redisServiceProvider],
      exports: [RedisService],
    };
  }
}
