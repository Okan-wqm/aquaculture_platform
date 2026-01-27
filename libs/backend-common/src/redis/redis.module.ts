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
    const redisServiceProvider: Provider = {
      provide: RedisService,
      useFactory: () => new RedisService(options),
    };

    return {
      module: RedisModule,
      providers: [redisServiceProvider],
      exports: [RedisService],
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
