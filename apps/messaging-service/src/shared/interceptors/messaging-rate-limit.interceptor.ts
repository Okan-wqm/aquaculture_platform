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
 * Per-action fail-mode discriminator (CIRCUIT-MEDIUM-005 cure).
 *
 * # Why two modes
 *
 * - `fail-open` — when Redis is unreachable, allow the request
 *   through. Used for read-adjacent mutations where the rate
 *   limit is a UX guard, not a billable / abuse-prevention gate.
 *   The cost of incorrectly rate-limiting a legitimate user
 *   exceeds the cost of letting one extra request through during
 *   an infrastructure outage.
 *
 * - `fail-closed` — when Redis is unreachable, BLOCK the request
 *   with HTTP 503 Service Unavailable. Used for actions that
 *   are billable (sendMessage with metering enabled) or carry
 *   abuse-amplification risk (createChannel — quota'd at 5/hour
 *   to prevent tenant-level fan-out attacks). Letting these
 *   through during an outage means an attacker can blow past
 *   limits the platform contractually owes.
 *
 * The `fail-closed` decision is the conservative one when the
 * action is BOTH billable AND quota-protected; if the action is
 * UX-protective only, fail-open wins. Each rule below documents
 * the rationale for its tier.
 *
 * # Why this is the right Tier
 *
 * Tier-1 ("make it impossible") would be a single canonical rate-
 * limiter that consults the per-action policy. The platform has
 * that already (`@aquaculture/backend-common/security`'s
 * `RateLimitGuard`); this interceptor is the messaging-service-
 * specific implementation that pre-dates the canonical lib. The
 * full migration is the SEC-MEDIUM-006 follow-on. Until then,
 * this Tier-2 (per-action discriminator) is the visible cure.
 */
export type RateLimitFailMode = 'fail-open' | 'fail-closed';

/**
 * Supported rate-limited action types and their default limits.
 */
export interface RateLimitRule {
  /** Maximum number of requests in the window. */
  limit: number;
  /** Sliding window size in seconds. */
  windowSeconds: number;
  /**
   * What to do when Redis is unreachable (CIRCUIT-MEDIUM-005).
   * Defaults to 'fail-open' for backward compatibility — every
   * rule below MUST explicitly declare its mode.
   */
  failMode: RateLimitFailMode;
}

/**
 * Comprehensive rate-limit rules for ALL write mutations.
 * Each action has a sliding window limit AND an explicit
 * fail-mode discriminator (CIRCUIT-MEDIUM-005 cure).
 *
 * Classification:
 *   - fail-CLOSED: billable + abuse-amplification surfaces.
 *   - fail-OPEN:   UX-protective surfaces.
 */
const DEFAULT_RULES: Record<string, RateLimitRule> = {
  // sendMessage — billable once messaging metering wires through
  // (BILLING-CRITICAL-003 follow-on). CIRCUIT-MEDIUM-005 escalation
  // condition: "escalates to HIGH if any of these mutations turn
  // out to be billable" — pre-emptively fail-closed so the
  // metering rollout doesn't surprise.
  sendMessage:    { limit: 30, windowSeconds: 60,   failMode: 'fail-closed' },
  // uploadMedia — costs storage + bandwidth; quota'd at 10/min
  // to prevent abuse. fail-closed.
  uploadMedia:    { limit: 10, windowSeconds: 60,   failMode: 'fail-closed' },
  // createChannel — abuse-amplification (5/hour). Letting
  // through during a Redis outage = unbounded channel creation.
  createChannel:  { limit: 5,  windowSeconds: 3600, failMode: 'fail-closed' },
  // anonymizeMyData — GDPR-Art-17 surface. Burst protection
  // matters more than UX availability.
  anonymizeMyData: { limit: 3, windowSeconds: 3600, failMode: 'fail-closed' },

  // The remaining mutations are UX-protective (preventing
  // accidental burst from a misbehaving client) and have no
  // billable / abuse-amplification character.
  editMessage:    { limit: 20, windowSeconds: 60,   failMode: 'fail-open' },
  deleteMessage:  { limit: 10, windowSeconds: 60,   failMode: 'fail-open' },
  forwardMessage: { limit: 15, windowSeconds: 60,   failMode: 'fail-open' },
  addMember:      { limit: 20, windowSeconds: 60,   failMode: 'fail-open' },
  pinMessage:     { limit: 10, windowSeconds: 60,   failMode: 'fail-open' },
  unpinMessage:   { limit: 10, windowSeconds: 60,   failMode: 'fail-open' },
  addReaction:    { limit: 30, windowSeconds: 60,   failMode: 'fail-open' },
  removeReaction: { limit: 30, windowSeconds: 60,   failMode: 'fail-open' },
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
      // CIRCUIT-MEDIUM-005 cure: per-action fail-mode discriminator.
      //
      // Pre-cure this branch was unconditional fail-open ("allow
      // the request if Redis is down"). That is correct UX behaviour
      // for read-adjacent edits + reactions but wrong for billable /
      // abuse-amplification surfaces — sendMessage / uploadMedia /
      // createChannel / anonymizeMyData each carry quotas the
      // platform contractually owes.
      if (rule.failMode === 'fail-closed') {
        this.metricsService.incrementRateLimitHits(action);
        this.logger.error(
          `Rate limit check failed for fail-CLOSED action '${action}' — ` +
            `blocking with 503: ${(err as Error).message}`,
        );
        throw new HttpException(
          {
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            message:
              `Rate limit subsystem unavailable for ${action}. ` +
              'Retry after the platform recovers.',
            retryAfter: rule.windowSeconds,
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      // fail-open path — UX-protective actions stay through during
      // infrastructure degradation.
      this.logger.warn(
        `Rate limit check failed for fail-OPEN action '${action}' ` +
          `(allowing request): ${(err as Error).message}`,
      );
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
