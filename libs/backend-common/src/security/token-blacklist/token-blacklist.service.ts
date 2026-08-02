import { Inject, Injectable, Logger } from '@nestjs/common';

import { RedisService, type RevokedTokenRedisKey } from '../../redis/redis.service';
import { ITokenBlacklist } from '../interfaces';

const TOKEN_BLACKLIST_KEY_PREFIX = 'token:blacklist:';
const TOKEN_BLACKLIST_SENTINEL = '1';

/** Canonical logical Redis key for one revoked access-token JTI. */
export function tokenBlacklistKey(jti: string): RevokedTokenRedisKey {
  return `${TOKEN_BLACKLIST_KEY_PREFIX}${jti}`;
}

/** Minimal Redis surface required by the auth-owned per-JTI revocation writer. */
export interface TokenBlacklistRedisStore {
  setAuthorization(key: RevokedTokenRedisKey, value: string, ttlSeconds?: number): Promise<void>;
  getAuthorization(key: RevokedTokenRedisKey): Promise<string | null>;
}

/**
 * Auth-owned per-JTI access-token revocation.
 *
 * Markers always live in the explicit `auth:` authorization namespace. User
 * family invalidation is a separate USER_TOKEN_REVOCATION primitive.
 */
@Injectable()
export class TokenBlacklistService implements ITokenBlacklist {
  private readonly logger = new Logger(TokenBlacklistService.name);

  constructor(
    @Inject(RedisService)
    private readonly redis: TokenBlacklistRedisStore,
  ) {}

  async add(jti: string, expiresAt: Date, reason?: string): Promise<void> {
    if (jti.trim().length === 0) {
      throw new RangeError('Token JTI is required for revocation');
    }

    const expiresAtMs = expiresAt.getTime();
    if (!Number.isFinite(expiresAtMs)) {
      throw new RangeError('Token expiry must be a valid date');
    }

    const ttlSeconds = Math.ceil((expiresAtMs - Date.now()) / 1000);
    if (ttlSeconds <= 0) {
      return;
    }

    await this.redis.setAuthorization(tokenBlacklistKey(jti), TOKEN_BLACKLIST_SENTINEL, ttlSeconds);
    this.logger.log(
      JSON.stringify({
        event: 'access_token_revoked',
        reason: reason ?? 'unspecified',
        ttlSeconds,
      }),
    );
  }

  async isBlacklisted(jti: string): Promise<boolean> {
    if (jti.trim().length === 0) {
      throw new RangeError('Token JTI is required for revocation lookup');
    }
    return (await this.redis.getAuthorization(tokenBlacklistKey(jti))) !== null;
  }
}
