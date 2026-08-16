import { DynamicModule, Logger, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';

import { RedisService } from '../redis/redis.service';

import { RateLimitEnforcementService } from './rate-limit-enforcement.service';
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
            'RedisService not available — required/production rate limits will fail closed; only optional non-production policies may use local state.',
          );
          return undefined;
        }
        return new RedisRateLimitStore(redisService, options.keyPrefix ?? 'ratelimit:');
      },
      inject: [{ token: RedisService, optional: true }],
    };

    const enforcementProvider: Provider = {
      provide: RateLimitEnforcementService,
      useFactory: (configService: ConfigService, store?: RedisRateLimitStore) =>
        new RateLimitEnforcementService(configService, store),
      inject: [ConfigService, { token: RATE_LIMIT_STORE, optional: true }],
    };
    const guardProvider: Provider = {
      provide: RateLimitGuard,
      useFactory: (
        reflector: Reflector,
        enforcement: RateLimitEnforcementService,
        edge?: RateLimitEdgeConfig,
      ) => new RateLimitGuard(reflector, enforcement, edge),
      inject: [
        Reflector,
        RateLimitEnforcementService,
        { token: RATE_LIMIT_EDGE_CONFIG, optional: true },
      ],
    };

    const providers: Provider[] = [storeProvider, enforcementProvider, guardProvider];
    const exports: Array<string | typeof RateLimitGuard | typeof RateLimitEnforcementService> = [
      RATE_LIMIT_STORE,
      RateLimitEnforcementService,
      RateLimitGuard,
    ];

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
      imports: [ConfigModule],
      providers,
      exports,
    };
  }
}
