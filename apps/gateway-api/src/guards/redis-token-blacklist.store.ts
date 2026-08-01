import type { AuthorizationRedisKey, RedisScopedKey } from '@aquaculture/backend-common/redis';
import { tokenBlacklistKey, userBlacklistKey } from '@aquaculture/backend-common/security';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Gateway is a read-only enforcement point for auth-owned revocation markers.
 * This capability stays distinct from auth's writer-only TOKEN_BLACKLIST token;
 * both use the shared typed key builders and authorization Redis namespace.
 */
export interface TokenBlacklistStore {
  isBlacklisted(jti: string): Promise<boolean>;
  isValidToken(jti: string, userId: string, issuedAt: number): Promise<boolean>;
}

export interface GatewayAuthorizationRedisClient {
  getAuthorization(key: AuthorizationRedisKey): Promise<string | null>;
  mgetScoped(...keys: RedisScopedKey[]): Promise<(string | null)[]>;
}

@Injectable()
export class RedisTokenBlacklistStore implements TokenBlacklistStore {
  private readonly logger = new Logger(RedisTokenBlacklistStore.name);

  constructor(private readonly redis: GatewayAuthorizationRedisClient) {}

  async isBlacklisted(jti: string): Promise<boolean> {
    if (jti.trim().length === 0) {
      return true;
    }
    try {
      return (await this.redis.getAuthorization(tokenBlacklistKey(jti))) !== null;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'gateway_jti_revocation_check_failed',
          errorType: this.errorType(error),
        }),
      );
      return true;
    }
  }

  async isValidToken(jti: string, userId: string, issuedAt: number): Promise<boolean> {
    if (
      jti.trim().length === 0 ||
      userId.trim().length === 0 ||
      !Number.isSafeInteger(issuedAt) ||
      issuedAt <= 0
    ) {
      return false;
    }

    try {
      const values = await this.redis.mgetScoped(
        { scope: 'authorization', key: tokenBlacklistKey(jti) },
        { scope: 'authorization', key: userBlacklistKey(userId) },
      );
      if (values.length !== 2) {
        return false;
      }
      const [jtiMarker, userEpoch] = values;
      if (jtiMarker !== null) {
        return false;
      }
      if (userEpoch === null) {
        return true;
      }
      if (typeof userEpoch !== 'string') {
        return false;
      }
      if (!/^[1-9][0-9]*$/.test(userEpoch)) {
        return false;
      }
      const invalidatedAt = Number(userEpoch);
      if (!Number.isSafeInteger(invalidatedAt) || invalidatedAt <= 0) {
        return false;
      }
      // Same-second issuance cannot be ordered reliably against the revocation
      // event, so fail closed. Only a strictly newer token is accepted.
      return issuedAt > invalidatedAt;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: 'gateway_composite_token_validity_check_failed',
          errorType: this.errorType(error),
        }),
      );
      return false;
    }
  }

  private errorType(error: unknown): string {
    return error instanceof Error ? error.name : 'UnknownError';
  }
}

/**
 * Explicit non-production bypass used only when revocation enforcement is
 * deliberately disabled by configuration. It stores no divergent local state.
 */
@Injectable()
export class InMemoryTokenBlacklistStore implements TokenBlacklistStore {
  isBlacklisted(_jti: string): Promise<boolean> {
    return Promise.resolve(false);
  }

  isValidToken(_jti: string, _userId: string, _issuedAt: number): Promise<boolean> {
    return Promise.resolve(true);
  }
}

export function buildGatewayTokenBlacklistStore(
  redis: GatewayAuthorizationRedisClient,
  nodeEnv: string | undefined,
  configured: string | boolean | undefined,
): TokenBlacklistStore {
  let enabled: boolean;
  if (configured === undefined) {
    enabled = true;
  } else if (typeof configured === 'boolean') {
    enabled = configured;
  } else if (configured === 'true') {
    enabled = true;
  } else if (configured === 'false') {
    enabled = false;
  } else {
    throw new Error('TOKEN_BLACKLIST_USE_REDIS must be true or false');
  }

  if (!enabled) {
    if (nodeEnv === 'production') {
      throw new Error('Distributed token revocation cannot be disabled in production');
    }
    return new InMemoryTokenBlacklistStore();
  }
  return new RedisTokenBlacklistStore(redis);
}

/** Read-only gateway capability; deliberately not the auth writer DI token. */
export const TOKEN_BLACKLIST_STORE = Symbol('TOKEN_BLACKLIST_STORE');
