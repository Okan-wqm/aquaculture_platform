import { Injectable, Logger, OnModuleDestroy, Optional, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { InMemoryRateLimitStore } from './in-memory-rate-limit.store';
import {
  RATE_LIMIT_STORE,
  RateLimitEntry,
  RateLimitIdentity,
  RateLimitRouteConfig,
  RateLimitStore,
} from './rate-limit.types';

export interface RateLimitEvaluation {
  key: string;
  entry: RateLimitEntry;
  allowed: boolean;
}

/** Raised when a route requiring shared state cannot reach that authority. */
export class RateLimitAuthorityUnavailableError extends Error {
  constructor(bucketName: string) {
    super(`Distributed rate-limit authority unavailable for '${bucketName}'`);
    this.name = RateLimitAuthorityUnavailableError.name;
  }
}

/**
 * Canonical rate-limit execution engine.
 *
 * Both transport guards and pre-auth authentication boundaries consume this
 * service, so key construction, atomic-store selection, and fail-closed policy
 * have one owner. The in-memory store exists only for non-production routes
 * that do not require distributed state; production never falls back.
 */
@Injectable()
export class RateLimitEnforcementService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitEnforcementService.name);
  private readonly fallbackStore = new InMemoryRateLimitStore();
  private readonly isProduction: boolean;

  constructor(
    private readonly configService: ConfigService,
    @Optional()
    @Inject(RATE_LIMIT_STORE)
    private readonly distributedStore?: RateLimitStore,
  ) {
    this.isProduction = this.configService.get<string>('NODE_ENV') === 'production';
  }

  async evaluate(
    config: RateLimitRouteConfig,
    identity: RateLimitIdentity,
  ): Promise<RateLimitEvaluation> {
    this.assertValidConfig(config);
    const key = this.buildKey(config, identity);
    const entry = await this.increment(config, key);
    return { key, entry, allowed: entry.count <= config.limit };
  }

  onModuleDestroy(): void {
    this.fallbackStore.destroy();
  }

  private async increment(config: RateLimitRouteConfig, key: string): Promise<RateLimitEntry> {
    if (!this.distributedStore) {
      return this.fallbackOrThrow(config, key);
    }

    try {
      // Always attempt the distributed operation, even after a prior failure:
      // RedisRateLimitStore marks itself healthy again on recovery.
      return (await this.distributedStore.incrementOrCreate(key, config.windowMs)).entry;
    } catch (error) {
      if (this.requiresDistributed(config)) {
        this.logger.error(
          `Rate-limit store unavailable for '${config.name}': ${(error as Error).message}`,
        );
        throw new RateLimitAuthorityUnavailableError(config.name);
      }
      this.logger.warn(
        `Rate-limit store unavailable outside production; using local test/development state for '${config.name}'`,
      );
      return (await this.fallbackStore.incrementOrCreate(key, config.windowMs)).entry;
    }
  }

  private async fallbackOrThrow(
    config: RateLimitRouteConfig,
    key: string,
  ): Promise<RateLimitEntry> {
    if (this.requiresDistributed(config)) {
      this.logger.error(`No distributed rate-limit store is wired for '${config.name}'`);
      throw new RateLimitAuthorityUnavailableError(config.name);
    }
    return (await this.fallbackStore.incrementOrCreate(key, config.windowMs)).entry;
  }

  private requiresDistributed(config: RateLimitRouteConfig): boolean {
    return this.isProduction || config.requiresDistributedStore === true;
  }

  private buildKey(config: RateLimitRouteConfig, identity: RateLimitIdentity): string {
    const custom = config.identifier?.(identity);
    if (custom) {
      return `${config.name}:id:${custom}`;
    }
    if (identity.userId) {
      return `${config.name}:user:${identity.userId}`;
    }
    if (identity.tenantId && identity.ip) {
      return `${config.name}:tenant:${identity.tenantId}:${identity.ip}`;
    }
    return `${config.name}:ip:${identity.ip ?? 'unknown'}`;
  }

  private assertValidConfig(config: RateLimitRouteConfig): void {
    if (config.name.trim().length === 0) {
      throw new RangeError('Rate-limit bucket name is required');
    }
    if (!Number.isSafeInteger(config.limit) || config.limit <= 0) {
      throw new RangeError(`Rate-limit '${config.name}' limit must be a positive integer`);
    }
    if (!Number.isSafeInteger(config.windowMs) || config.windowMs <= 0) {
      throw new RangeError(`Rate-limit '${config.name}' windowMs must be a positive integer`);
    }
  }
}
