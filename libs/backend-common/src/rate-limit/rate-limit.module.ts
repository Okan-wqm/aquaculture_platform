import { DynamicModule, Logger, Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RedisService } from '../redis/redis.service';

import { RateLimitGuard } from './rate-limit.guard';
import { RATE_LIMIT_EDGE_CONFIG, RATE_LIMIT_STORE, RateLimitEdgeConfig } from './rate-limit.types';
import { RedisRateLimitStore } from './redis-rate-limit.store';

export interface RateLimitModuleOptions {
  /**
   * Key namespace inside the consuming service's Redis keyspace.
   * The service-level keyPrefix (e.g. 'auth:') still applies underneath.
   */
  keyPrefix?: string;
  /**
   * OPTIONAL config-driven edge policy (gateway only). When provided, the
   * guard limits non-decorated requests by named tiers (see RateLimitEdgeConfig).
   * Supply a value, or a factory that derives it from ConfigService env vars.
   * When a FACTORY is given, ConfigService must be resolvable in the consuming
   * injector — i.e. ConfigModule.forRoot({ isGlobal: true }) (the gateway sets
   * this). Decorator-only consumers (auth-service, every subgraph) omit this, so
   * the edge token is never created and the guard's edge branch is unreachable —
   * their behavior is structurally unchanged.
   */
  edge?: RateLimitEdgeConfig | ((config: ConfigService) => RateLimitEdgeConfig);
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

    const providers: Provider[] = [storeProvider, RateLimitGuard];
    const exports: (string | typeof RateLimitGuard)[] = [RATE_LIMIT_STORE, RateLimitGuard];

    if (options.edge !== undefined) {
      const edge = options.edge;
      providers.push(
        typeof edge === 'function'
          ? { provide: RATE_LIMIT_EDGE_CONFIG, useFactory: edge, inject: [ConfigService] }
          : { provide: RATE_LIMIT_EDGE_CONFIG, useValue: edge },
      );
      exports.push(RATE_LIMIT_EDGE_CONFIG);
    }

    return {
      module: RateLimitModule,
      providers,
      exports,
    };
  }
}
