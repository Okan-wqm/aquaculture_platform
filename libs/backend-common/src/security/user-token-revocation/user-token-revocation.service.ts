import { Inject, Injectable, Logger } from '@nestjs/common';

import { RedisService, type UserInvalidationRedisKey } from '../../redis/redis.service';
import { MAX_USER_TOKEN_LIFETIME_SECONDS } from '../security-constants';

/** Canonical logical key for a user's access-token invalidation epoch. */
export function userBlacklistKey(userId: string): UserInvalidationRedisKey {
  return `user_blacklist:${userId}`;
}

export function userInvalidationEpochFromDate(value: Date): number {
  const epochSeconds = Math.floor(value.getTime() / 1000);
  if (!Number.isSafeInteger(epochSeconds) || epochSeconds <= 0) {
    throw new RangeError('Invalidation time must be a valid positive date');
  }
  return epochSeconds;
}

/** DI token for the canonical user-token-revocation primitive. */
export const USER_TOKEN_REVOCATION = Symbol('USER_TOKEN_REVOCATION');

export interface UserTokenRevocationRedisStore {
  setAuthorizationMaxSafeInteger(
    key: UserInvalidationRedisKey,
    value: number,
    ttlSeconds: number,
  ): Promise<number>;
  getAuthorization(key: UserInvalidationRedisKey): Promise<string | null>;
}

export interface IUserTokenRevocation {
  revokeUserTokens(userId: string, at?: Date): Promise<void>;
  isTokenValid(userId: string, issuedAt: Date): Promise<boolean>;
}

/** Distributed, max-only user-family access-token invalidation. */
@Injectable()
export class UserTokenRevocationService implements IUserTokenRevocation {
  private readonly logger = new Logger(UserTokenRevocationService.name);
  private static readonly TTL_SECONDS = MAX_USER_TOKEN_LIFETIME_SECONDS;

  constructor(
    @Inject(RedisService)
    private readonly redis: UserTokenRevocationRedisStore,
  ) {}

  async revokeUserTokens(userId: string, at: Date = new Date()): Promise<void> {
    const epochSeconds = userInvalidationEpochFromDate(at);
    const retainedEpoch = await this.redis.setAuthorizationMaxSafeInteger(
      userBlacklistKey(userId),
      epochSeconds,
      UserTokenRevocationService.TTL_SECONDS,
    );
    this.logger.log(
      JSON.stringify({
        event: 'user_token_family_revoked',
        invalidatedAt: retainedEpoch,
      }),
    );
  }

  async isTokenValid(userId: string, issuedAt: Date): Promise<boolean> {
    const issuedAtSeconds = userInvalidationEpochFromDate(issuedAt);
    const raw = await this.redis.getAuthorization(userBlacklistKey(userId));
    if (raw === null) {
      return true;
    }
    if (!/^[1-9][0-9]*$/.test(raw)) {
      return false;
    }
    const invalidatedAt = Number(raw);
    if (!Number.isSafeInteger(invalidatedAt) || invalidatedAt <= 0) {
      return false;
    }
    // A token minted in the same second as the marker is conservatively
    // considered part of the revoked family. Only a strictly newer token wins.
    return issuedAtSeconds > invalidatedAt;
  }
}
