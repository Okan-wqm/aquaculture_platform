import { Inject, Injectable } from '@nestjs/common';

import { RedisService, type RedisScopedKey } from '../../redis/redis.service';
import { tokenBlacklistKey } from '../token-blacklist/token-blacklist.service';
import { userBlacklistKey } from '../user-token-revocation/user-token-revocation.service';

/** Read-only capability token for access-token revocation enforcement. */
export const TOKEN_REVOCATION_READER = Symbol('TOKEN_REVOCATION_READER');

export interface AccessTokenRevocationStatus {
  jtiRevoked: boolean;
  userEpochRevoked: boolean;
}

/**
 * Deliberately excludes every mutation method. Auth-service owns marker writes;
 * gateways and direct service boundaries receive only this read capability.
 */
export interface ITokenRevocationReader {
  getStatus(
    jti: string,
    userId: string,
    issuedAtSeconds: number,
  ): Promise<AccessTokenRevocationStatus>;
}

/** Minimal Redis read surface required by the enforcement capability. */
export interface TokenRevocationRedisReader {
  mgetScoped(...keys: RedisScopedKey[]): Promise<(string | null)[]>;
}

export class TokenRevocationAuthorityStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = TokenRevocationAuthorityStateError.name;
  }
}

/**
 * Canonical, read-only composite revocation authority.
 *
 * Both auth-owned marker families are read in one ordered Redis round trip so
 * an enforcement point cannot accidentally consult only one of them. Redis
 * errors deliberately propagate; malformed authority state throws explicitly
 * and must be treated as unavailable, never as an active token.
 */
@Injectable()
export class TokenRevocationReaderService implements ITokenRevocationReader {
  constructor(
    @Inject(RedisService)
    private readonly redis: TokenRevocationRedisReader,
  ) {}

  async getStatus(
    jti: string,
    userId: string,
    issuedAtSeconds: number,
  ): Promise<AccessTokenRevocationStatus> {
    this.assertCoordinates(jti, userId, issuedAtSeconds);

    const values = await this.redis.mgetScoped(
      { scope: 'authorization', key: tokenBlacklistKey(jti) },
      { scope: 'authorization', key: userBlacklistKey(userId) },
    );
    if (values.length !== 2) {
      throw new TokenRevocationAuthorityStateError(
        'Revocation authority returned an incomplete marker tuple',
      );
    }

    const jtiMarker = values[0];
    const rawUserEpoch = values[1];
    if (jtiMarker === undefined || rawUserEpoch === undefined) {
      throw new TokenRevocationAuthorityStateError(
        'Revocation authority returned an incomplete marker tuple',
      );
    }
    const invalidatedAt = this.parseUserEpoch(rawUserEpoch);
    return {
      jtiRevoked: jtiMarker !== null,
      userEpochRevoked: invalidatedAt !== undefined && issuedAtSeconds <= invalidatedAt,
    };
  }

  private assertCoordinates(jti: string, userId: string, issuedAtSeconds: number): void {
    if (jti.trim().length === 0 || userId.trim().length === 0) {
      throw new RangeError('Token revocation identity coordinates are required');
    }
    if (!Number.isSafeInteger(issuedAtSeconds) || issuedAtSeconds <= 0) {
      throw new RangeError('Token issued-at must be a positive safe integer');
    }
  }

  private parseUserEpoch(raw: string | null): number | undefined {
    if (raw === null) {
      return undefined;
    }
    if (!/^[1-9][0-9]*$/.test(raw)) {
      throw new TokenRevocationAuthorityStateError(
        'Revocation authority contains a malformed user epoch',
      );
    }
    const epoch = Number(raw);
    if (!Number.isSafeInteger(epoch) || epoch <= 0) {
      throw new TokenRevocationAuthorityStateError(
        'Revocation authority contains an out-of-range user epoch',
      );
    }
    return epoch;
  }
}
