import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { Observable } from 'rxjs';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis.provider';
import { MessagingMetricsService } from '../../metrics/messaging-metrics.service';

/**
 * Supported rate-limited action types and their default limits.
 */
export interface RateLimitRule {
  /** Maximum number of requests in the window. */
  limit: number;
  /** Sliding window size in seconds. */
  windowSeconds: number;
}

/**
 * Comprehensive rate-limit rules for ALL write mutations.
 * Each action has a sliding window limit to prevent abuse without
 * impacting legitimate usage patterns.
 */
const DEFAULT_RULES: Record<string, RateLimitRule> = {
  sendMessage: { limit: 30, windowSeconds: 60 },
  editMessage: { limit: 20, windowSeconds: 60 },
  deleteMessage: { limit: 10, windowSeconds: 60 },
  forwardMessage: { limit: 15, windowSeconds: 60 },
  uploadMedia: { limit: 10, windowSeconds: 60 },
  createChannel: { limit: 5, windowSeconds: 3600 },
  addMember: { limit: 20, windowSeconds: 60 },
  pinMessage: { limit: 10, windowSeconds: 60 },
  unpinMessage: { limit: 10, windowSeconds: 60 },
  addReaction: { limit: 30, windowSeconds: 60 },
  removeReaction: { limit: 30, windowSeconds: 60 },
  anonymizeMyData: { limit: 3, windowSeconds: 3600 },
};

export const RATE_LIMIT_ACTION_KEY = 'messaging_rate_limit_action';

/**
 * Decorator to mark a handler with a messaging rate-limit action.
 * @param action — one of the keys in DEFAULT_RULES
 */
export const MessagingRateLimit = (action: string): ReturnType<typeof SetMetadata> =>
  SetMetadata(RATE_LIMIT_ACTION_KEY, action);

interface RequestWithUser {
  user?: { sub: string; tenantId?: string | null };
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Redis sliding-window rate limiter for messaging operations.
 *
 * Uses Redis sorted sets with timestamps as scores for a true
 * sliding window (no burst-at-boundary problem). The MULTI/EXEC
 * pipeline ensures atomicity.
 *
 * **Graceful degradation**: if Redis is unreachable the request is
 * allowed through (fail-open) because rate limiting should never
 * block legitimate users when infrastructure is degraded.
 */
@Injectable()
export class MessagingRateLimitInterceptor implements NestInterceptor {
  private readonly logger = new Logger(MessagingRateLimitInterceptor.name);

  constructor(
    @Inject(REDIS_CLIENT)
    private readonly redis: Redis,
    private readonly reflector: Reflector,
    private readonly metricsService: MessagingMetricsService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const action = this.reflector.getAllAndOverride<string | undefined>(
      RATE_LIMIT_ACTION_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!action) {
      return next.handle();
    }

    const rule = DEFAULT_RULES[action];
    if (!rule) {
      return next.handle();
    }

    const request = this.getRequest(context);
    const userId = request.user?.sub;
    const tenantId = request.user?.tenantId;

    if (!userId || !tenantId) {
      return next.handle();
    }

    try {
      const allowed = await this.checkSlidingWindow(tenantId, action, userId, rule);
      if (!allowed) {
        this.metricsService.incrementRateLimitHits(action);
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `Rate limit exceeded for ${action}. Max ${rule.limit} requests per ${rule.windowSeconds}s.`,
            retryAfter: rule.windowSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    } catch (err) {
      if (err instanceof HttpException) {
        throw err;
      }
      // Fail-open: allow the request if Redis is down
      this.logger.warn(`Rate limit check failed (allowing request): ${(err as Error).message}`);
    }

    return next.handle();
  }

  /**
   * Sliding window implementation using Redis sorted sets.
   *
   * Key pattern: `msg:{tenantId}:rate:{action}:{userId}`
   * Score = timestamp in ms, Member = unique request ID (timestamp + random).
   *
   * Pipeline:
   * 1. ZREMRANGEBYSCORE — remove entries outside the window
   * 2. ZCARD — count remaining entries
   * 3. ZADD — add current request
   * 4. EXPIRE — set TTL for auto-cleanup
   */
  private async checkSlidingWindow(
    tenantId: string,
    action: string,
    userId: string,
    rule: RateLimitRule,
  ): Promise<boolean> {
    const key = `msg:${tenantId}:rate:${action}:${userId}`;
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;
    /** SEC-L04: Use crypto.randomBytes for rate limit member IDs.
     *  Predictable member IDs could allow rate limit bypass through collision. */
    const member = `${now}:${crypto.randomBytes(6).toString('hex')}`;

    const pipeline = this.redis.multi();
    pipeline.zremrangebyscore(key, '-inf', windowStart.toString());
    pipeline.zcard(key);
    pipeline.zadd(key, now.toString(), member);
    pipeline.expire(key, rule.windowSeconds + 1);

    const results = await pipeline.exec();
    if (!results) return true;

    // results[1] is the ZCARD result: [error, count]
    const zcardResult = results[1];
    if (!zcardResult || zcardResult[0]) return true;

    const currentCount = zcardResult[1] as number;
    return currentCount < rule.limit;
  }

  private getRequest(context: ExecutionContext): RequestWithUser {
    const contextType = context.getType<string>();

    if (contextType === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      return gqlCtx.getContext().req as RequestWithUser;
    }

    return context.switchToHttp().getRequest<RequestWithUser>();
  }
}
