import { DynamicModule, Logger, Module, Provider } from '@nestjs/common';

import { RedisService } from '../redis/redis.service';
import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_STORE } from './rate-limit.types';
import { RedisRateLimitStore } from './redis-rate-limit.store';

export interface RateLimitModuleOptions {
  /**
   * Key namespace inside the consuming service's Redis keyspace.
   * The service-level keyPrefix (e.g. 'auth:') still applies underneath.
   */
  keyPrefix?: string;
}

/**
 * Wires the distributed rate-limit store on top of the consuming service's
 * RedisModule. Import AFTER RedisModule.forRootAsync so RedisService is
 * resolvable; the guard itself is registered by the consumer (usually as an
 * APP_GUARD ordered before authentication, so pre-auth endpoints are
 * limited too).
 */
@Module({})
export class RateLimitModule {
  static forRoot(options: RateLimitModuleOptions = {}): DynamicModule {
    const storeProvider: Provider = {
      provide: RATE_LIMIT_STORE,
      useFactory: (redisService?: RedisService) => {
        if (!redisService) {
          // WHY loud: per-process counters multiply every limit by the
          // replica count — acceptable in dev, a misconfiguration in prod.
          new Logger(RateLimitModule.name).warn(
            'RedisService not available — rate limiting will use the per-process in-memory fallback.',
          );
          return undefined;
        }
        return new RedisRateLimitStore(redisService, options.keyPrefix ?? 'ratelimit:');
      },
      inject: [{ token: RedisService, optional: true }],
    };

    return {
      module: RateLimitModule,
      providers: [storeProvider, RateLimitGuard],
      exports: [RATE_LIMIT_STORE, RateLimitGuard],
    };
  }
}
