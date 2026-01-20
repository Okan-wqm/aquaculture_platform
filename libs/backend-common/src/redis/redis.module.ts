import { Module, DynamicModule, Global, Provider } from '@nestjs/common';
import { RedisService, RedisModuleOptions } from './redis.service';

export const REDIS_OPTIONS = 'REDIS_OPTIONS';

export interface RedisModuleAsyncOptions {
  imports?: any[];
  inject?: any[];
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
