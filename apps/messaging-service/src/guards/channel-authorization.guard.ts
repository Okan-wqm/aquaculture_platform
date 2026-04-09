/**
 * @module ChannelAuthorizationGuard
 * @description Guards channel access with Redis-cached authorization checks.
 *
 * SECURITY: Validates that the requesting user is an active member of the
 * target channel before allowing the operation to proceed. Uses Redis cache
 * with 60s TTL to reduce database load on high-frequency chat operations.
 *
 * Cache invalidation occurs on:
 * - Channel member addition/removal
 * - Channel member leaving
 *
 * @see MSG-HIGH-052 (channel guard no Redis cache)
 * @see MSG-HIGH-047 (conversation queries no tenant check)
 */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Logger,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { REDIS_CLIENT } from '../shared/redis.provider';

/** Cache TTL in seconds for channel authorization lookups. */
const CACHE_TTL_SECONDS = 60;

/** Redis key prefix for channel authorization cache. */
const CACHE_KEY_PREFIX = 'msg:guard:channel:';

@Injectable()
export class ChannelAuthorizationGuard implements CanActivate {
  private readonly logger = new Logger(ChannelAuthorizationGuard.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Check if the user is authorized to access the target channel.
   * Extracts channelId from GraphQL args and tenantId from request context.
   *
   * @param context - NestJS execution context
   * @returns true if authorized, throws ForbiddenException otherwise
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const gqlContext = GqlExecutionContext.create(context);
    const args = gqlContext.getArgs();
    const req = gqlContext.getContext().req as {
      tenantId?: string;
      user?: { sub?: string };
    } | undefined;

    const channelId = this.extractChannelId(args);
    if (!channelId) {
      // No channelId in args — skip guard (not a channel-scoped operation)
      return true;
    }

    const tenantId = req?.tenantId;
    const userId = req?.user?.sub;

    if (!tenantId || !userId) {
      throw new ForbiddenException('Missing tenant or user context');
    }

    // ── Check Redis cache first ──
    const cacheKey = `${CACHE_KEY_PREFIX}${tenantId}:${channelId}:${userId}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached === 'true') return true;
      if (cached === 'false') {
        throw new ForbiddenException(
          `User ${userId} is not authorized for channel ${channelId}`,
        );
      }
    } catch (err) {
      if (err instanceof ForbiddenException) throw err;
      this.logger.warn(`Redis cache check failed: ${(err as Error).message}`);
    }

    // ── DB lookup: verify active membership with tenant check ──
    // SECURITY: Include tenantId in WHERE to prevent cross-tenant access
    // @see MSG-HIGH-047 (conversation queries no tenant check)
    const membership: Array<{ id: string }> = await this.dataSource.query(
      `SELECT cm."id"
       FROM "channel_members" cm
       INNER JOIN "channels" c ON c."id" = cm."channelId"
       WHERE cm."channelId" = $1
         AND cm."userId" = $2
         AND c."tenantId" = $3
         AND cm."leftAt" IS NULL
       LIMIT 1`,
      [channelId, userId, tenantId],
    );

    const authorized = membership.length > 0;

    // ── Cache result in Redis ──
    try {
      await this.redis.set(cacheKey, String(authorized), 'EX', CACHE_TTL_SECONDS);
    } catch (err) {
      this.logger.warn(`Redis cache set failed: ${(err as Error).message}`);
    }

    if (!authorized) {
      throw new ForbiddenException(
        `User ${userId} is not authorized for channel ${channelId}`,
      );
    }

    return true;
  }

  /**
   * Invalidate the channel authorization cache for a specific user+channel.
   * Called by command handlers when membership changes.
   *
   * @param tenantId - Tenant identifier
   * @param channelId - Channel identifier
   * @param userId - User whose cache should be invalidated
   */
  async invalidateCache(
    tenantId: string,
    channelId: string,
    userId: string,
  ): Promise<void> {
    const cacheKey = `${CACHE_KEY_PREFIX}${tenantId}:${channelId}:${userId}`;
    try {
      await this.redis.del(cacheKey);
    } catch (err) {
      this.logger.warn(`Cache invalidation failed: ${(err as Error).message}`);
    }
  }

  /**
   * Extract channelId from GraphQL arguments.
   * Checks common arg patterns: direct channelId, input.channelId.
   */
  private extractChannelId(args: Record<string, unknown>): string | undefined {
    if (typeof args['channelId'] === 'string') return args['channelId'];
    if (args['input'] && typeof args['input'] === 'object') {
      const input = args['input'] as Record<string, unknown>;
      if (typeof input['channelId'] === 'string') return input['channelId'];
    }
    return undefined;
  }
}
