import { Injectable, Logger } from '@nestjs/common';

/**
 * Token Revocation Service
 *
 * Provides a global token revocation mechanism via an `iat_minimum` threshold.
 * When the threshold is set, all tokens whose `iat` (issued-at) claim is
 * earlier than the threshold are rejected — regardless of whether the token
 * carries a `jti` claim.
 *
 * This is the architectural solution for legacy tokens that lack `jti` and
 * therefore cannot be individually blacklisted. In the event of a credential
 * compromise, an administrator sets the threshold to `Date.now() / 1000` to
 * invalidate every token issued before that moment.
 *
 * Persistence strategy:
 *   - In-memory by default (single instance).
 *   - For multi-instance deployments, inject a Redis-backed adapter to share
 *     the threshold across all gateway replicas (see TODO below).
 *
 * Integration point:
 *   Auth guards call `isTokenValid(payload.iat)` during the validation step.
 *   The admin controller exposes:
 *     POST /admin/security/revoke-all-before?timestamp=<epoch>
 *
 * @example
 * ```typescript
 * // Guard integration:
 * if (!tokenRevocationService.isTokenValid(payload.iat)) {
 *   throw new UnauthorizedException('Token has been globally revoked');
 * }
 *
 * // Admin controller:
 * tokenRevocationService.revokeAllBefore(Math.floor(Date.now() / 1000));
 * ```
 */
@Injectable()
export class TokenRevocationService {
  private readonly logger = new Logger(TokenRevocationService.name);

  /**
   * Epoch seconds. Tokens with `iat` below this value are rejected.
   * A value of 0 means no global revocation is active.
   */
  private iatMinimum = 0;

  /**
   * Check whether a token's `iat` is at or above the global minimum.
   *
   * @param iat - The `iat` claim from the JWT payload (epoch seconds).
   * @returns `true` if the token is valid (not globally revoked), `false` otherwise.
   */
  isTokenValid(iat: number): boolean {
    if (this.iatMinimum === 0) {
      return true;
    }
    return iat >= this.iatMinimum;
  }

  /**
   * Set the global revocation threshold.
   *
   * All tokens issued before `timestamp` will be rejected by `isTokenValid()`.
   * This is an administrative action and should be restricted to SUPER_ADMIN.
   *
   * @param timestamp - Epoch seconds. Must be a positive integer.
   */
  revokeAllBefore(timestamp: number): void {
    this.logger.warn(
      `Global token revocation set: all tokens issued before ${new Date(timestamp * 1000).toISOString()} will be rejected`,
    );
    this.iatMinimum = timestamp;
    // TODO: Persist to Redis for cross-instance consistency
    //   await this.redis.set('token:iat_minimum', timestamp.toString());
  }

  /**
   * Return the current iat_minimum threshold (epoch seconds).
   * Returns 0 when no global revocation is active.
   */
  getIatMinimum(): number {
    return this.iatMinimum;
  }
}
