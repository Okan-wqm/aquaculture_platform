import { Module, DynamicModule, Global, Provider, Type, InjectionToken, OptionalFactoryDependency } from '@nestjs/common';
import { RedisService, RedisModuleOptions } from './redis.service';

export const REDIS_OPTIONS = 'REDIS_OPTIONS';

export interface RedisModuleAsyncOptions<TFactoryArgs extends unknown[] = unknown[]> {
  imports?: Array<Type | DynamicModule | Promise<DynamicModule>>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  useFactory: (...args: TFactoryArgs) => Promise<RedisModuleOptions> | RedisModuleOptions;
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

  static forRootAsync<TFactoryArgs extends unknown[] = unknown[]>(
    options: RedisModuleAsyncOptions<TFactoryArgs>,
  ): DynamicModule {
    const redisServiceProvider: Provider = {
      provide: RedisService,
      inject: options.inject || [],
      useFactory: async (...args: TFactoryArgs): Promise<RedisService> => {
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
